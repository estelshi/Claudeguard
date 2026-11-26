import { isIP } from 'node:net'
import { normalizeRelay } from './relay.mjs'

export const EXPECTED_IP = '203.0.113.10'

// RFC 5737 documentation prefixes. These may be used as in-memory fixtures,
// but must not become a confirmed exit or a standalone profile name.
export function isDocumentationIPv4(value) {
  if (isIP(value) !== 4) return false
  const [a, b, c] = value.split('.').map(Number)
  return a === 192 && b === 0 && c === 2
    || a === 198 && b === 51 && c === 100
    || a === 203 && b === 0 && c === 113
}

export function isUsableExpectedIP(value) {
  return isIP(value) === 4 && !isDocumentationIPv4(value)
}
export const CLAUDE_DOMAINS = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com']
export const GOOGLE_AUTH_HOSTS = ['accounts.google.com', 'google.com', 'www.google.com']

export const DEFAULT_CONFIG = Object.freeze({
  expectedIP: EXPECTED_IP,
  controllerSocket: '/tmp/verge/verge-mihomo.sock',
  controllerURL: '',
  controllerSecret: '',
  selectedProxy: '',
  coverageVersion: 0,
  targetPlatform: 'darwin',
  frozenExitProxy: '',
  frozenSources: [],
  upstreamBindings: {},
  upstreamChain: [],
  policyGroup: 'Claude-203.0.113.10',
  pinnedProxy: 'Claude-exit-pinned',
  pinnedEntry: 'Claude-entry-pinned',
  gatewayProxy: 'Claude-guard-gateway',
  gatewayPort: 17904,
  probePort: 17903,
  clientPort: 7901,
  serverPort: 17891,
  intervalMs: 3000,
  timeoutMs: 10000,
  leaseMs: 20000,
  recoverySamples: 3,
  deviceWide: false,
  // Opt-in DIRECT exception for UU Remote in the standalone pinned-exit profile.
  allowUURemote: false,
  publicTunExit: false,
  publicProxyExit: false,
  kernelProcessPath: '',
  requireTun: false,
  guardGoogleAuth: true,
  proxyUser: 'claude-guard',
  proxyPassword: '',
  // Opt-in destination restriction for the dedicated Claude gateway. An empty
  // list blocks everything; null preserves the existing general proxy behavior.
  gatewayAllowlist: null,
})

// Proxy backend. Absent means 'mihomo' (Clash Verge / Mihomo); existing
// configurations never carry the key and keep their exact contract.
export const BACKEND_KINDS = Object.freeze(['mihomo', 'singbox'])
export const SINGBOX_DEFAULTS = Object.freeze({ gatewayRemark: 'GuardNookShare-Gateway', probeInbound: 'socks2' })
const SINGBOX_RESERVED = ['proxy', 'direct', 'block', 'dns', 'dns-out', 'direct-out', 'block-out', 'GLOBAL', 'DIRECT', 'REJECT']
export function normalizeSingboxOptions(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid sing-box options')
  const name = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n,\0]/.test(value)
  const exitRemark = typeof input.exitRemark === 'string' ? input.exitRemark.trim() : ''
  const gatewayRemark = input.gatewayRemark === undefined ? SINGBOX_DEFAULTS.gatewayRemark : input.gatewayRemark
  const probeInbound = input.probeInbound === undefined ? SINGBOX_DEFAULTS.probeInbound : input.probeInbound
  const configPath = input.configPath === undefined ? '' : input.configPath
  if (!name(exitRemark) || !name(gatewayRemark) || exitRemark === gatewayRemark
    || SINGBOX_RESERVED.includes(exitRemark) || SINGBOX_RESERVED.includes(gatewayRemark)
    || /^(?:GuardNookShare-|GN-)/i.test(exitRemark))
    throw new Error('Invalid sing-box exit or gateway name')
  // The probe inbound must be a dedicated loopback inbound. The main mixed
  // inbound or TUN would route every application to the fixed exit.
  if (typeof probeInbound !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(probeInbound) || ['socks', 'tun', 'mixed', 'http'].includes(probeInbound))
    throw new Error('Invalid sing-box probe inbound')
  if (typeof configPath !== 'string' || configPath.length > 1024 || /[\r\n\0]/.test(configPath)
    || configPath && (!/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(configPath) || !/\.json$/i.test(configPath)))
    throw new Error('Invalid sing-box configuration path')
  return Object.freeze({ exitRemark, gatewayRemark, probeInbound, configPath })
}

export function validateConfig(input = {}) {
  const c = { ...DEFAULT_CONFIG, ...input }
  if (c.backendKind !== undefined && !BACKEND_KINDS.includes(c.backendKind)) throw new Error('Unsupported proxy backend')
  if (c.backendKind === 'singbox') {
    if (typeof c.controllerURL !== 'string' || !c.controllerURL) throw new Error('sing-box requires a loopback controller URL')
    c.singbox = normalizeSingboxOptions(c.singbox)
  } else if (c.singbox !== undefined) throw new Error('sing-box options require the sing-box backend')
  if (c.gatewayAllowlist !== null) {
    if (!Array.isArray(c.gatewayAllowlist) || c.gatewayAllowlist.length > 64
      || c.gatewayAllowlist.some(host => typeof host !== 'string' || host.length > 253
        || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
        || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')))
      throw new Error('Invalid gateway destination allowlist')
    c.gatewayAllowlist = Object.freeze([...new Set(c.gatewayAllowlist)])
  }
  if (!['darwin', 'win32'].includes(c.targetPlatform)) throw new Error('Unsupported target platform')
  if (typeof c.publicTunExit !== 'boolean' || typeof c.publicProxyExit !== 'boolean') throw new Error('Invalid public egress setting')
  if (typeof c.kernelProcessPath !== 'string' || (c.kernelProcessPath &&
    (!/^\/(?:[^/]+\/)+(?:verge-mihomo|mihomo|clash-meta)$/.test(c.kernelProcessPath)
      || /[\r\n\0,]/.test(c.kernelProcessPath) || c.kernelProcessPath.split('/').some(x => x === '..' || x === '.'))))
    throw new Error('Invalid proxy kernel path')
  if (typeof c.deviceWide !== 'boolean') throw new Error('Invalid device-wide option')
  if (typeof c.requireTun !== 'boolean') throw new Error('Invalid TUN requirement')
  if (typeof c.allowUURemote !== 'boolean') throw new Error('Invalid UU Remote exception setting')
  if (typeof c.guardGoogleAuth !== 'boolean') throw new Error('Invalid Google authentication routing')
  if (![0, 1].includes(c.coverageVersion)) throw new Error('Unsupported coverage version')
  if (isIP(c.expectedIP) !== 4)
    throw new Error('Expected exit must be an IPv4 address')
  for (const k of ['gatewayPort', 'probePort', 'clientPort', 'serverPort']) {
    if (!Number.isInteger(c[k]) || c[k] < 1024 || c[k] > 65535)
      throw new Error(`Invalid ${k}`)
  }
  if (new Set([c.gatewayPort, c.probePort, c.clientPort, c.serverPort]).size !== 4)
    throw new Error('Gateway, probe, client and dashboard ports must differ')
  for (const k of ['policyGroup', 'pinnedProxy', 'pinnedEntry', 'gatewayProxy']) {
    if (typeof c[k] !== 'string' || !c[k] || /[\r\n,]/.test(c[k]))
      throw new Error(`Invalid ${k}`)
  }
  if (new Set([c.policyGroup, c.pinnedProxy, c.gatewayProxy]).size !== 3
    || [c.policyGroup, c.pinnedProxy, c.gatewayProxy].some(x => ['DIRECT', 'REJECT', 'GLOBAL'].includes(x)))
    throw new Error('Proxy and policy names must differ')
  if (typeof c.controllerURL !== 'string') throw new Error('Invalid controller URL')
  if (c.controllerURL) {
    const url = new URL(c.controllerURL)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.port)
      throw new Error('Controller must be a loopback HTTP address with an explicit port')
    c.controllerURL = url.origin
  } else if (typeof c.controllerSocket !== 'string' || !c.controllerSocket.startsWith('/') || /[\r\n\0]/.test(c.controllerSocket))
    throw new Error('An absolute local controller socket is required')
  if (typeof c.controllerSecret !== 'string' || /[\r\n\0]/.test(c.controllerSecret) || c.controllerSecret.length > 1024)
    throw new Error('Invalid controller secret')
  const validName = name => typeof name === 'string' && name.length > 0 && name.length <= 200 && !/[\r\n,\0]/.test(name)
  if (c.frozenExitProxy && (!validName(c.frozenExitProxy) || ['DIRECT', 'REJECT', 'GLOBAL', c.pinnedProxy, c.gatewayProxy].includes(c.frozenExitProxy))) throw new Error('Invalid frozen exit')
  if (!Array.isArray(c.frozenSources) || c.frozenSources.length > 9 || c.frozenSources.some(name => !validName(name))) throw new Error('Invalid frozen sources')
  if (!c.upstreamBindings || typeof c.upstreamBindings !== 'object' || Array.isArray(c.upstreamBindings)
    || Object.entries(c.upstreamBindings).some(([group, selected]) => !validName(group) || !validName(selected))) throw new Error('Invalid upstream bindings')
  if (c.frozenExitProxy && (c.frozenSources[0] !== c.selectedProxy || c.frozenSources.length !== c.upstreamChain.length + 1)) throw new Error('Incomplete frozen chain')
  if (c.selectedProxy && (!validName(c.selectedProxy) || [c.policyGroup, c.pinnedProxy, c.gatewayProxy, 'DIRECT', 'REJECT', 'GLOBAL'].includes(c.selectedProxy)))
    throw new Error('Select a distinct concrete upstream node')
  if (!Array.isArray(c.upstreamChain) || c.upstreamChain.length > 8
    || c.upstreamChain.some(name => !validName(name) || ['DIRECT', 'REJECT', 'GLOBAL', c.gatewayProxy].includes(name)))
    throw new Error('Invalid pinned upstream chain')
  c.upstreamChain = Object.freeze([...new Set(c.upstreamChain)])
  for (const k of ['intervalMs', 'timeoutMs', 'leaseMs']) {
    if (!Number.isInteger(c[k]) || c[k] < 100 || c[k] > 60000)
      throw new Error(`Invalid ${k}`)
  }
  if (c.leaseMs < c.timeoutMs || c.leaseMs > 30000)
    throw new Error('Lease must be bounded and at least the probe timeout')
  if (!Number.isInteger(c.recoverySamples) || c.recoverySamples < 2 || c.recoverySamples > 10)
    throw new Error('Recovery requires 2–10 consecutive samples')
  if (c.proxyUser !== 'claude-guard' || typeof c.proxyPassword !== 'string'
    || (c.proxyPassword && !/^[a-f0-9]{64}$/.test(c.proxyPassword)))
    throw new Error('Invalid local proxy credentials')
  return Object.freeze(c)
}

export function isClaudeHost(host = '') {
  const h = host.toLowerCase().replace(/\.$/, '')
  return CLAUDE_DOMAINS.some(d => h === d || h.endsWith(`.${d}`))
}

export const SHARE_IDENTITY = Object.freeze({
  policyGroup: 'GuardNookShare-Claude',
  pinnedProxy: 'GuardNookShare-Pinned',
  pinnedEntry: 'GuardNookShare-Entry',
  gatewayProxy: 'GuardNookShare-Gateway',
  serverPort: 19791,
  clientPort: 19901,
  probePort: 19903,
  gatewayPort: 19904,
})

export function hasPersonalRoute(proxies) {
  return Object.keys(proxies || {}).some(name =>
    /^GuardNook-/.test(name) || /^Claude-(?:guard-gateway|exit-pinned|entry-pinned|\d+\.)/.test(name))
}

export function validateShareConfig(input) {
  const relay = input.relay == null ? undefined : normalizeRelay(input.relay)
  const usesLegacyRelayTiming = relay
    && (input.timeoutMs === undefined || input.timeoutMs === DEFAULT_CONFIG.timeoutMs)
    && (input.leaseMs === undefined || input.leaseMs === DEFAULT_CONFIG.leaseMs)
  const relayTiming = usesLegacyRelayTiming ? { timeoutMs: 20000, leaseMs: 30000 } : {}
  const config = validateConfig({ ...input, ...(relay ? { relay } : {}), ...relayTiming })
  if (config.serviceMode !== undefined || config.ownedProtection
    || ['policyGroup', 'pinnedProxy', 'pinnedEntry', 'gatewayProxy'].some(key => config[key] !== SHARE_IDENTITY[key]))
    throw new Error('ClaudeGuard does not accept personal or external guard configurations')
  if (config.deviceWide && (!relay || !config.requireTun || config.clientID !== 'verge'))
    throw new Error('整机固定出口需要 Clash Verge Rev、SOCKS5 中转和 TUN。')
  const personalPorts = [7901, 17891, 17903, 17904, 18791, 18901, 18903, 18904]
  if (['serverPort', 'clientPort', 'probePort', 'gatewayPort'].some(key => personalPorts.includes(config[key])))
    throw new Error('This port is reserved for the personal edition')
  if (config.backendKind === 'singbox' && (relay || config.deviceWide || config.coverageVersion !== 0 || config.frozenExitProxy
    || config.upstreamChain.length || config.publicTunExit || config.publicProxyExit || config.selectedProxy !== config.singbox.exitRemark))
    throw new Error('v2rayN / sing-box 目前只支持「已有固定出口节点」方式。')
  if (relay && (config.selectedProxy !== 'GN-Exit' || config.coverageVersion !== 1 || config.frozenExitProxy
    || config.upstreamChain.length || config.ownedProtection || config.publicTunExit || config.publicProxyExit
    || [config.serverPort, config.clientPort, config.probePort, config.gatewayPort].includes(relay.checkPort)
    || !relay.confirmed && config.startProtected))
    throw new Error('Invalid relay integration')
  return config
}
