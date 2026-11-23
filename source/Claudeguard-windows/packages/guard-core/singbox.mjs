// sing-box backend adapter (v2rayN with the sing-box core, or plain sing-box).
//
// sing-box exposes a Clash-compatible API through experimental.clash_api, but it
// is not Mihomo: /rules payloads are sing-box rule String() values such as
// "domain_suffix=[claude.ai claude.com anthropic.com]" (lists longer than three
// are truncated with "..."), /rules proxies are rule actions such as
// "route(TAG)", /connections rows carry "type": "<inboundType>/<inboundTag>" and
// no inboundPort, and /configs has no TUN state. This adapter keeps the guard
// contract (fixed exit verified by the egress probe, local gateway lease as the
// only gate, fail closed) and only translates how the routing is read.
//
// Routing contract installed by the user (v2rayN routing rules, top of list):
//   1. inbound=<probeInbound> (v2rayN "socks2", the second loopback port)
//        → route(<exit node>)            private probe / gateway upstream path
//   2. domain_suffix / domain groups of at most three hosts each
//        → route(<gateway HTTP node>)    the ClaudeGuard gateway (127.0.0.1)
// When ClaudeGuard is closed, blocked or not yet verified, the gateway refuses
// every request, so Claude traffic routed by rule 2 cannot leave.
import { readFile as fsReadFile } from 'node:fs/promises'
import { CLAUDE_DOMAINS, GOOGLE_AUTH_HOSTS, SINGBOX_DEFAULTS } from './config.mjs'
import { tunRequiredRules } from './tun-connections.mjs'

export const SINGBOX_GATEWAY_REMARK = SINGBOX_DEFAULTS.gatewayRemark
export const SINGBOX_PROBE_INBOUND = SINGBOX_DEFAULTS.probeInbound
const GROUP_SIZE = 3 // sing-box prints at most three items before "...".
const MAX_CONFIG_BYTES = 8 * 1024 * 1024

export const isSingbox = c => c?.backendKind === 'singbox'
export const isSingboxVersion = value => /sing-box/i.test(String(value?.version ?? value ?? ''))

// v2rayN names the outbound of a routing-rule target "<indexId>-proxy-<remark>";
// plain sing-box uses the tag as written. A missing remark makes v2rayN fall back
// to its main "proxy" outbound, which therefore never matches.
export function singboxTagMatches(tag, remark) {
  return typeof tag === 'string' && typeof remark === 'string' && remark.length > 0
    && (tag === remark || tag.endsWith(`-proxy-${remark}`))
}
export function remarkFromTag(tag) {
  const match = /^[A-Za-z0-9]+-proxy-(.+)$/.exec(String(tag))
  return match ? match[1] : String(tag)
}
// "route(TAG)" or "route(TAG,options...)". Tags derived from validated remarks
// cannot contain commas.
export function routeTarget(action) {
  const value = String(action ?? '')
  if (!value.startsWith('route(') || !value.endsWith(')')) return null
  const inner = value.slice(6, -1).split(',')[0]
  return inner || null
}

export function singboxGuardHosts(c) {
  const tun = tunRequiredRules(c)
  const suffix = [...CLAUDE_DOMAINS, 'claudemcpcontent.com', ...tun.filter(r => r.startsWith('DOMAIN-SUFFIX,')).map(r => r.split(',')[1])]
  const exact = [...(c.guardGoogleAuth === false ? [] : GOOGLE_AUTH_HOSTS), ...tun.filter(r => r.startsWith('DOMAIN,')).map(r => r.split(',')[1])]
  return { suffix: [...new Set(suffix)], exact: [...new Set(exact)] }
}
const chunk = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size))
export function singboxRuleGroups(c) {
  const { suffix, exact } = singboxGuardHosts(c)
  return [...chunk(suffix, GROUP_SIZE).map(items => ({ key: 'domain_suffix', items })),
    ...chunk(exact, GROUP_SIZE).map(items => ({ key: 'domain', items }))]
}
export function singboxPayload({ key, items }) {
  return items.length === 1 ? `${key}=${items[0]}` : `${key}=[${items.join(' ')}]`
}
export function singboxExpectedRules(c) {
  return [{ payload: `inbound=${c.singbox.probeInbound}`, target: 'exit' },
    ...singboxRuleGroups(c).map(group => ({ payload: singboxPayload(group), target: 'gateway', group }))]
}

// Visible domain lists of one sing-box default rule payload, or null when the
// payload holds anything else (or a truncated list we cannot read in full).
function visibleDomains(payload) {
  const parts = String(payload).match(/(?:^|\s)(domain|domain_suffix)=(\[[^\]]*\]|\S+)/g)
  if (!parts || parts.join('').replace(/\s+/g, ' ').trim() !== String(payload).trim()) return null
  const out = { domain: [], domain_suffix: [] }
  for (const part of parts) {
    const [, key, raw] = /(domain|domain_suffix)=(.*)$/.exec(part.trim())
    if (raw.includes('...')) return null
    const items = raw.startsWith('[') ? raw.slice(1, -1).split(' ').filter(Boolean) : [raw]
    out[key].push(...items)
  }
  return out
}
const SAFE_PREFIX = [/^clash_mode=\S+$/, /^network=icmp$/, /^ip_is_private=true$/]
// A user rule placed before the ClaudeGuard rules is accepted only when it
// provably cannot match a guarded host: fully visible domain lists that do not
// cover any guarded host, or v2rayN's own fixed helpers. Anything else
// (keywords, regex, geosite, rule sets, ports, IP ranges, truncated lists)
// fails closed.
export function shadowsGuardedHost(rule, c) {
  const payload = String(rule?.payload ?? '')
  if (rule?.type === 'default' && SAFE_PREFIX.some(pattern => pattern.test(payload))) return false
  if (rule?.type === 'default' && /^process_path=/.test(payload) && !/claude|anthropic/i.test(payload) && !payload.includes('...')) return false
  const lists = rule?.type === 'default' ? visibleDomains(payload) : null
  if (!lists) return true
  const { suffix, exact } = singboxGuardHosts(c)
  const hosts = [...suffix, ...exact]
  return lists.domain_suffix.some(s => hosts.some(h => h === s || h.endsWith('.' + s) || s.endsWith('.' + h)))
    || lists.domain.some(d => hosts.includes(d) || suffix.some(s => d.endsWith('.' + s)))
}

function concreteOutbound(node) {
  const type = String(node?.type || '').toLowerCase()
  return !!node && !['selector', 'urltest', 'direct', 'block', 'dns', 'fallback', 'loadbalance'].includes(type) && !Array.isArray(node.all)
}

export function verifySingboxPolicy(snapshot, c) {
  const { configs, proxies, rules } = snapshot
  const sb = c.singbox
  if (String(configs?.mode || '').toLowerCase() !== 'rule') throw new Error('rule-mode-required')
  const list = Array.isArray(rules?.rules) ? rules.rules : []
  const all = proxies?.proxies || {}
  const expected = singboxExpectedRules(c)
  const found = expected.map(want => list.findIndex(rule => rule?.payload === want.payload))
  if (found.every(index => index < 0)) throw new Error('guard-route-not-installed')
  if (found.some(index => index < 0)) throw new Error('protected-rules-changed')
  let exitTag, gatewayTag
  for (const [i, want] of expected.entries()) {
    const rule = list[found[i]]
    const tag = routeTarget(rule.proxy)
    const remark = want.target === 'exit' ? sb.exitRemark : sb.gatewayRemark
    if (rule.type !== 'default' || !singboxTagMatches(tag, remark) || !Object.hasOwn(all, tag)) throw new Error('protected-rules-changed')
    if (want.target === 'exit') {
      if (!concreteOutbound(all[tag]) || singboxTagMatches(tag, sb.gatewayRemark)) throw new Error('frozen-chain-changed')
      exitTag = tag
    } else {
      if (String(all[tag]?.type || '').toLowerCase() !== 'http') throw new Error('guard-route-not-installed')
      if (gatewayTag && gatewayTag !== tag) throw new Error('protected-rules-changed')
      gatewayTag = tag
    }
  }
  // The probe inbound must be routed before any guarded host, otherwise the
  // gateway's own upstream request would loop back into the gateway.
  const probeIndex = found[0], last = Math.max(...found.slice(1))
  if (probeIndex > Math.min(...found.slice(1))) throw new Error('protected-rules-changed')
  const ours = new Set(found)
  for (let index = 0; index < last; index++) {
    if (ours.has(index)) continue
    const rule = list[index], target = routeTarget(rule?.proxy)
    if (target === null) continue // reject / sniff / hijack-dns / resolve / route-options
    if (singboxTagMatches(target, sb.gatewayRemark)) continue
    if (shadowsGuardedHost(rule, c)) throw new Error('protected-rules-changed')
  }
  return { exitTag, gatewayTag }
}

// The generated sing-box configuration file holds the only TUN evidence. Use it
// only when it is the file of the controller we are talking to.
export async function readSingboxFile(path, readFile = fsReadFile) {
  if (!path) return null
  try {
    const text = await readFile(path, 'utf8')
    if (typeof text !== 'string' || text.length > MAX_CONFIG_BYTES) return null
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch { return null }
}
export function controllerFromFile(file) {
  const raw = file?.experimental?.clash_api?.external_controller
  const match = typeof raw === 'string' && raw.trim().match(/^(?:https?:\/\/)?(\[[^\]]+\]|[^:/]*):(\d{1,5})\/?$/)
  if (!match || !['', '0.0.0.0', '127.0.0.1', 'localhost', '[::1]', '[::]'].includes(match[1])) return null
  const port = Number(match[2])
  return port > 0 && port <= 65535 ? `http://127.0.0.1:${port}` : null
}
export function tunFromFile(file, controllerURL) {
  if (!file || !Array.isArray(file.inbounds)) return null
  if (controllerURL && controllerFromFile(file) !== new URL(controllerURL).origin) return null
  return file.inbounds.some(inbound => inbound?.type === 'tun')
}
export async function singboxTunState(c, { readFile = fsReadFile, controllerURL = c.controllerURL } = {}) {
  return tunFromFile(await readSingboxFile(c.singbox?.configPath, readFile), controllerURL)
}

export async function readSingboxPolicy(controller, c, options, readFile) {
  const [configs, proxies, rules] = await Promise.all(['/configs', '/proxies', '/rules']
    .map(path => controller.request(path, 'GET', undefined, options)))
  const tun = await singboxTunState(c, { readFile, controllerURL: controller.url?.() || c.controllerURL })
  return { configs, proxies, rules, tun }
}

// Probe rows: our own loopback source port into the private probe inbound,
// routed only through the configured exit node.
export function validateSingboxProbeChain(connections, c, sourcePort, host) {
  const sb = c.singbox
  const row = connections?.connections?.find(x => Number(x.metadata?.sourcePort) === sourcePort
    && x.metadata?.host === host && String(x.metadata?.type || '').endsWith(`/${sb.probeInbound}`))
  if (!row || !Array.isArray(row.chains) || !row.chains.length || !row.chains.every(tag => singboxTagMatches(tag, sb.exitRemark)))
    throw new Error('Probe route is not the pinned chain')
  return row.chains
}
export const singboxGatewayRow = (row, c) => Array.isArray(row?.chains) && row.chains.some(tag => singboxTagMatches(tag, c.singbox.gatewayRemark))

// Catalogue of outbounds the controller exposes. v2rayN only builds outbounds
// for the active node and for nodes routing rules point at, so this is a hint
// list; the user types the exit node's remark.
export function singboxCatalogue(snapshot) {
  return Object.entries(snapshot?.proxies || {}).flatMap(([tag, node]) => {
    if (!concreteOutbound(node) || ['proxy', 'GLOBAL'].includes(tag) || /[\r\n,\0]/.test(tag)) return []
    const name = remarkFromTag(tag)
    if (!name || /^(?:GuardNookShare-|GN-)/i.test(name) || String(node.type).toLowerCase() === 'http' && name === SINGBOX_GATEWAY_REMARK) return []
    return [{ name, tag, type: node.type, udp: node.udp === true, upstreamChain: [] }]
  }).sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- Templates ----------
// v2rayN routing rules (RulesItem JSON, importable from the clipboard in the
// routing rule list). "domain:" becomes domain_suffix, "full:" becomes domain.
export function v2raynRules(c) {
  const sb = c.singbox
  return [
    { remarks: 'ClaudeGuard 探测与网关上游 → 固定出口', outboundTag: sb.exitRemark, inboundTag: [sb.probeInbound], enabled: true },
    ...singboxRuleGroups(c).map((group, i) => ({
      remarks: `ClaudeGuard 守护 ${i + 1}`, outboundTag: sb.gatewayRemark,
      domain: group.items.map(host => (group.key === 'domain' ? 'full:' : 'domain:') + host), enabled: true })),
  ]
}
export function singboxSnippet(c, { includePassword = false } = {}) {
  const sb = c.singbox
  const password = includePassword ? c.proxyPassword : '<在 ClaudeGuard 第 3 步复制网关密码>'
  return {
    inbounds: [{ type: 'mixed', tag: sb.probeInbound, listen: '127.0.0.1', listen_port: c.probePort,
      users: [{ username: c.proxyUser, password }] }],
    outbounds: [{ type: 'http', tag: sb.gatewayRemark, server: '127.0.0.1', server_port: c.gatewayPort,
      username: c.proxyUser, password }],
    route: { rules: singboxExpectedRules(c).map(rule => rule.target === 'exit'
      ? { inbound: [sb.probeInbound], outbound: sb.exitRemark }
      : { [rule.group.key]: rule.group.items, outbound: sb.gatewayRemark }) },
    experimental: { clash_api: { external_controller: new URL(c.controllerURL).host, secret: c.controllerSecret ? '<保持你现有的 secret>' : '' } },
  }
}
export function gatewayNode(c) {
  return { remarks: c.singbox.gatewayRemark, type: 'HTTP', address: '127.0.0.1', port: c.gatewayPort, username: c.proxyUser }
}
