import { createConnection, isIP } from 'node:net'
import { networkInterfaces, platform } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { connectTunnel } from './tunnel.mjs'

const execute = promisify(execFile)
export const relayEntry = '入口选择'
export const relayExitGroup = '出口选择'
export const relayExit = 'GN-Exit'
export const entryTestURL = 'https://www.gstatic.com/generate_204'
export const reasonActions = Object.freeze({
  entry_unavailable: { text: '没有可用的入口节点。订阅更新后，原节点名也可能已失效。', action: '重新选择入口' },
  exit_unreachable: { text: '已选入口无法连接或完成 SOCKS5 出口测试。', action: '检查出口地址与端口' },
  exit_auth_failed: { text: 'SOCKS5 出口拒绝了登录凭据。', action: '重新填写出口凭据' },
  egress_mismatch: { text: 'Claude 通道实测公网 IPv4 与已确认的地址不同。', action: '检查固定出口', retry: true },
  global_ipv6_present: { text: '实测发现守护通道外的接口可以用 IPv6 出网，Claude 通道未放行。', action: '检查 IPv6 后重新验证', retry: true },
  relay_credentials_unavailable: { text: '无法读取保存的 SOCKS5 凭据，Claude 通道未放行。', action: '重新填写出口凭据' },
})

export function parseSocks5Link(value) {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'socks5:' || !url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error()
    return normalizeSocks5({ host: url.hostname, port: Number(url.port),
      username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) })
  } catch { throw new Error('SOCKS5 链接无效。请检查协议、地址、端口，以及特殊字符是否已百分号编码。') }
}

export function normalizeSocks5(input, { stored = false } = {}) {
  const host = typeof input?.host === 'string' ? input.host.trim().toLowerCase() : ''
  const port = input?.port
  const goodHost = isIP(host) === 4 || /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    && !/^[\d.]+$/.test(host)
  if (!goodHost || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('请填写 SOCKS5 服务器域名或 IPv4 地址，以及有效端口。')
  if (stored) return { host, port }
  const username = input.username ?? '', password = input.password ?? ''
  if ([username, password].some(value => typeof value !== 'string' || Buffer.byteLength(value) > 255 || /[\u0000-\u001f\u007f]/.test(value))
    || Boolean(username) !== Boolean(password)) throw new Error('SOCKS5 用户名和密码应一起填写或一起留空，每项最多 255 字节。')
  return { host, port, username, password }
}

export function normalizeRelay(input) {
  const { host, port } = normalizeSocks5(input, { stored: true })
  if (!/^[a-f0-9]{32}$/.test(input.id) || !Number.isInteger(input.checkPort) || input.checkPort < 20000 || input.checkPort > 29999
    || typeof input.auth !== 'boolean' || typeof input.confirmed !== 'boolean')
    throw new Error('中转配置无效，请重新生成脚本。')
  const keyword = typeof input.keyword === 'string' ? input.keyword.trim() : ''
  const nodes = input.nodes ?? []
  if (!Array.isArray(nodes) || nodes.length > 64 || nodes.some(name => !isRelayEntryName(name))
    || keyword.length > 100 || /[\r\n\0,]/.test(keyword) || Boolean(keyword) === Boolean(nodes.length))
    throw new Error('请选择入口节点，或填写一个名称关键词。')
  return Object.freeze({ id: input.id, host, port, checkPort: input.checkPort, auth: input.auth,
    confirmed: input.confirmed, keyword, nodes: Object.freeze([...new Set(nodes)]) })
}

export function isRelayEntryName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\r\n,\0]/.test(name)
    && !/^(?:GN-|GuardNook|Claude-(?:guard|exit-pinned|entry-pinned)|DIRECT$|REJECT(?:-DROP)?$|GLOBAL$|COMPATIBLE$|PASS$)/i.test(name)
}

export function relayEntryMatches(relay, name) {
  return isRelayEntryName(name) && (relay.keyword ? name.toLowerCase().includes(relay.keyword.toLowerCase()) : relay.nodes.includes(name))
}

export function relayRules(c) {
  if (!c.relay) return []
  return ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com']
    .map(domain => `AND,((DOMAIN-SUFFIX,${domain}),(NETWORK,UDP),(DST-PORT,443)),REJECT`)
    .concat(`DOMAIN,gn-${c.relay.id}.invalid,REJECT`)
}

export function applyRelayProfile(input, c, credentials) {
  if (!c.relay) return input
  const relay = c.relay
  const proxies = input.proxies ||= []
  const groups = input['proxy-groups'] ||= []
  const listeners = input.listeners ||= []
  if ([...proxies, ...groups].some(entry => ['入口选择', '出口选择', 'GN-Exit'].includes(entry.name))
    || listeners.some(listener => Number(listener.port) === relay.checkPort))
    throw new Error('ClaudeGuard relay names or test port are already in use')
  const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const simple = proxies.filter(proxy => !proxy['dialer-proxy'] && !['direct', 'reject'].includes(proxy.type) && relayEntryMatches(relay, proxy.name))
  const inline = simple.map(proxy => proxy.name)
  if (relay.nodes.some(name => proxies.some(proxy => proxy.name === name) && !inline.includes(name)))
    throw new Error('Selected entry is already chained or is not a concrete proxy')
  const use = relay.keyword || relay.nodes.some(name => !inline.includes(name)) ? Object.keys(input['proxy-providers'] || {}) : []
  const filter = relay.keyword ? '(?i)' + escapeRE(relay.keyword) : '^(?:' + relay.nodes.map(escapeRE).join('|') + ')$'
  groups.push({ name: '入口选择', type: 'select', proxies: inline.length || use.length ? inline : ['REJECT'], ...(use.length ? { use } : {}), filter,
    'empty-fallback': 'REJECT', 'disable-udp': true })
  groups.push({ name: '出口选择', type: 'select', proxies: ['GN-Exit'], 'disable-udp': true })
  proxies.push({ name: 'GN-Exit', type: 'socks5', server: relay.host, port: relay.port, 'dialer-proxy': '入口选择', udp: false,
    ...(relay.auth ? { username: credentials.username, password: credentials.password } : {}) })
  listeners.push({ name: 'GN-entry-check', type: 'http', listen: '127.0.0.1', port: relay.checkPort, proxy: '入口选择',
    users: [{ username: c.proxyUser, password: c.proxyPassword }] })
  return input
}

export function verifyRelayMembers(relay, proxies, provider) {
  const entry = proxies?.[relayEntry], exit = proxies?.[relayExit], exitGroup = proxies?.[relayExitGroup]
  if (entry?.type !== 'Selector' || exit?.type !== 'Socks5' || exit.udp !== false || exit['dialer-proxy'] !== relayEntry
    || exitGroup?.type !== 'Selector' || exitGroup.all?.length !== 1 || exitGroup.all[0] !== relayExit
    || exitGroup.now !== relayExit)
    throw new Error('guard-route-not-installed')
  // Mihomo keeps file-provider nodes out of the top-level /proxies map.
  const providerNodes = new Map((provider?.vehicleType === 'File' && Array.isArray(provider.proxies) ? provider.proxies : [])
    .map(node => [node?.name, node]))
  const valid = name => {
    const node = proxies[name] ?? providerNodes.get(name)
    return relayEntryMatches(relay, name) && typeof node?.type === 'string' && !Array.isArray(node.all)
      && !node['dialer-proxy'] && !['Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'PassRule', 'Dns',
        'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'].includes(node.type)
  }
  if (!entry.all?.length || entry.all.some(name => !valid(name)) || !entry.all.includes(entry.now))
    throw new Error('entry_unavailable')
}

function readExactly(socket, length, timeout) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer)
      socket.off('readable', onReadable); socket.off('error', onError); socket.off('close', onClose)
      if (error) reject(error); else resolve(value)
    }
    const onError = () => finish(new Error('exit_unreachable'))
    const onClose = () => onError()
    const onReadable = () => {
      const bytes = socket.read(length)
      if (bytes?.length === length) finish(null, bytes)
      else if (socket.readableEnded || socket.destroyed) onError()
    }
    const timer = setTimeout(onError, timeout)
    socket.on('readable', onReadable); socket.once('error', onError); socket.once('close', onClose)
    onReadable()
  })
}

export async function checkSocks5(socket, credentials, timeout = 2500, attest = async () => {}) {
  const username = Buffer.from(credentials.username), password = Buffer.from(credentials.password)
  const method = username.length ? 2 : 0
  const hello = readExactly(socket, 2, timeout)
  socket.write(Buffer.from([5, 1, method]))
  const reply = await hello
  if (reply[0] !== 5) throw new Error('exit_unreachable')
  await attest()
  if (reply[1] !== method) throw new Error('exit_auth_failed')
  if (!method) return
  const auth = readExactly(socket, 2, timeout)
  socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]))
  const result = await auth
  if (result[0] !== 1 || result[1] !== 0) throw new Error('exit_auth_failed')
}

const ipv6Targets = ['2001:4860:4860::8888', '2606:4700:4700::1111']

async function ipv6RouteInterface(host, os, run) {
  if (os === 'darwin') {
    const { stdout } = await run('/sbin/route', ['-n', 'get', '-inet6', host], { timeout: 1100, maxBuffer: 8192 })
    return stdout.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1] ?? null
  }
  if (os === 'win32') {
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Find-NetRoute -RemoteIPAddress '${host}' -ErrorAction Stop | Select-Object -First 1 -ExpandProperty InterfaceAlias`],
    { timeout: 2000, maxBuffer: 8192, windowsHide: true })
    return stdout.trim() || null
  }
  return null
}

function connectIPv6(host, localAddress) {
  return new Promise(resolve => {
    const socket = createConnection({ host, port: 443, localAddress, family: 6 })
    const finish = reachable => { socket.destroy(); resolve(reachable) }
    socket.setTimeout(1200)
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    socket.once('connect', () => finish(true))
  })
}

export async function inspectGlobalIPv6({ interfaces = networkInterfaces, run = execute, os = platform(),
  tunnelInterface, connect = connectIPv6 } = {}) {
  const candidates = new Map()
  for (const [name, addresses] of Object.entries(interfaces())) {
    if (name.toLowerCase() === tunnelInterface?.toLowerCase()) continue
    const address = addresses?.find(item => item.family === 'IPv6' && !item.internal
      && /^[23][a-f0-9]{3}:/i.test(item.address) && isIP(item.address) === 6)?.address
    if (address) candidates.set(name.toLowerCase(), address)
  }
  if (!candidates.size) return { present: false }
  const tested = await Promise.all(ipv6Targets.map(async host => {
    try {
      const outgoing = await ipv6RouteInterface(host, os, run)
      const source = outgoing && candidates.get(outgoing.toLowerCase())
      if (!source || !await connect(host, source)) return false
      return outgoing === await ipv6RouteInterface(host, os, run)
    } catch { return false }
  }))
  return { present: tested.includes(true) }
}

export async function globalIPv6Present(options) {
  return (await inspectGlobalIPv6(options)).present
}

export async function probeRelayPath(c, controller, credentials, report, { connect = connectTunnel } = {}) {
  const exitStart = Date.now()
  let socket, entryConfirmed = false
  try {
    if (c.relay.auth && !credentials) throw new Error('relay_credentials_unavailable')
    socket = await connect({ ...c, timeoutMs: 4000 }, `${c.relay.host}:${c.relay.port}`, c.relay.checkPort)
    socket.on('error', () => {})
    await checkSocks5(socket, credentials ?? { username: '', password: '' }, 2500, async () => {
      const connections = await controller.request('/connections', 'GET', undefined, { timeoutMs: 1200 })
      const row = connections.connections?.find(item => Number(item.metadata?.sourcePort) === socket.localPort
        && Number(item.metadata?.inboundPort) === c.relay.checkPort)
      if (!row?.chains?.includes(relayEntry) || row.chains.some(name => name !== relayEntry && !relayEntryMatches(c.relay, name)))
        throw new Error('exit_unreachable')
      entryConfirmed = true
      report('entry', { ok: true })
    })
    report('exit', { ok: true, durationMs: Date.now() - exitStart })
  } catch (error) {
    const durationMs = Date.now() - exitStart
    const failure = ['exit_auth_failed', 'relay_credentials_unavailable'].includes(error.message) ? error.message : 'exit_unreachable'
    let reason = failure
    if (!entryConfirmed && failure === 'exit_unreachable') {
      const started = Date.now()
      try {
        const entry = await controller.request('/proxies/' + encodeURIComponent(relayEntry) + '/delay?timeout=3000&url=' + encodeURIComponent(entryTestURL), 'GET', undefined, { timeoutMs: 3400 })
        if (!(Number.isFinite(entry?.delay) && entry.delay >= 0)) throw new Error()
        report('entry', { ok: true, durationMs: entry.delay })
      } catch {
        report('entry', { ok: false, durationMs: Date.now() - started })
        reason = 'entry_unavailable'
      }
    }
    report('exit', { ok: false, durationMs })
    throw new Error(reason)
  } finally { socket?.destroy() }
}
