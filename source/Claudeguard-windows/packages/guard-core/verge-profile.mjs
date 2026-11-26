import { chmod, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isUsableExpectedIP, validateShareConfig } from './config.mjs'
import { desktopRoot, privateDirectory } from './desktop-common.mjs'
import { applyClaudeGuard, prepareSelectedProfile } from './profile.mjs'
import { deviceExitRules, uuRemoteExceptionRules } from './device-exit.mjs'
import { applyRelayProfile, relayEntry, relayExit, relayExitGroup } from './relay.mjs'
import { parseProfilesYaml, sha256, vergePaths } from './verge.mjs'

const PROVIDER = 'gn-entry'
const CLIENT_LISTENER = 'GuardNook-client'
const PROBE_LISTENER = 'Claude-guard-probe'
const ENTRY_LISTENER = 'GN-entry-check'
const NAME_PREFIX = 'GuardNook：'
const MAX_PROFILE = 8 * 1024 * 1024
const IDENTITY_SCRIPT = 'function main(config) {\n  return config;\n}\n'

export function standaloneProfileName(ip) {
  if (!isUsableExpectedIP(ip))
    throw new Error('独立订阅名称需要已确认的固定出口 IPv4，不能使用文档占位地址。')
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


const FORBIDDEN_KEYS = new Set([
  'secret',
  'external-controller',
  'external-controller-unix',
  'external-controller-tls',
  'external-controller-cors',
  'external-ui',
  'external-ui-name',
  'external-ui-url',
])

export function parseYamlDocument(text) {
  if (typeof text !== 'string') throw new Error('原订阅格式无法识别，已停止生成独立订阅。')
  if (text.length > MAX_PROFILE) throw new Error('原订阅过大，已停止写入。')
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const rawLines = normalized.split('\n')
  const lines = []
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index]
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    if (/^\s*(---|\.\.\.)\s*(#.*)?$/.test(raw)) continue
    const indent = leadingIndent(raw, index + 1)
    lines.push({ index: index + 1, indent, text: raw })
  }
  if (!lines.length) throw new Error('原订阅为空，已停止生成独立订阅。')
  const { value, next } = parseBlock(lines, 0, 0)
  if (next !== lines.length) throw new Error(`原订阅第 ${lines[next].index} 行无法解析，已停止生成独立订阅。`)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('原订阅格式无法识别，已停止生成独立订阅。')
  return value
}

function leadingIndent(line, lineNo) {
  const prefix = line.match(/^[ \t]*/)[0]
  if (prefix.includes('\t')) throw new Error(`原订阅第 ${lineNo} 行使用了制表符缩进，已停止生成独立订阅。`)
  return prefix.length
}

function stripComment(text) {
  let inSingle = false, inDouble = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inSingle) {
      if (ch === "'" && text[i + 1] === "'") { i++; continue }
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '#') return text.slice(0, i).trimEnd()
  }
  return text.trimEnd()
}

function parseBlock(lines, start, minIndent) {
  if (start >= lines.length || lines[start].indent < minIndent) return { value: null, next: start }
  const first = stripComment(lines[start].text.slice(lines[start].indent)).trim()
  return first === '-' || first.startsWith('- ')
    ? parseList(lines, start, lines[start].indent)
    : parseMap(lines, start, lines[start].indent)
}

function parseMap(lines, start, indent) {
  const object = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) throw new Error(`原订阅第 ${line.index} 行缩进不正确，已停止生成独立订阅。`)
    const stripped = stripComment(line.text.slice(line.indent)).trim()
    if (stripped === '-' || stripped.startsWith('- '))
      throw new Error(`原订阅第 ${line.index} 行无法解析，已停止生成独立订阅。`)
    const { key, rest } = splitKey(stripped, line.index)
    if (Object.prototype.hasOwnProperty.call(object, key))
      throw new Error(`原订阅第 ${line.index} 行存在重复字段，已停止生成独立订阅。`)
    if (isBlockScalar(rest))
      throw new Error(`原订阅第 ${line.index} 行含有无法安全解析的多行文本，已停止生成独立订阅。`)
    if (rest === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, indent + 1)
        object[key] = nested.value
        i = nested.next
        continue
      }
      object[key] = null
      i++
      continue
    }
    object[key] = parseValue(rest, line.index)
    i++
  }
  return { value: object, next: i }
}

function parseList(lines, start, indent) {
  const items = []
  let i = start
  while (i < lines.length) {
    const line = lines[i]
    if (line.indent < indent) break
    if (line.indent > indent) throw new Error(`原订阅第 ${line.index} 行缩进不正确，已停止生成独立订阅。`)
    const rawItem = line.text.slice(line.indent)
    if (!rawItem.trimStart().startsWith('-'))
      throw new Error(`原订阅第 ${line.index} 行无法解析，已停止生成独立订阅。`)
    const afterDash = rawItem.replace(/^- ?/, '')
    const body = stripComment(afterDash).trim()
    if (isBlockScalar(body))
      throw new Error(`原订阅第 ${line.index} 行含有无法安全解析的多行文本，已停止生成独立订阅。`)
    if (body && looksLikeMapStart(body) && !isFlowStart(body)) {
      const keyIndent = line.indent + rawItem.length - afterDash.length
      const synthetic = { index: line.index, indent: keyIndent, text: `${' '.repeat(keyIndent)}${afterDash}` }
      const nestedLines = [synthetic]
      let j = i + 1
      while (j < lines.length && lines[j].indent > indent) {
        nestedLines.push(lines[j])
        j++
      }
      const parsed = parseMap(nestedLines, 0, keyIndent)
      if (parsed.next !== nestedLines.length)
        throw new Error(`原订阅第 ${nestedLines[parsed.next].index} 行无法解析，已停止生成独立订阅。`)
      items.push(parsed.value)
      i = j
      continue
    }
    if (body === '') {
      if (i + 1 < lines.length && lines[i + 1].indent > indent) {
        const nested = parseBlock(lines, i + 1, indent + 1)
        items.push(nested.value)
        i = nested.next
        continue
      }
      items.push(null)
      i++
      continue
    }
    items.push(parseValue(body, line.index))
    i++
  }
  return { value: items, next: i }
}

function isBlockScalar(rest) {
  return rest === '|' || rest === '>' || rest.startsWith('|') || rest.startsWith('>')
}

function isFlowStart(text) {
  return text.startsWith('[') || text.startsWith('{')
}

function looksLikeMapStart(text) {
  try {
    splitKey(text, 0)
    return true
  } catch {
    return false
  }
}

function splitKey(text, lineNo) {
  let inSingle = false, inDouble = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inSingle) {
      if (ch === "'" && text[i + 1] === "'") { i++; continue }
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inDouble = false
      continue
    }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === ':') {
      const after = text[i + 1]
      if (after && after !== ' ' && after !== '\t' && after !== '#') continue
      const key = parseKey(text.slice(0, i).trim(), lineNo)
      return { key, rest: text.slice(i + 1).trim() }
    }
  }
  throw new Error(lineNo ? `原订阅第 ${lineNo} 行缺少键名，已停止生成独立订阅。` : 'not-key')
}

function parseKey(raw, lineNo) {
  if (!raw) throw new Error(`原订阅第 ${lineNo} 行缺少键名，已停止生成独立订阅。`)
  if (raw.startsWith('&') || raw.startsWith('*') || raw.startsWith('!!') || raw.startsWith('?'))
    throw new Error(`原订阅第 ${lineNo} 行含有无法安全解析的 YAML 特性，已停止生成独立订阅。`)
  return String(parseScalar(raw, lineNo))
}

function parseValue(text, lineNo) {
  const trimmed = text.trim()
  if (trimmed.startsWith('!!') || trimmed.startsWith('&') || trimmed.startsWith('*'))
    throw new Error(`原订阅第 ${lineNo} 行含有无法安全解析的 YAML 特性，已停止生成独立订阅。`)
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const { value, rest } = parseFlow(trimmed, 0, lineNo)
    if (rest.trim()) throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
    return value
  }
  return parseScalar(trimmed, lineNo)
}

function parseFlow(text, start, lineNo) {
  const open = text[start]
  if (open !== '[' && open !== '{') throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
  const items = []
  let i = start + 1
  let currentKey = null
  const pushEntry = value => {
    if (open === '[') items.push(value)
    else {
      if (currentKey === null) throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
      if (items.some(entry => entry[0] === currentKey))
        throw new Error(`原订阅第 ${lineNo} 行存在重复字段，已停止生成独立订阅。`)
      items.push([currentKey, value])
      currentKey = null
    }
  }
  const skipSpace = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++ }
  skipSpace()
  if (text[i] === (open === '[' ? ']' : '}')) return { value: open === '[' ? [] : {}, rest: text.slice(i + 1) }
  while (i < text.length) {
    skipSpace()
    const close = open === '[' ? ']' : '}'
    if (text[i] === close) {
      if (open === '{') {
        if (currentKey !== null) throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
        return { value: Object.fromEntries(items), rest: text.slice(i + 1) }
      }
      return { value: items, rest: text.slice(i + 1) }
    }
    if (text[i] === '[' || text[i] === '{') {
      const nested = parseFlow(text, i, lineNo)
      if (open === '{' && currentKey === null) throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
      pushEntry(nested.value)
      i = text.length - nested.rest.length
      skipSpace()
      if (text[i] === close) continue
      if (text[i] === ',') { i++; continue }
      throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
    }
    const token = readFlowToken(text, i, lineNo)
    i = token.next
    skipSpace()
    if (open === '{' && currentKey === null && text[i] === ':') {
      currentKey = String(parseScalar(token.raw, lineNo))
      i++
      continue
    }
    pushEntry(parseScalar(token.raw, lineNo))
    skipSpace()
    if (text[i] === close) continue
    if (text[i] === ',') { i++; continue }
    throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
  }
  throw new Error(`原订阅第 ${lineNo} 行括号未闭合，已停止生成独立订阅。`)
}

function readFlowToken(text, start, lineNo) {
  let i = start
  if (text[i] === "'" || text[i] === '"') {
    const quote = text[i]
    i++
    while (i < text.length) {
      if (quote === "'" && text[i] === "'" && text[i + 1] === "'") { i += 2; continue }
      if (text[i] === quote) return { raw: text.slice(start, i + 1), next: i + 1 }
      if (quote === '"' && text[i] === '\\') { i += 2; continue }
      i++
    }
    throw new Error(`原订阅第 ${lineNo} 行引号未闭合，已停止生成独立订阅。`)
  }
  while (i < text.length && !',[\\]{}:'.includes(text[i]) && text[i] !== '#' && text[i] !== '\n') i++
  const raw = text.slice(start, i).trim()
  if (!raw) throw new Error(`原订阅第 ${lineNo} 行无法解析，已停止生成独立订阅。`)
  return { raw, next: i }
}

function parseScalar(text, lineNo) {
  const value = text.trim()
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    throw new Error(`原订阅第 ${lineNo} 行包含无法写入的字符，已停止生成独立订阅。`)
  if (value === '~' || value === 'null' || value === 'Null' || value === 'NULL') return null
  if (value === 'true' || value === 'True' || value === 'TRUE') return true
  if (value === 'false' || value === 'False' || value === 'FALSE') return false
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    return value.slice(1, -1).replace(/''/g, "'")
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    return parseDoubleQuoted(value, lineNo)
  if (/^-?(0|[1-9][0-9]*)$/.test(value)) return Number(value)
  if (/^-?(0|[1-9][0-9]*)\.[0-9]+$/.test(value)) return Number(value)
  return value
}

function parseDoubleQuoted(value, lineNo) {
  let out = '', i = 1
  while (i < value.length - 1) {
    if (value[i] !== '\\') { out += value[i]; i++; continue }
    const next = value[i + 1]
    const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/' }
    if (map[next] !== undefined) { out += map[next]; i += 2; continue }
    throw new Error(`原订阅第 ${lineNo} 行含有无法解析的转义，已停止生成独立订阅。`)
  }
  if (!value.endsWith('"')) throw new Error(`原订阅第 ${lineNo} 行引号未闭合，已停止生成独立订阅。`)
  return out
}

function adoptUpstreamProfile(upstream, originalUid) {
  if (!upstream || typeof upstream !== 'object' || Array.isArray(upstream))
    throw new Error('原订阅格式无法识别，已停止生成独立订阅。')
  if (upstream['proxy-providers']?.[PROVIDER])
    throw new Error('原订阅已包含 GuardNook 入口源，已停止生成独立订阅。')
  const adopted = {}
  for (const [key, value] of Object.entries(upstream)) {
    if (FORBIDDEN_KEYS.has(key) || key === 'proxies' || key === 'proxy-groups'
      || key === 'proxy-providers' || key === 'rules') continue
    adopted[key] = value
  }
  return JSON.parse(JSON.stringify({
    ...adopted,
    proxies: [],
    'proxy-providers': {
      ...(upstream['proxy-providers'] || {}),
      [PROVIDER]: { type: 'file', path: `profiles/${originalUid}.yaml` },
    },
    'proxy-groups': [],
    rules: [],
  }))
}

export function buildStandaloneProfile(config, { originalUid, credentials, originalText } = {}) {
  if (!config?.relay) throw new Error('请先保存并确认 SOCKS5 中转配置。')
  if (typeof originalUid !== 'string' || !/^[0-9A-Za-z]+$/.test(originalUid))
    throw new Error('找不到原订阅，已停止生成独立订阅。')
  if (typeof originalText !== 'string' || !originalText.trim())
    throw new Error('没有可复制的原订阅。')
  if (config.relay.auth !== true)
    throw new Error('当前中转未启用认证，请重新填写 SOCKS5 用户名和密码后再生成订阅。')
  if (!(credentials?.username && credentials?.password))
    throw new Error('无法读取保存的 SOCKS5 凭据，请重新填写出口。')
  if (!isUsableExpectedIP(config.expectedIP))
    throw new Error('独立订阅名称需要已确认的固定出口 IPv4，不能使用文档占位地址。')
  // Standalone subscriptions send leftover traffic through the pinned SOCKS5
  // exit. Claude still uses the fail-closed prefix and gated group.
  const c = validateShareConfig({
    ...config,
    selectedProxy: relayExit,
    coverageVersion: 1,
    deviceWide: true,
    requireTun: true,
  })
  const upstream = parseYamlDocument(originalText)
  const base = adoptUpstreamProfile(upstream, originalUid)
  if (base.mode == null) base.mode = 'rule'
  const relayed = applyRelayProfile(base, c, credentials)
  const built = applyClaudeGuard(prepareSelectedProfile(relayed, c), c)

  const groups = (built['proxy-groups'] || []).map(group => group.name)
  const expected = [relayEntry, relayExitGroup, c.pinnedProxy, c.policyGroup]
  if (groups.length !== expected.length || expected.some((name, index) => groups[index] !== name))
    throw new Error('独立订阅的分组生成失败，已停止写入。')
  const listeners = (built.listeners || []).map(listener => listener.name)
  if (![CLIENT_LISTENER, PROBE_LISTENER, ENTRY_LISTENER].every(name => listeners.includes(name)))
    throw new Error('独立订阅的本机入口生成失败，已停止写入。')
  const rules = built.rules || []
  const head = 'AND,((DOMAIN-SUFFIX,claude.ai),(NETWORK,UDP),(DST-PORT,443)),REJECT'
  const tail = deviceExitRules(c)
  if (rules[0] !== head)
    throw new Error('独立订阅的守护规则生成失败，已停止写入。')
  if (!tail.length || rules.slice(rules.length - tail.length).join('\n') !== tail.join('\n'))
    throw new Error('独立订阅未能把普通流量绑到固定出口，已停止写入。')
  if (!rules.includes('NETWORK,UDP,REJECT') || !rules.includes('IP-CIDR6,::/0,REJECT,no-resolve'))
    throw new Error('独立订阅未能写入固定出口的 UDP 与 IPv6 阻断规则，已停止写入。')
  if (rules.includes('NETWORK,UDP,DIRECT') || rules.includes('MATCH,入口选择'))
    throw new Error('独立订阅不应把普通流量送到入口选择或直连，已停止写入。')
  const exceptions = uuRemoteExceptionRules()
  if (c.allowUURemote === true) {
    if (!exceptions.length || exceptions.some(rule => !rules.includes(rule)))
      throw new Error('独立订阅未能写入 UU 远程例外，已停止写入。')
    const rejectUdp = rules.indexOf('NETWORK,UDP,REJECT')
    if (exceptions.some(rule => rules.indexOf(rule) >= rejectUdp))
      throw new Error('独立订阅的 UU 远程例外必须写在 UDP 阻断规则之前，已停止写入。')
    if (!['strict', 'always'].includes(built['find-process-mode']))
      throw new Error('独立订阅未能开启进程匹配，已停止写入。')
  } else if (exceptions.some(rule => rules.includes(rule)))
    throw new Error('未允许 UU 远程直连，独立订阅却包含 UU 远程例外，已停止写入。')
  const claude = (built['proxy-groups'] || []).find(group => group.name === c.policyGroup)
  const members = claude && Array.isArray(claude.proxies) ? claude.proxies : []
  if (members[0] !== 'REJECT' || members[1] !== c.gatewayProxy || members.length !== 2)
    throw new Error('Claude 守护组必须仅包含阻断和网关，已停止写入。')
  if (built['proxy-providers']?.[PROVIDER]?.path !== `profiles/${originalUid}.yaml`)
    throw new Error('独立订阅的入口引用生成失败，已停止写入。')
  const exit = (built.proxies || []).find(proxy => proxy.name === relayExit)
  if (exit?.type !== 'socks5' || exit.server !== config.relay.host || Number(exit.port) !== config.relay.port
    || exit['dialer-proxy'] !== relayEntry)
    throw new Error('独立订阅的出口生成失败，已停止写入。')
  if (!exit.username || !exit.password)
    throw new Error('独立订阅未能写入 SOCKS5 认证，已停止写入。')
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
  const originalText = await readFile(originalProfile, 'utf8')

  const name = standaloneProfileName(config?.expectedIP)
  const existing = parsed.items.find(item => String(item.name || '').startsWith(NAME_PREFIX))
  const reused = Boolean(existing)
  const uid = existing?.uid ?? freshUid(parsed.items)
  const { text } = buildStandaloneProfile(config, { originalUid, credentials, originalText })

  const backupDirectory = join(root, 'Backups/verge-profile')
  await privateDirectory(backupDirectory)
  const stamp = new Date(now).toISOString().replaceAll(/[:.]/g, '-')
  const profilesBackupPath = join(backupDirectory, `profiles.${stamp}.${randomBytes(4).toString('hex')}.bak`)
  await writeFile(profilesBackupPath, originalYaml, { mode: 0o600, flag: 'wx' })
  await chmod(profilesBackupPath, 0o600)
  if (sha256(await readFile(profilesBackupPath, 'utf8')) !== sha256(originalYaml))
    throw new Error('订阅列表备份校验失败，未切换订阅。')

  // Claude-only standalone profiles keep the user's current Verge TUN/DNS
  // and system-proxy switches. Ordinary traffic should follow the original
  // subscription instead of a rewritten device-wide table.
  const settingsBackupPath = null

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
  let profilesWritten = false
  try {
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
