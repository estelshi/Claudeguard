import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { load, dump } from 'js-yaml'
import { atomicText } from './storage.mjs'

const SOURCE_PREFIX = 'ClaudeGuard source: '
const LOCAL_TYPES = new Set(['local', 'remote'])
const UID = /^[\w-]+$/
const PROFILE_FILE = /^[\w.-]+\.ya?ml$/i
const OWNED_FILE = /^(?:L|s|m|r|p|g)cg[a-f0-9]{16}\.(?:yaml|js)$/
const PROFILE_LIMIT = 8 * 1024 * 1024

function subscriptionName(settings) {
  const ip = settings?.relay && !settings.relay.confirmed ? settings.relay.host : settings?.expectedIP
  if (isIP(ip || '') !== 4)
    throw new Error('订阅名称需要出口 IPv4。请填写 SOCKS5 的 IPv4 地址，或先用手动导入确认实际出口。')
  return `ClaudeGuard（${ip}）`
}

async function readRegularFile(path, label) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') throw new Error(`${label}不存在。`)
    throw error
  })
  if (!info.isFile() || info.size > PROFILE_LIMIT) throw new Error(`${label}格式或大小异常。`)
  return readFile(path, 'utf8')
}

function readIndex(text) {
  let value
  try { value = load(text) } catch { throw new Error('Clash Verge 的订阅列表无法解析，导入已停止。') }
  if (!Array.isArray(value?.items) || typeof value?.current !== 'string')
    throw new Error('请先在 Clash Verge 中选中一份原订阅。')
  return value
}

function isManaged(item) {
  return item?.type === 'local' && /^Lcg[a-f0-9]{16}$/.test(item.uid || '')
    && typeof item.desc === 'string' && item.desc.startsWith(SOURCE_PREFIX)
}

async function assertClosed(isRunning) {
  if (await isRunning()) throw new Error('请从系统托盘完全退出 Clash Verge，再点「一键导入」。')
}

export async function importVergeSubscription({ vergeDir, backupDir, settings, script, isRunning }) {
  const name = subscriptionName(settings)
  if (typeof script !== 'string' || !script.includes('__previousClaudeMain'))
    throw new Error('请先保存并生成 ClaudeGuard 脚本。')
  new Script(script)
  await assertClosed(isRunning)

  const indexPath = join(vergeDir, 'profiles.yaml')
  const profilesDir = join(vergeDir, 'profiles')
  if (!(await lstat(profilesDir).catch(error => {
    if (error.code === 'ENOENT') throw new Error('未找到 Clash Verge 的订阅目录。')
    throw error
  })).isDirectory()) throw new Error('Clash Verge 的订阅目录无效。')
  const globalScriptPath = join(profilesDir, 'Script.js')
  const globalScript = await lstat(globalScriptPath).then(
    () => readRegularFile(globalScriptPath, '全局扩展脚本'),
    error => { if (error.code !== 'ENOENT') throw error; return '' },
  )
  if (globalScript.includes('__previousClaudeMain') && globalScript.includes('GuardNookShare-'))
    throw new Error('Clash Verge 的全局扩展脚本已包含 ClaudeGuard。请先恢复原来的全局扩展脚本，再导入独立订阅。')
  if (/__beforeGuardNookContainment|Claude-guard-gateway|Claude-exit-pinned|GuardNook-Gateway/.test(globalScript))
    throw new Error('Clash Verge 的全局扩展脚本含个人版或旧版守护规则。请先恢复原来的全局扩展脚本，再导入独立订阅。')
  const originalIndex = await readRegularFile(indexPath, 'Clash Verge 订阅列表')
  const registry = readIndex(originalIndex)
  const current = registry.items.find(item => item?.uid === registry.current)
  const sourceUid = isManaged(current) ? current.desc.slice(SOURCE_PREFIX.length) : current?.uid
  const source = registry.items.find(item => item?.uid === sourceUid)
  if (!UID.test(sourceUid || '') || !LOCAL_TYPES.has(source?.type) || !PROFILE_FILE.test(source?.file || ''))
    throw new Error('找不到可复制的原订阅。请在 Clash Verge 中选中原订阅后退出，再重试。')
  const namedItems = registry.items.filter(item => item?.name === name)
  const existing = namedItems[0]
  if (namedItems.length > 1 || (existing && !isManaged(existing)))
    throw new Error(`Clash Verge 已有同名订阅「${name}」。请先在 Clash Verge 中修改该订阅的名称。`)

  const updated = Math.floor(Date.now() / 1000)
  const suffix = randomBytes(8).toString('hex')
  const profile = { uid: existing?.uid ?? `Lcg${suffix}`, type: 'local', name,
    desc: SOURCE_PREFIX + sourceUid, file: `Lcg${suffix}.yaml`, updated, option: {} }
  const files = [[profile.file, await readRegularFile(join(profilesDir, source.file), '原订阅文件')]]
  const auxiliaries = [{ uid: `scg${suffix}`, type: 'script', file: `scg${suffix}.js`, updated }]
  profile.option.script = auxiliaries[0].uid
  files.push([auxiliaries[0].file, script])

  for (const [type, prefix] of [['merge', 'm'], ['rules', 'r'], ['proxies', 'p'], ['groups', 'g']]) {
    const sourceOption = source.option?.[type]
    if (!sourceOption) continue
    const companion = registry.items.find(item => item?.uid === sourceOption && item.type === type)
    if (!companion || !PROFILE_FILE.test(companion.file || ''))
      throw new Error('原订阅的扩展配置无效，无法复制。')
    const uid = `${prefix}cg${suffix}`, file = `${uid}.yaml`
    files.push([file, await readRegularFile(join(profilesDir, companion.file), '原订阅扩展配置')])
    profile.option[type] = uid
    auxiliaries.push({ uid, type, file, updated })
  }

  const oldOptions = new Set(Object.values(existing?.option || {}))
  const otherItems = registry.items.filter(item => item !== existing)
  const stillUsed = new Set(otherItems.flatMap(item => Object.values(item?.option || {})))
  const obsolete = otherItems.filter(item => oldOptions.has(item?.uid) && !stillUsed.has(item.uid)
    && OWNED_FILE.test(item.file || '') && item.file.startsWith(item.uid + '.'))
  registry.items = [...otherItems.filter(item => !obsolete.includes(item)), ...auxiliaries, profile]

  const created = []
  try {
    for (const [file, contents] of files) {
      const path = join(profilesDir, file)
      const fileHandle = await open(path, 'wx', 0o600)
      created.push(path)
      try { await fileHandle.writeFile(contents) } finally { await fileHandle.close() }
    }
    await atomicText(join(backupDir, 'clash-verge-profiles.previous.yaml'), originalIndex)
    await assertClosed(isRunning)
    if (await readRegularFile(indexPath, 'Clash Verge 订阅列表') !== originalIndex)
      throw new Error('Clash Verge 的订阅列表刚刚发生变化，请重新导入。')
    await atomicText(indexPath, dump(registry, { lineWidth: -1 }))
  } catch (error) {
    await Promise.allSettled(created.map(path => rm(path, { force: true })))
    throw error
  }
  // The backup still refers to the previous files if this is a reimport.
  return { name, updated: Boolean(existing) }
}
