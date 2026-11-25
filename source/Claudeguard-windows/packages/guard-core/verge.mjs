import { chmod, lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { Script } from 'node:vm'
import { createController } from './controller.mjs'
import { desktopRoot, privateDirectory } from './desktop-common.mjs'
import { relayRules } from './relay.mjs'

const VERGE_DIR = 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev'
const BACKUP_DIR = 'Backups/verge-global-script'
const BACKUP_PATTERN = /^Script\.js\.[0-9A-Za-z.-]+\.bak$/
const MAX_SCRIPT = 2 * 1024 * 1024
const NOOP_SCRIPT = 'function main(config) {\n  return config;\n}\n'

export function vergePaths(home = homedir()) {
  const dir = join(home, VERGE_DIR)
  return {
    dir,
    script: join(dir, 'profiles', 'Script.js'),
    settings: join(dir, 'verge.yaml'),
    profilesYaml: join(dir, 'profiles.yaml'),
    plist: '/Applications/Clash Verge.app/Contents/Info.plist',
  }
}

export function parseProfilesYaml(text) {
  const current = /^current:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(String(text))?.[1] ?? null
  const items = []
  let item = null
  for (const line of String(text).split(/\r?\n/)) {
    const entry = /^\s*-\s+uid:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (entry) {
      item = { uid: entry[1] }
      items.push(item)
      continue
    }
    if (!item) continue
    const field = /^\s+(type|name|file):\s*(.*?)\s*$/.exec(line)
    if (!field) continue
    const value = field[2].replace(/^['"]|['"]$/g, '')
    item[field[1]] = value === '' || value === 'null' || value === '~' ? null : value
  }
  return { current, items, selected: items.find(entry => entry.uid === current) ?? null }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export async function readVergeState(home = homedir()) {
  const paths = vergePaths(home)
  const state = { ...paths, version: null, scriptExists: false, scriptSize: null, scriptSHA256: null, currentProfile: null }
  try {
    const plist = await readFile(paths.plist, 'utf8')
    state.version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
  } catch { /* Version is informational only. */ }
  try {
    const info = await lstat(paths.script)
    if (info.isFile() && !info.isSymbolicLink()) {
      state.scriptExists = true
      state.scriptSize = info.size
      state.scriptSHA256 = sha256(await readFile(paths.script))
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  try { state.currentProfile = parseProfilesYaml(await readFile(paths.profilesYaml, 'utf8')).selected } catch { /* Subscription name is optional. */ }
  return state
}

function backupDirectory(home) {
  return join(desktopRoot(home), BACKUP_DIR)
}

async function listBackups(home) {
  const directory = backupDirectory(home)
  let names = []
  try { names = await readdir(directory) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const entries = []
  for (const name of names.filter(value => BACKUP_PATTERN.test(value))) {
    const path = join(directory, name)
    try {
      const info = await lstat(path)
      if (info.isFile() && !info.isSymbolicLink()) entries.push({ path, mtime: info.mtimeMs, size: info.size })
    } catch { /* A racing file is not a restore candidate. */ }
  }
  return entries.sort((a, b) => b.mtime - a.mtime || (a.path < b.path ? 1 : -1))
}

export async function latestBackup(home = homedir()) {
  return (await listBackups(home))[0]?.path ?? null
}

async function atomicPrivateFile(path, data) {
  const temporary = join(dirname(path), `Script.js.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally { await rm(temporary, { force: true }) }
}

function validateGeneratedScript(scriptText) {
  if (typeof scriptText !== 'string' || !scriptText.trim()) throw new Error('生成的脚本为空，已停止写入。')
  if (scriptText.length > MAX_SCRIPT) throw new Error('生成的脚本过大，已停止写入。')
  for (const marker of ['入口选择', 'GN-Exit', 'GuardNookShare-Claude'])
    if (!scriptText.includes(marker)) throw new Error('这不是 ClaudeGuard 生成的脚本，已停止写入。')
  if (/__beforeGuardNookContainment|Claude-guard-gateway|Claude-exit-pinned|GuardNook-Gateway/.test(scriptText))
    throw new Error('检测到个人版守护脚本，拒绝写入。')
  new Script(scriptText)
}

const personalScript = /__beforeGuardNookContainment|Claude-guard-gateway|Claude-exit-pinned|GuardNook-Gateway/

export async function prepareDeviceVerge(home) {
  const paths = vergePaths(home)
  for (const path of [paths.script, paths.settings]) {
    const info = await lstat(path)
    if (!info.isFile() || info.size > MAX_SCRIPT) throw new Error('Clash 设置文件不可用。')
  }
  const script = await readFile(paths.script, 'utf8')
  if (personalScript.test(script)) throw new Error('检测到个人版扩展脚本，请换用独立的 Clash 环境。')
  const original = await readFile(paths.settings, 'utf8')
  // Only change the top-level fields this Verge version owns, preserving every
  // other preference and refusing unusual YAML instead of writing ambiguously.
  let updated = original
  for (const [name, value] of [['enable_tun_mode', 'true'], ['enable_dns_settings', 'false']]) {
    const found = [...updated.matchAll(new RegExp(`^${name}:[ \t]*(true|false|null)[ \t]*(#.*)?$`, 'gm'))]
    if (found.length !== 1) throw new Error('Clash 的 TUN 或 DNS 设置格式无法识别，尚未应用整机模式。')
    updated = updated.replace(found[0][0], `${name}: ${value}${found[0][2] ? ' ' + found[0][2] : ''}`)
  }
  return { path: paths.settings, original, updated }
}


export async function assertCompatibleVergeScript(home = homedir()) {
  const paths = vergePaths(home)
  let info
  try { info = await lstat(paths.script) } catch (error) {
    if (error && error.code === 'ENOENT') return
    throw error
  }
  if (!info.isFile() || info.size > MAX_SCRIPT) throw new Error('Clash 设置文件不可用。')
  const script = await readFile(paths.script, 'utf8')
  if (personalScript.test(script)) throw new Error('检测到个人版扩展脚本，请换用独立的 Clash 环境。')
}

export async function applyDeviceVerge({ home, scriptText }) {
  if (!scriptText.includes('"deviceWide":true')) throw new Error('缺少整机固定出口脚本。')
  const settings = await prepareDeviceVerge(home)
  if (settings.original === settings.updated) return applyVergeScript({ home, scriptText })
  const directory = backupDirectory(home)
  await privateDirectory(directory)
  await writeFile(join(directory, `verge.${randomBytes(8).toString('hex')}.yaml.bak`), settings.original, { mode: 0o600, flag: 'wx' })
  await atomicPrivateFile(settings.path, settings.updated)
  try {
    return await applyVergeScript({ home, scriptText })
  } catch (error) {
    await atomicPrivateFile(settings.path, settings.original)
    throw error
  }
}

export async function applyVergeScript({ home = homedir(), scriptText, now = Date.now() } = {}) {
  validateGeneratedScript(scriptText)
  const paths = vergePaths(home)
  let previous
  try {
    const info = await lstat(paths.script)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Clash Verge 的全局扩展脚本不是普通文件，已停止写入。')
    previous = await readFile(paths.script)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new Error('未找到 Clash Verge 的全局扩展脚本（profiles/Script.js），请先在 Verge 中启用全局扩展脚本。')
  }
  if (previous.length > MAX_SCRIPT) throw new Error('现有全局扩展脚本过大，已停止写入。')
  const previousSHA256 = sha256(previous)
  const nextSHA256 = sha256(scriptText)
  const profile = parseProfilesYaml(await readFile(paths.profilesYaml, 'utf8').catch(() => '')).selected

  if (previousSHA256 === nextSHA256) {
    return { applied: false, unchanged: true, scriptPath: paths.script, scriptSHA256: nextSHA256,
      previousSHA256, backupPath: await originalBackup(home), currentProfile: profile }
  }

  const directory = backupDirectory(home)
  await privateDirectory(directory)
  const stamp = new Date(now).toISOString().replaceAll(/[:.]/g, '-')
  const backupPath = join(directory, `Script.js.${stamp}.${randomBytes(4).toString('hex')}.bak`)
  await writeFile(backupPath, previous, { mode: 0o600, flag: 'wx' })
  await chmod(backupPath, 0o600)
  if (sha256(await readFile(backupPath)) !== previousSHA256) {
    await rm(backupPath, { force: true })
    throw new Error('原脚本备份校验失败，未写入 Clash Verge。')
  }

  await atomicPrivateFile(paths.script, scriptText)
  if (sha256(await readFile(paths.script)) !== nextSHA256) throw new Error('写入后校验失败，暂不要重载 Clash，请先检查脚本备份。')
  return { applied: true, unchanged: false, scriptPath: paths.script, scriptSHA256: nextSHA256,
    previousSHA256, backupPath, currentProfile: profile }
}

function looksLikeShareScript(buffer) {
  const text = buffer.toString('utf8')
  return text.includes('GN-Exit') && text.includes('GuardNookShare-')
}

// A backup taken after an earlier apply is a GuardNook script, not the user's
// original. Skip those — and the no-op script GuardNook writes when it takes
// over the global slot — so「恢复原脚本」really restores the original.
export async function originalBackup(home = homedir()) {
  let original = null
  for (const candidate of await listBackups(home)) {
    let content
    try { content = await readFile(candidate.path) } catch { continue }
    if (looksLikeShareScript(content) || content.toString('utf8') === NOOP_SCRIPT) continue
    original = candidate.path
  }
  return original
}

export async function restoreVergeScript({ home = homedir(), backupPath } = {}) {
  const directory = resolve(backupDirectory(home))
  let source = await originalBackup(home)
  if (backupPath !== undefined) {
    source = resolve(String(backupPath))
    if (dirname(source) !== directory || !BACKUP_PATTERN.test(basename(source)))
      throw new Error('备份文件位置异常，已停止恢复。')
  }
  if (!source) throw new Error('还没有可恢复的原脚本备份。')
  const info = await lstat(source)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('备份不是普通文件，已停止恢复。')
  const original = await readFile(source)
  if (/__beforeGuardNookContainment|Claude-guard-gateway|Claude-exit-pinned|GuardNook-Gateway/.test(original.toString('utf8')))
    throw new Error('这份备份包含个人版守护规则。分享版不能写回，请保留当前 Clash 配置。')
  const scriptSHA256 = sha256(original)

  const paths = vergePaths(home)
  let previousSHA256 = null
  try {
    const target = await lstat(paths.script)
    if (!target.isFile() || target.isSymbolicLink()) throw new Error('当前全局扩展脚本不是普通文件，已停止恢复。')
    previousSHA256 = sha256(await readFile(paths.script))
  } catch (error) { if (error.code !== 'ENOENT') throw error }

  await atomicPrivateFile(paths.script, original)
  if (sha256(await readFile(paths.script)) !== scriptSHA256) throw new Error('恢复后校验失败，请检查文件权限。')
  return { restored: true, scriptPath: paths.script, backupPath: source, scriptSHA256, previousSHA256 }
}

// mihomo reports AND rules in its own spelling; compare the same way verifyPolicy does.
function normalizedAnd(payload) {
  return String(payload ?? '').replace(/DomainSuffix/g, 'DOMAIN-SUFFIX').replace(/Network/g, 'NETWORK')
    .replace(/DstPort/g, 'DST-PORT').replace(/\(NETWORK,udp\)/gi, '(NETWORK,UDP)').replace(/\s*&&\s*/g, ',')
}

export async function verifyVergeLoaded({ config, relay, controller } = {}) {
  const details = {
    entry: false, exit: false, guardRule: false, policyGroup: false,
    atTop: false, blockIndex: -1, shadowCount: 0, shadow: [], reason: null,
  }
  const ctl = controller || createController(config)
  let proxies, rules
  try {
    [proxies, rules] = await Promise.all([
      ctl.request('/proxies', 'GET', undefined, { timeoutMs: 3000 }),
      ctl.request('/rules', 'GET', undefined, { timeoutMs: 3000 }),
    ])
  } catch {
    details.reason = 'controller-unavailable'
    return { loaded: false, ...details }
  }
  const names = Object.keys(proxies?.proxies || {})
  const group = config?.policyGroup || 'GuardNookShare-Claude'
  details.entry = names.includes('入口选择')
  details.exit = names.includes('GN-Exit')
  details.policyGroup = names.includes(group)
  const ruleList = Array.isArray(rules?.rules) ? rules.rules : []
  const active = relay || config?.relay || null
  const block = active?.id ? relayRules({ relay: active }) : []
  const marker = active?.id ? `gn-${active.id}.invalid` : null
  details.guardRule = marker
    ? ruleList.some(rule => rule?.payload === marker)
    : ruleList.some(rule => rule?.proxy === group)
  if (details.guardRule) {
    // Existence is not enough: the guard block only works when nothing ahead of it
    // rejects the same traffic. Anchor on the relay marker so a shifted block is visible.
    const anchor = marker
      ? ruleList.findIndex(rule => rule?.payload === marker) - (block.length - 1)
      : ruleList.findIndex(rule => rule?.proxy === group)
    details.blockIndex = anchor
    const matches = (actual, expected) => expected.startsWith('AND,')
      ? actual?.type === 'AND' && actual.proxy === 'REJECT' && normalizedAnd(actual.payload) === expected.slice(4, -7)
      : actual?.type === 'Domain' && actual.payload === expected.split(',')[1] && actual.proxy === 'REJECT'
    details.atTop = block.length > 0
      ? anchor === 0 && block.every((expected, index) => matches(ruleList[index], expected))
      : anchor === 0
    if (!details.atTop) {
      const blockers = (anchor > 0 ? ruleList.slice(0, anchor) : []).filter(rule => rule?.proxy === 'REJECT')
      details.shadowCount = blockers.length
      details.shadow = blockers.slice(0, 3).map(rule => `${rule.type},${rule.payload}`)
    }
  }
  if (!(details.entry && details.exit && details.guardRule)) details.reason = 'not-loaded'
  else if (!details.atTop) details.reason = details.shadowCount > 0 ? 'rules-shadowed' : 'rules-not-at-top'
  return { loaded: details.reason === null, ...details }
}
