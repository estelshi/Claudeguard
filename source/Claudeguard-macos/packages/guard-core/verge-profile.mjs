import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateShareConfig } from './config.mjs'
import { desktopRoot, privateDirectory } from './desktop-common.mjs'
import { applyClaudeGuard, prepareSelectedProfile } from './profile.mjs'
import { applyRelayProfile, relayEntry, relayExit, relayExitGroup } from './relay.mjs'
import { deviceExitRules } from './device-exit.mjs'
import { parseProfilesYaml, prepareDeviceVerge, sha256, vergePaths } from './verge.mjs'

const PROVIDER = 'gn-entry'
const CLIENT_LISTENER = 'GuardNook-client'
const PROBE_LISTENER = 'Claude-guard-probe'
const ENTRY_LISTENER = 'GN-entry-check'
const NAME_PREFIX = 'GuardNook：'
const MAX_PROFILE = 8 * 1024 * 1024
const IDENTITY_SCRIPT = 'function main(config) {\n  return config;\n}\n'

export function standaloneProfileName(ip) {
  return `${NAME_PREFIX}${ip}`
}

// Small single-quoted YAML writer. Keeps the generated subscription readable and
// dependency-free; every string is quoted so node names cannot change meaning.
function quoteString(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('订阅中包含无法写入的字符，已停止生成。')
  return `'${value.replaceAll("'", "''")}'`
}

function scalar(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string') return quoteString(value)
  throw new Error('订阅中包含无法写入的值，已停止生成。')
}

function keyText(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : quoteString(key)
}

function objectLines(value, indent) {
  const pad = '  '.repeat(indent)
  const lines = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const head = `${pad}${keyText(key)}:`
    if (Array.isArray(item)) {
      if (!item.length) { lines.push(`${head} []`); continue }
      if (item.every(entry => entry === null || typeof entry !== 'object')) {
        lines.push(`${head} [${item.map(scalar).join(', ')}]`)
        continue
      }
      lines.push(head)
      for (const entry of item) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('订阅中包含无法写入的列表，已停止生成。')
        const nested = objectLines(entry, indent + 1)
        if (!nested.length) { lines.push(`${pad}  - {}`); continue }
        lines.push(`${pad}  - ${nested[0].slice((indent + 1) * 2)}`)
        for (const line of nested.slice(1)) lines.push(`  ${line}`)
      }
      continue
    }
    if (item !== null && typeof item === 'object') {
      const nested = objectLines(item, indent + 1)
      if (!nested.length) { lines.push(`${head} {}`); continue }
      lines.push(head, ...nested)
      continue
    }
    lines.push(`${head} ${scalar(item)}`)
  }
  return lines
}

export function yamlDocument(value) {
  return objectLines(value, 0).join('\n') + '\n'
}

export function buildStandaloneProfile(config, { originalUid, credentials } = {}) {
  if (!config?.relay) throw new Error('请先保存并确认 SOCKS5 中转配置。')
  if (typeof originalUid !== 'string' || !/^[0-9A-Za-z]+$/.test(originalUid))
    throw new Error('找不到原订阅，已停止生成独立订阅。')
  if (config.relay.auth && !(credentials?.username && credentials?.password))
    throw new Error('无法读取保存的 SOCKS5 凭据，请重新填写出口。')
  const c = validateShareConfig({ ...config, selectedProxy: relayExit, coverageVersion: 1, deviceWide: true, requireTun: true })
  const base = {
    mode: 'rule',
    'log-level': 'info',
    'allow-lan': false,
    ipv6: false,
    'proxy-providers': { [PROVIDER]: { type: 'file', path: `profiles/${originalUid}.yaml` } },
    proxies: [],
    'proxy-groups': [],
  }
  const relayed = applyRelayProfile(base, c, config.relay.auth ? credentials : null)
  const built = applyClaudeGuard(prepareSelectedProfile(relayed, c), c)

  const groups = (built['proxy-groups'] || []).map(group => group.name)
  const expected = [relayEntry, relayExitGroup, c.pinnedProxy, c.policyGroup]
  if (groups.length !== expected.length || expected.some(name => !groups.includes(name)))
    throw new Error('独立订阅的分组生成失败，已停止写入。')
  const listeners = (built.listeners || []).map(listener => listener.name)
  if (listeners.length !== 3
    || ![CLIENT_LISTENER, PROBE_LISTENER, ENTRY_LISTENER].every(name => listeners.includes(name)))
    throw new Error('独立订阅的本机入口生成失败，已停止写入。')
  const rules = built.rules || []
  const head = 'AND,((DOMAIN-SUFFIX,claude.ai),(NETWORK,UDP),(DST-PORT,443)),REJECT'
  const tail = deviceExitRules(c)
  if (rules[0] !== head || rules.slice(-tail.length).join('|') !== tail.join('|'))
    throw new Error('独立订阅的守护规则生成失败，已停止写入。')
  if (built['proxy-providers']?.[PROVIDER]?.path !== `profiles/${originalUid}.yaml`)
    throw new Error('独立订阅的入口引用生成失败，已停止写入。')
  const exit = (built.proxies || []).find(proxy => proxy.name === relayExit)
  if (exit?.type !== 'socks5' || exit.server !== config.relay.host || Number(exit.port) !== config.relay.port
    || exit['dialer-proxy'] !== relayEntry)
    throw new Error('独立订阅的出口生成失败，已停止写入。')
  if (!(built.proxies || []).some(proxy => proxy.name === c.gatewayProxy))
    throw new Error('独立订阅的守护网关生成失败，已停止写入。')

  const text = yamlDocument(built)
  if (text.length > MAX_PROFILE) throw new Error('独立订阅过大，已停止写入。')
  return { config: built, text }
}

async function atomicText(path, text, mode) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temporary, text, { mode, flag: 'wx' })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8') } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

async function regularProfile(path, label) {
  let info
  try { info = await lstat(path) } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${label}不存在，已停止写入。`)
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label}不是普通文件，已停止写入。`)
  if (info.size > MAX_PROFILE) throw new Error(`${label}过大，已停止写入。`)
  return info
}

function resolveOriginalUid(parsed, record) {
  const ours = item => String(item?.name || '').startsWith(NAME_PREFIX)
  if (record?.originalUid && parsed.items.some(item => item.uid === record.originalUid && !ours(item)))
    return record.originalUid
  const current = parsed.items.find(item => item.uid === parsed.current)
  if (current && !ours(current)) return current.uid
  return parsed.items.find(item => item.type === 'remote' && !ours(item))?.uid ?? null
}

function freshUid(items) {
  const used = new Set(items.map(item => item.uid))
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (;;) {
    const uid = 'l' + Array.from(randomBytes(11), byte => alphabet[byte % alphabet.length]).join('')
    if (!used.has(uid)) return uid
  }
}

function setCurrent(text, uid) {
  if (/^current:[^\n]*$/m.test(text)) return text.replace(/^current:[^\n]*$/m, `current: ${uid}`)
  return `current: ${uid}\n${text}`
}

function dropItem(text, uid) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trimEnd() === `- uid: ${uid}`)
  if (start < 0) return text
  let end = start + 1
  while (end < lines.length && !/^-\s+uid:/.test(lines[end])) end++
  lines.splice(start, end - start)
  return lines.join('\n')
}

function profileItem(uid, name, now) {
  return [
    `- uid: ${uid}`,
    '  type: local',
    `  name: ${name}`,
    `  file: ${uid}.yaml`,
    `  updated: ${Math.floor(now / 1000)}`,
  ].join('\n')
}

// The global script runs for every profile, so a GuardNook script left in place
// would rewrite this subscription. Only our own script is replaced; a foreign
// one is reported and left untouched.
async function neutralizeGlobalScript(home, now) {
  const paths = vergePaths(home)
  const previousText = await readOptional(paths.script)
  if (previousText === null) return { neutralized: false, reason: 'absent', backupPath: null }
  if (!previousText.includes('GN-Exit') || !previousText.includes('GuardNookShare-'))
    return { neutralized: false, reason: 'foreign', backupPath: null }
  if (previousText === IDENTITY_SCRIPT) return { neutralized: false, reason: 'already-empty', backupPath: null }
  const directory = join(desktopRoot(home), 'Backups/verge-global-script')
  await privateDirectory(directory)
  const stamp = new Date(now).toISOString().replaceAll(/[:.]/g, '-')
  const backupPath = join(directory, `Script.js.${stamp}.${randomBytes(4).toString('hex')}.bak`)
  const previous = await readFile(paths.script)
  await writeFile(backupPath, previous, { mode: 0o600, flag: 'wx' })
  await chmod(backupPath, 0o600)
  if (sha256(await readFile(backupPath)) !== sha256(previous))
    throw new Error('全局扩展脚本备份校验失败，未切换订阅。')
  await atomicText(paths.script, IDENTITY_SCRIPT, 0o600)
  if (await readFile(paths.script, 'utf8') !== IDENTITY_SCRIPT)
    throw new Error('全局扩展脚本写入校验失败，未切换订阅。')
  return { neutralized: true, reason: null, backupPath }
}

export async function installVergeProfile({ home = homedir(), config, credentials, now = Date.now() } = {}) {
  const paths = vergePaths(home)
  const root = desktopRoot(home)
  const originalYaml = await readFile(paths.profilesYaml, 'utf8')
  if (originalYaml.length > MAX_PROFILE) throw new Error('Clash 订阅列表过大，已停止写入。')
  const parsed = parseProfilesYaml(originalYaml)
  const record = await readStandaloneRecord(home)
  const originalUid = resolveOriginalUid(parsed, record)
  if (!originalUid) throw new Error('找不到可用的原订阅，请先在 Clash Verge 中导入订阅。')
  const originalProfile = join(paths.dir, 'profiles', `${originalUid}.yaml`)
  await regularProfile(originalProfile, '原订阅文件')

  const name = standaloneProfileName(config?.expectedIP)
  const existing = parsed.items.find(item => String(item.name || '').startsWith(NAME_PREFIX))
  const reused = Boolean(existing)
  const uid = existing?.uid ?? freshUid(parsed.items)
  const { text } = buildStandaloneProfile(config, { originalUid, credentials })
  const settings = await prepareDeviceVerge(home)

  const backupDirectory = join(root, 'Backups/verge-profile')
  await privateDirectory(backupDirectory)
  const stamp = new Date(now).toISOString().replaceAll(/[:.]/g, '-')
  const profilesBackupPath = join(backupDirectory, `profiles.${stamp}.${randomBytes(4).toString('hex')}.bak`)
  await writeFile(profilesBackupPath, originalYaml, { mode: 0o600, flag: 'wx' })
  await chmod(profilesBackupPath, 0o600)
  if (sha256(await readFile(profilesBackupPath, 'utf8')) !== sha256(originalYaml))
    throw new Error('订阅列表备份校验失败，未切换订阅。')

  // Verge saves its in-memory settings on exit. This installer is called
  // only after the native app has confirmed that Verge has terminated.
  const settingsChanged = settings.original !== settings.updated
  let settingsBackupPath = null
  const settingsMode = (await lstat(settings.path)).mode & 0o777
  if (settingsChanged) {
    settingsBackupPath = join(backupDirectory, `verge.${stamp}.${randomBytes(4).toString('hex')}.yaml.bak`)
    await writeFile(settingsBackupPath, settings.original, { mode: 0o600, flag: 'wx' })
    if (await readFile(settingsBackupPath, 'utf8') !== settings.original)
      throw new Error('Clash 设置备份校验失败，未切换订阅。')
  }

  const profilePath = join(paths.dir, 'profiles', `${uid}.yaml`)
  await atomicText(profilePath, text, 0o600)
  if (sha256(await readFile(profilePath, 'utf8')) !== sha256(text))
    throw new Error('独立订阅写入校验失败，未切换订阅。')

  const script = await neutralizeGlobalScript(home, now)

  let next = dropItem(originalYaml, uid)
  next = setCurrent(next, uid)
  next = `${next.replace(/\s+$/, '')}\n${profileItem(uid, name, now)}\n`
  const mode = (await lstat(paths.profilesYaml)).mode & 0o777
  await privateDirectory(root)
  const recordPath = join(root, 'standalone.json')
  let settingsWritten = false, profilesWritten = false
  try {
    if (settingsChanged) {
      await atomicText(settings.path, settings.updated, settingsMode)
      settingsWritten = true
      if (await readFile(settings.path, 'utf8') !== settings.updated)
        throw new Error('Clash TUN 设置写入校验失败。')
    }
    await atomicText(paths.profilesYaml, next, mode)
    profilesWritten = true
    const check = parseProfilesYaml(await readFile(paths.profilesYaml, 'utf8'))
    const item = check.items.find(entry => entry.uid === uid)
    if (check.current !== uid || item?.name !== name || item?.file !== `${uid}.yaml`)
      throw new Error('订阅列表写入校验失败。')

    await atomicText(recordPath, JSON.stringify({
      version: 1, uid, name, originalUid, installedAt: now,
    }, null, 2) + '\n', 0o600)
  } catch (error) {
    const results = await Promise.allSettled([
      ...(settingsWritten ? [atomicText(settings.path, settings.original, settingsMode)] : []),
      ...(profilesWritten ? [atomicText(paths.profilesYaml, originalYaml, mode)] : []),
    ])
    if (results.some(result => result.status === 'rejected')) throw new Error('应用未完成，Clash 设置恢复失败，请检查备份。')
    throw error
  }

  return {
    uid, name, originalUid, profilePath, profilesBackupPath, settingsBackupPath, reused,
    scriptNeutralized: script.neutralized, scriptBackupPath: script.backupPath,
  }
}

async function readStandaloneRecord(home) {
  const text = await readOptional(join(desktopRoot(home), 'standalone.json'))
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}

export async function standaloneStatus(home = homedir()) {
  const record = await readStandaloneRecord(home)
  const profilesYaml = await readOptional(vergePaths(home).profilesYaml)
  const parsed = profilesYaml === null ? { current: null, items: [] } : parseProfilesYaml(profilesYaml)
  const item = record?.uid ? parsed.items.find(entry => entry.uid === record.uid) : null
  return {
    installed: Boolean(item),
    selected: Boolean(item && parsed.current === record.uid),
    uid: item?.uid ?? record?.uid ?? null,
    name: item?.name ?? null,
    originalUid: record?.originalUid ?? null,
    current: parsed.current,
  }
}
