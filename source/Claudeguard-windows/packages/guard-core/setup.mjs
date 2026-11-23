import { mkdir, readFile, writeFile, rename, lstat, chmod } from 'node:fs/promises'
import { randomBytes, randomInt } from 'node:crypto'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './entry.mjs'
import { Script } from 'node:vm'
import { validateShareConfig, hasPersonalRoute, DEFAULT_CONFIG, SHARE_IDENTITY } from './config.mjs'
import { createController } from './controller.mjs'
import { composeProfileScript } from './profile.mjs'
import { desktopRoot } from './desktop-common.mjs'
import { clientAdapter, localEndpoints } from './clients.mjs'
import { measureSetup, verifySetupConfirmation } from './setup-probe.mjs'
import { normalizeRelay, normalizeSocks5, parseSocks5Link, relayEntryMatches, relayExit } from './relay.mjs'
import { disableSetupIPv6, changeSetupPreferences, readSetupEnvironment } from './setup-environment.mjs'
import { applyDeviceVerge, applyVergeScript, prepareDeviceVerge, originalBackup, readVergeState, restoreVergeScript, verifyVergeLoaded } from './verge.mjs'
import { installVergeProfile, standaloneStatus } from './verge-profile.mjs'
import { isSingboxVersion, singboxCatalogue, singboxSnippet, v2raynRules, gatewayNode } from './singbox.mjs'

export const PORTABLE_DEFAULTS = Object.freeze({
  targetPlatform: 'darwin', requireTun: false, guardGoogleAuth: true, clientID: 'verge',
  controllerSocket: DEFAULT_CONFIG.controllerSocket, controllerURL: '', controllerSecret: '',
  expectedIP: '', selectedProxy: '', upstreamChain: [],
  ...SHARE_IDENTITY,
})
const personalRouteError = script => Object.assign(
  new Error('Clash 正使用个人版或旧版守护规则。请换用独立测试配置；未写入任何文件。'),
  { code: 'personal-guard-conflict', script },
)
async function personalScriptHint(client, home = homedir()) {
  if (client !== 'verge') return null
  try {
    const file = join(home, 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/profiles/Script.js')
    const info = await lstat(file)
    if (info.isFile() && info.size <= 2 * 1024 * 1024 &&
        /__beforeGuardNookContainment|GuardNook-Gateway|Claude-guard-gateway/.test(await readFile(file, 'utf8')))
      return '全局扩展脚本（Script.js）'
  } catch {}
  return null
}
const types = new Set(['Direct', 'Reject', 'RejectDrop', 'Compatible', 'Pass', 'PassRule', 'Dns', 'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay'])
export function resolveUpstreamChain(snapshot, selected) {
  const chain = [], bindings = {}, seen = new Set()
  let name = selected
  while (name) {
    if (['DIRECT', 'REJECT', 'GLOBAL', 'Claude-guard-gateway', PORTABLE_DEFAULTS.gatewayProxy].includes(name))
      throw new Error('Upstream cannot be a bypass or guard gateway')
    if (seen.has(name)) throw new Error('Cyclic upstream chain')
    seen.add(name)
    const node = snapshot?.proxies?.[name]
    if (name !== selected && node?.type === 'Selector' && Array.isArray(node.all)) {
      if (typeof node.now !== 'string' || !node.all.includes(node.now)) throw new Error('Upstream selector has no concrete selection')
      bindings[name] = node.now
      name = node.now
      continue
    }
    if (!node || typeof node.type !== 'string' || types.has(node.type) || Array.isArray(node.all))
      throw new Error('Upstream must be a concrete node')
    if (name !== selected) chain.push(name)
    const next = node['dialer-proxy']
    if (next === undefined || next === '') break
    if (typeof next !== 'string' || !next || /[\r\n,\0]/.test(next) || chain.length >= 8)
      throw new Error('Invalid upstream chain')
    name = next
  }
  return { upstreamChain: chain, upstreamBindings: bindings }
}
export function detectUpstreamChain(snapshot, selected) {
  return resolveUpstreamChain(snapshot, selected).upstreamChain
}
export function nodeCatalogue(snapshot) {
  return Object.entries(snapshot?.proxies || {}).flatMap(([name, node]) => {
    if (!name || hasPersonalRoute({ [name]: true }) || /^(?:GuardNookShare-|GN-)/i.test(name) || /[\r\n,\0]/.test(name) || ['DIRECT', 'REJECT', 'GLOBAL', 'COMPATIBLE'].includes(name)
      || !node || typeof node.type !== 'string' || types.has(node.type) || Array.isArray(node.all)) return []
    try {
      const resolved = resolveUpstreamChain(snapshot, name)
      return [{ name, type: node.type, udp: node.udp === true, upstreamChain: resolved.upstreamChain,
        ...(Object.keys(resolved.upstreamBindings).length ? { upstreamBindings: resolved.upstreamBindings } : {}) }]
    }
    catch { return [{ name, type: node.type, udp: node.udp === true, upstreamChain: [], chainError: '上游链路包含自动切换组、缺失节点或循环，请选择固定的具体链路。' }] }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
export function portableConfig(input, password) {
  if (input.startProtected !== undefined && typeof input.startProtected !== 'boolean') throw new Error('Invalid startup preference')
  const fields = {}
  for (const key of Object.keys(PORTABLE_DEFAULTS)) if (input[key] !== undefined) fields[key] = input[key]
  return validateShareConfig({ ...PORTABLE_DEFAULTS, ...fields, startProtected: input.startProtected === true, proxyPassword: password })
}
export async function catalogue(input) {
  if (input.backendKind === 'singbox') return singboxSetupCatalogue(input)
  // Reading a catalogue does not verify or select any route.
  const c = portableConfig({ ...input, expectedIP: input.expectedIP || '203.0.113.1', selectedProxy: '' }, '')
  const controller = createController(c)
  const [version, snapshot] = await Promise.all([controller.request('/version'), controller.request('/proxies')])
  if (typeof version?.version !== 'string' || !snapshot?.proxies || typeof snapshot.proxies !== 'object')
    throw new Error('Not a Clash controller')
  // A sing-box clash_api answers the same paths with different rule semantics.
  if (isSingboxVersion(version)) throw new Error('这是 sing-box 内核（例如 v2rayN），请在第 1 步选择「v2rayN（sing-box 内核）」。')
  const adapter = clientAdapter(input.clientID || 'verge')
  const personalRoutePresent = hasPersonalRoute(snapshot.proxies)
  if (!personalRoutePresent && snapshot.proxies[relayExit]?.type === 'Socks5') {
    const provider = await controller.request('/providers/proxies/gn-entry', 'GET', undefined, { timeoutMs: 2800 }).catch(() => null)
    if (provider?.vehicleType === 'File' && Array.isArray(provider.proxies)) {
      const members = provider.proxies.filter(node => typeof node?.name === 'string')
      snapshot.proxies = { ...Object.fromEntries(members.map(node => [node.name, node])), ...snapshot.proxies }
    }
  }
  return { clientID: adapter.id, clientTitle: adapter.title, integration: adapter.support, persistentTun: adapter.persistentTun, version: version.version,
    personalRoutePresent, ...(personalRoutePresent ? { personalScript: await personalScriptHint(adapter.id) } : {}),
    nodes: nodeCatalogue(snapshot) }
}
// ---------- sing-box (v2rayN with the sing-box core) ----------
const SINGBOX_CLIENT = Object.freeze({ clientID: 'v2rayn', clientTitle: 'v2rayN（sing-box 内核）' })
function singboxFields(input) {
  const fields = {}
  for (const key of ['controllerURL', 'controllerSecret', 'expectedIP', 'requireTun', 'guardGoogleAuth', 'serverPort', 'clientPort', 'probePort', 'gatewayPort'])
    if (input[key] !== undefined) fields[key] = input[key]
  return fields
}
export function singboxConfig(input, password) {
  if (input.startProtected !== undefined && typeof input.startProtected !== 'boolean') throw new Error('Invalid startup preference')
  const exitRemark = String(input.exitRemark ?? input.selectedProxy ?? '').trim()
  const singbox = { ...(input.singbox || {}), exitRemark,
    ...(typeof input.singboxConfigPath === 'string' ? { configPath: input.singboxConfigPath } : {}) }
  return validateShareConfig({ ...PORTABLE_DEFAULTS, clientPort: 10808, probePort: 10809, ...singboxFields(input),
    controllerSocket: '', targetPlatform: input.targetPlatform || PORTABLE_DEFAULTS.targetPlatform,
    clientID: SINGBOX_CLIENT.clientID, backendKind: 'singbox', singbox, selectedProxy: exitRemark,
    upstreamChain: [], coverageVersion: 0, startProtected: input.startProtected === true, proxyPassword: password })
}
export async function singboxSetupCatalogue(input) {
  // Read only: /version and /proxies. No selector, rule or file is changed.
  const c = singboxConfig({ ...input, expectedIP: input.expectedIP || '203.0.113.1', exitRemark: 'catalogue-only' }, '')
  const controller = createController(c)
  const [version, snapshot] = await Promise.all([controller.request('/version'), controller.request('/proxies')])
  if (typeof version?.version !== 'string' || !snapshot?.proxies || typeof snapshot.proxies !== 'object')
    throw new Error('Not a sing-box controller')
  if (!isSingboxVersion(version)) throw new Error('这是 Mihomo / Clash 内核，请在第 1 步选择「Clash Verge / Mihomo」。')
  return { ...SINGBOX_CLIENT, backendKind: 'singbox', integration: '路由规则手动导入', persistentTun: false,
    version: version.version, personalRoutePresent: false, nodes: singboxCatalogue(snapshot) }
}
export async function saveSingboxSetup(root, input, readCatalogue = catalogue) {
  let previous
  try { previous = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing configuration is unreadable; it was preserved') }
  if (previous) validateShareConfig(previous)
  const c = singboxConfig(input, previous?.proxyPassword || randomBytes(32).toString('hex'))
  const [a, b] = c.expectedIP.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127)
    throw new Error('Expected exit must be a public IPv4 address')
  // Confirms the controller is a reachable sing-box before anything is written.
  await readCatalogue({ ...c, backendKind: 'singbox' })
  return saveGeneratedSingbox(root, c)
}
async function saveGeneratedSingbox(root, c) {
  const rules = JSON.stringify(v2raynRules(c), null, 2)
  const snippet = JSON.stringify(singboxSnippet(c), null, 2) // no gateway password inside
  await privateDirectory(root)
  await privateDirectory(join(root, 'Profiles'))
  const generation = join(root, 'Profiles', new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex'))
  await privateDirectory(generation)
  await writeFile(join(generation, 'v2rayN-rules.json'), rules, { mode: 0o600, flag: 'wx' })
  await writeFile(join(generation, 'sing-box-snippet.json'), snippet, { mode: 0o600, flag: 'wx' })
  await writeFile(join(generation, 'config.json'), JSON.stringify(c, null, 2), { mode: 0o600, flag: 'wx' })
  const manifest = { version: 1, kind: 'singbox', configuredAt: Date.now(),
    scriptPath: join(generation, 'v2rayN-rules.json'), snippetPath: join(generation, 'sing-box-snippet.json') }
  await atomicPrivate(join(root, 'SETUP.json'), JSON.stringify(manifest, null, 2))
  await atomicPrivate(join(root, 'config.json'), JSON.stringify(c, null, 2))
  return { saved: true, backendKind: 'singbox', scriptPath: manifest.scriptPath, snippetPath: manifest.snippetPath,
    serverPort: c.serverPort, expectedIP: c.expectedIP, selectedProxy: c.selectedProxy, gateway: gatewayNode(c) }
}

export async function discover(input, readCatalogue = catalogue) {
  // Only known local endpoints; no config files, passwords, routes or selectors are changed.
  // A user-supplied credential belongs to the explicitly selected endpoint.
  // Never broadcast it across automatic discovery candidates.
  if (input.controllerSecret) return { ...await readCatalogue(input), controllerSocket: input.controllerSocket || '', controllerURL: input.controllerURL || '', clientID: input.clientID || 'verge' }
  const endpoints = await localEndpoints(input)
  // Preserve the legacy discovery ordering for existing integrations and tests.
  if (!input.clientID) endpoints.splice(0, endpoints.length,
    { controllerSocket: PORTABLE_DEFAULTS.controllerSocket, controllerURL: '' },
    { controllerSocket: '', controllerURL: 'http://127.0.0.1:9090' })
  for (const endpoint of endpoints) {
    try { return { ...await readCatalogue({ ...input, ...endpoint }), ...endpoint } } catch {}
  }
  throw new Error('No local Clash controller found')
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Configuration directory must not be a symlink')
  await chmod(path, 0o700)
}
async function atomicPrivate(path, data) {
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error('Private configuration must be a regular file') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path + '.' + randomBytes(8).toString('hex') + '.tmp'
  await writeFile(temporary, data, { mode: 0o600, flag: 'wx' })
  await rename(temporary, path)
}
export async function saveSetup(root, input, readCatalogue = catalogue) {
  clientAdapter(input.clientID || 'verge')
  let previous
  try { previous = JSON.parse(await readFile(join(root, 'config.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Existing configuration is unreadable; it was preserved') }
  if (previous) validateShareConfig(previous)
  let c = portableConfig(input, previous?.proxyPassword || randomBytes(32).toString('hex'))
  if (!c.selectedProxy) throw new Error('Choose a Clash node first')
  const [a, b] = c.expectedIP.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254
    || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127)
    throw new Error('Expected exit must be a public IPv4 address')
  const { nodes, personalRoutePresent, personalScript } = await readCatalogue(c)
  if (personalRoutePresent) throw personalRouteError(personalScript)
  let node = nodes.find(n => n.name === c.selectedProxy)
  if (!node) throw new Error('Selected node is no longer available')
  if (node.chainError) throw new Error('Selected node has an unsafe upstream chain')
  if (input.fixedUpstreams && Object.keys(input.fixedUpstreams).length) {
    const entries = Object.entries(input.fixedUpstreams)
    if (entries.length !== 1) throw new Error('请只选择一个具体的第一跳入口。')
    const [group, name] = entries[0], upstream = nodes.find(n => n.name === name)
    if (!Object.hasOwn(node.upstreamBindings || {}, group)) throw new Error('固定上游分组与所选节点不匹配，请重新选择固定上游。')
    if (!upstream) throw new Error('所选固定上游已不存在，订阅可能已更新或节点已改名，请重新选择固定上游。')
    if (upstream.chainError) throw new Error('固定上游链路包含自动切换组、缺失节点或循环，请更换固定上游。')
    if (name === c.selectedProxy) throw new Error('固定上游不能与固定出口是同一节点。')
    if (node.upstreamChain[0] !== node.upstreamBindings[group]) throw new Error('固定上游与所选节点当前的入口绑定不一致，请重新读取节点后再保存。')
    if (upstream.upstreamChain.includes(c.selectedProxy)) throw new Error('固定上游链路不能经过固定出口节点，请更换固定上游。')
    node = { ...node, upstreamChain: [name, ...upstream.upstreamChain], upstreamBindings: { ...upstream.upstreamBindings, [group]: name } }
  }
  await verifySetupConfirmation(root, { ...input, resolvedUpstream: node.upstreamChain || [] })
  c = portableConfig({ ...c, upstreamChain: [...new Set([...(node.upstreamChain || []), ...c.upstreamChain])] }, c.proxyPassword)
  // Never read a script from a path supplied by a web request. The native file
  // picker sends the chosen text over a private stdin pipe.
  const original = typeof input.originalScript === 'string' && input.originalScript.trim()
    ? input.originalScript : 'function main(config) { return config; }'
  if (original.length > 2 * 1024 * 1024) throw new Error('Clash script is too large')
  c = { ...c, coverageVersion: 1 }
  if (Object.keys(node.upstreamBindings || {}).length) {
    c = validateShareConfig({ ...c, frozenExitProxy: 'GuardNookShare-FrozenExit', frozenSources: [c.selectedProxy, ...node.upstreamChain],
      upstreamBindings: node.upstreamBindings,
      upstreamChain: node.upstreamChain.map((_, i) => `GuardNookShare-FrozenUpstream-${i + 1}`) })
  }
  return saveGenerated(root, original, c)
}

async function saveGenerated(root, original, c, credentials) {
  const script = composeProfileScript(original, c, credentials)
  new Script(script) // Parse only; do not execute a user's Clash extension here.
  await privateDirectory(root)
  await privateDirectory(join(root, 'Profiles'))
  const generation = join(root, 'Profiles', new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomBytes(4).toString('hex'))
  await privateDirectory(generation)
  await writeFile(join(generation, 'original.js'), original, { mode: 0o600, flag: 'wx' })
  await writeFile(join(generation, 'GuardNook-Clash.js'), script, { mode: 0o600, flag: 'wx' })
  await writeFile(join(generation, 'config.json'), JSON.stringify(c, null, 2), { mode: 0o600, flag: 'wx' })
  const manifest = { version: 1, configuredAt: Date.now(), scriptPath: join(generation, 'GuardNook-Clash.js'), originalPath: join(generation, 'original.js') }
  await atomicPrivate(join(root, 'SETUP.json'), JSON.stringify(manifest, null, 2))
  // Both generated files already exist when the active configuration changes.
  await atomicPrivate(join(root, 'config.json'), JSON.stringify(c, null, 2))
  return { saved: true, scriptPath: manifest.scriptPath, serverPort: c.serverPort, expectedIP: c.expectedIP, selectedProxy: c.selectedProxy }
}

export async function saveRelay(root, input, readCatalogue = catalogue) {
  if (input.confirmChanges !== true) throw new Error('请确认在独立 Clash 测试配置中接入中转。')
  const exit = normalizeSocks5(input.exit)
  const base = portableConfig({ ...input, expectedIP: '203.0.113.1', selectedProxy: relayExit, upstreamChain: [],
    guardGoogleAuth: false, startProtected: false }, randomBytes(32).toString('hex'))
  const configFile = join(root, 'config.json')
  let prior
  try {
    prior = JSON.parse(await readFile(configFile, 'utf8'))
    validateShareConfig(prior)
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('已有配置不可读，未覆盖。')
  }
  // Re-saving the same relay must not discard a verified exit or rotate its probe port.
  const kept = typeof input.relayID === 'string' && prior?.relay?.id === input.relayID
    && prior.relay.host === exit.host && prior.relay.port === exit.port
  const reserved = [base.serverPort, base.clientPort, base.probePort, base.gatewayPort, exit.port]
  let checkPort = kept && Number.isInteger(prior.relay.checkPort) && !reserved.includes(prior.relay.checkPort)
    ? prior.relay.checkPort : 0
  while (!checkPort || reserved.includes(checkPort)) checkPort = randomInt(20000, 30000)
  const relay = normalizeRelay({ ...input.entry, id: input.relayID, host: exit.host, port: exit.port,
    auth: kept ? prior.relay.auth : Boolean(exit.username), confirmed: kept && prior.relay.confirmed === true, checkPort })
  const { nodes, personalRoutePresent, personalScript } = await readCatalogue(base)
  if (personalRoutePresent) throw personalRouteError(personalScript)
  const matches = nodes.filter(node => !node.chainError && !node.upstreamChain?.length && relayEntryMatches(relay, node.name))
  if (!matches.length || relay.nodes.some(name => !matches.some(node => node.name === name)))
    throw new Error('没有可用的入口节点。请刷新 Clash 节点后重新选择。')
  const original = typeof input.originalScript === 'string' && input.originalScript.trim()
    ? input.originalScript : 'function main(config) { return config; }'
  if (original.length > 2 * 1024 * 1024) throw new Error('原始扩展脚本太大。')
  const config = validateShareConfig({ ...base, coverageVersion: 1, relay, deviceWide: input.deviceWide === true, requireTun: input.deviceWide === true || base.requireTun })
  const result = await saveGenerated(root, original, config, { username: exit.username, password: exit.password })
  return { ...result, expectedIP: null, relayID: relay.id }
}

async function readRelayStatus(c) {
  const response = await fetch(`http://127.0.0.1:${c.serverPort}/api/claude-guard/status`, { redirect: 'error', signal: AbortSignal.timeout(2000) })
  if (!response.ok) throw new Error('尚未获取中转测试结果。')
  return response.json()
}

export async function confirmRelay(root, input, readStatus = readRelayStatus) {
  const file = join(root, 'config.json')
  const c = validateShareConfig(JSON.parse(await readFile(file, 'utf8')))
  if (!c.relay || c.relay.confirmed || input.relayID !== c.relay.id || isIP(input.expectedIP) !== 4)
    throw new Error('请先完成最新中转配置的实测。')
  const status = await readStatus(c)
  if (!status) throw new Error('尚未获取中转测试结果。')
  if (status.policyGroup !== c.policyGroup || status.pinnedProxy !== c.pinnedProxy || status.relay?.id !== c.relay.id
    || status.reason !== 'relay-awaiting-confirmation' || status.last?.ip !== input.expectedIP
    || !Number.isFinite(status.last.verifiedAt) || Date.now() - status.last.verifiedAt > 20000 || status.last.verifiedAt > Date.now()
    || !['entry', 'exit', 'egress'].every(key => status.relay.stages?.[key]?.ok === true))
    throw new Error('实测结果已变化或过期，请重新检查再确认。')
  await atomicPrivate(file, JSON.stringify(validateShareConfig({ ...c, expectedIP: input.expectedIP,
    relay: { ...c.relay, confirmed: true }, startProtected: true }), null, 2))
  return { saved: true }
}
async function manifestFile(root) {
  try { return JSON.parse(await readFile(join(root, 'SETUP.json'), 'utf8')) }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('请先完成中转配置并生成脚本。')
    throw new Error('生成记录不可读，已停止操作。')
  }
}
async function generatedFile(root, key, name, label) {
  const manifest = await manifestFile(root)
  const value = typeof manifest?.[key] === 'string' ? resolve(manifest[key]) : ''
  const folder = resolve(root, 'Profiles')
  if (!value.startsWith(folder + sep) || !value.endsWith(`${sep}${name}`))
    throw new Error(`${label}的位置异常，已停止操作。`)
  const info = await lstat(value)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label}不是普通文件，已停止操作。`)
  if (info.size > 2 * 1024 * 1024) throw new Error(`${label}过大，已停止操作。`)
  return value
}
async function generatedScript(root) {
  return generatedFile(root, 'scriptPath', 'GuardNook-Clash.js', '生成脚本')
}
const currentScriptMarkers = ['入口选择', '出口选择', 'GN-Exit', 'GuardNookShare-Claude']
function embeddedOptions(script) {
  const match = /\n {2}const options = (\{.*\});\n {2}return /.exec(script)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}
// A script can carry the current group names but an older relay/profile snapshot.
// Compare what it embeds against config.json so a stale generation is rewritten too.
function scriptMatchesConfig(script, config) {
  if (!currentScriptMarkers.every(marker => script.includes(marker))) return false
  const options = embeddedOptions(script)
  if (!options) return !config.deviceWide
  const relay = config.relay || {}, embedded = options.relay || {}
  if (Boolean(options.deviceWide) !== config.deviceWide) return false
  if (options.expectedIP !== config.expectedIP) return false
  if (options.policyGroup !== config.policyGroup || options.pinnedProxy !== config.pinnedProxy) return false
  if (embedded.id !== relay.id || embedded.host !== relay.host || embedded.port !== relay.port) return false
  if (embedded.checkPort !== relay.checkPort) return false
  if (Boolean(embedded.auth) !== Boolean(relay.auth)) return false
  if (relay.auth && /applyRelayProfile\(value, options, null\)/.test(script)) return false
  return true
}
export async function refreshGeneratedScript(root, credentials, config) {
  // Older builds generated the relay groups under different names. Rewrite the
  // app-owned script from the preserved original before writing it into Verge.
  const scriptPath = await generatedScript(root)
  const current = await readFile(scriptPath, 'utf8')
  const c = config || await shareConfig(root)
  if (c && scriptMatchesConfig(current, c)) return current
  if (!c) throw new Error('已有配置不可读，未重新生成脚本。')
  if (!c) throw new Error('已有配置不可读，未重新生成脚本。')
  const originalPath = await generatedFile(root, 'originalPath', 'original.js', '原始脚本')
  const script = composeProfileScript(await readFile(originalPath, 'utf8'), c, credentials)
  new Script(script)
  await atomicPrivate(scriptPath, script)
  return script
}
async function shareConfig(root) {
  try { return validateShareConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))) }
  catch { return null }
}
async function vergeReport(home, loaded) {
  const state = await readVergeState(home)
  return { version: state.version, scriptPath: state.script, scriptExists: state.scriptExists,
    scriptSize: state.scriptSize, scriptSHA256: state.scriptSHA256, currentProfile: state.currentProfile,
    backupPath: await originalBackup(home), ...loaded }
}
async function command() {
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length > 3 * 1024 * 1024) throw new Error('Setup request too large')
  }
  const input = JSON.parse(text)
  if (input.operation === 'catalogue') return catalogue(input)
  if (input.operation === 'discover') return discover(input)
  if (input.operation === 'parse-socks5') return { exit: parseSocks5Link(input.link) }
  if (input.operation === 'save-relay') return saveRelay(desktopRoot(), input)
  if (input.operation === 'confirm-relay') return confirmRelay(desktopRoot(), input)
  if (['wizard-environment', 'wizard-ipv6-disable-all', 'wizard-preferences-preview', 'wizard-preferences-apply'].includes(input.operation)) {
    if (process.platform !== 'darwin') throw new Error('向导内的环境设置目前只支持 macOS。')
    const c = portableConfig({ ...input, expectedIP: '203.0.113.1', selectedProxy: '' }, '')
    const { personalRoutePresent, personalScript } = await catalogue(c)
    if (personalRoutePresent) throw personalRouteError(personalScript)
    if (input.operation === 'wizard-environment') return { environment: await readSetupEnvironment(createController(c)) }
    if (input.operation.startsWith('wizard-preferences-')) return changeSetupPreferences(input)
    return disableSetupIPv6(input)
  }
  if (input.operation === 'home-environment') {
    const c = await shareConfig(desktopRoot()) || portableConfig({ expectedIP: '203.0.113.1' }, '')
    return { environment: await readSetupEnvironment(createController(c), { allowOffline: true }) }
  }
  if (input.operation === 'verge-status') {
    const home = homedir(), root = desktopRoot(home)
    const config = await shareConfig(root)
    const loaded = config ? await verifyVergeLoaded({ config }) : { loaded: false, reason: 'no-config' }
    return { verge: { ...await vergeReport(home, loaded), standalone: await standaloneStatus(home) } }
  }
  if (input.operation === 'device-prepare') {
    const home = homedir(), root = desktopRoot(home)
    const before = await shareConfig(root)
    if (!before?.relay) throw new Error('请先保存 SOCKS5 中转配置。')
    const snapshot = await createController(before).request('/proxies')
    if (hasPersonalRoute(snapshot.proxies)) throw personalRouteError(await personalScriptHint('verge', home))
    await prepareDeviceVerge(home)
    return { saved: true }
  }
  if (input.operation === 'device-apply') {
    const home = homedir(), root = desktopRoot(home)
    const config = await shareConfig(root)
    if (!config?.relay) throw new Error('请先保存 SOCKS5 中转配置。')
    const active = validateShareConfig({ ...config, deviceWide: true, requireTun: true })
    const scriptText = await refreshGeneratedScript(root, input.relayCredentials, active)
    const result = await applyDeviceVerge({ home, scriptText })
    if (!config.deviceWide) await atomicPrivate(join(root, 'config.json'), JSON.stringify(active, null, 2))
    return { verge: result }
  }
  if (input.operation === 'profile-apply') {
    const home = homedir(), root = desktopRoot(home)
    const config = await shareConfig(root)
    if (!config?.relay) throw new Error('请先保存 SOCKS5 中转配置。')
    // A fresh relay cannot be measured before the GuardNook groups exist, so the
    // first apply trusts the relay's own IP and the guard verifies the real exit
    // after Clash restarts. Later applies keep the confirmed value.
    const confirmed = config.relay.confirmed === true
    const expectedIP = confirmed ? config.expectedIP : input.expectedIP
    if (isIP(expectedIP) !== 4) throw new Error('请先保存有效的固定出口 IPv4。')
    const active = validateShareConfig({ ...config, expectedIP, selectedProxy: relayExit, coverageVersion: 1, deviceWide: true, requireTun: true, startProtected: true, relay: { ...config.relay, confirmed: true } })
    const result = await installVergeProfile({ home, config: active, credentials: input.relayCredentials })
    if (!confirmed || !config.deviceWide || !config.startProtected || config.expectedIP !== expectedIP) await atomicPrivate(join(root, 'config.json'), JSON.stringify(active, null, 2))
    return { verge: { ...await vergeReport(home, { loaded: false, reason: 'reload-required' }), ...result } }
  }
  if (input.operation === 'verge-apply') {
    const home = homedir(), root = desktopRoot(home)
    const scriptText = await refreshGeneratedScript(root, input.relayCredentials)
    const result = await applyVergeScript({ home, scriptText })
    const config = await shareConfig(root)
    const loaded = config ? await verifyVergeLoaded({ config }) : { loaded: false, reason: 'no-config' }
    return { verge: { ...await vergeReport(home, loaded), ...result } }
  }
  if (input.operation === 'verge-restore') {
    const home = homedir()
    const result = await restoreVergeScript({ home })
    return { verge: { ...await vergeReport(home, { loaded: false, reason: 'reload-required' }), ...result } }
  }
  if (input.operation === 'measure') {
    const c = portableConfig({ ...input, expectedIP: '203.0.113.1' }, '')
    const { nodes, personalRoutePresent, personalScript } = await catalogue(c)
    if (personalRoutePresent) throw personalRouteError(personalScript)
    if (!nodes.some(node => node.name === c.selectedProxy && !node.chainError)) throw new Error('请选择可用的固定节点。')
    const node = nodes.find(node => node.name === c.selectedProxy)
    return measureSetup(desktopRoot(), { ...input, resolvedUpstream: node.upstreamChain || [] }, createController(c))
  }
  if (input.operation === 'monitor') {
    const root = desktopRoot()
    try { await lstat(join(root, 'config.json')); throw new Error('已有守护配置，请保留原保护或先撤销接入。') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await privateDirectory(root)
    await atomicPrivate(join(root, 'monitor.json'), JSON.stringify({ version: 1, mode: 'monitor', at: Date.now() }))
    return { saved: true, monitoring: true }
  }
  if (input.operation === 'save') return saveSetup(desktopRoot(), input)
  if (input.operation === 'save-singbox') return saveSingboxSetup(desktopRoot(), input)
  throw new Error('Unknown setup operation')
}
if (isMainModule(import.meta.url)) {
  command().then(result => console.log(JSON.stringify(result))).catch(error => {
    // No raw error, request, auth header or proxy configuration on stdout/stderr.
    const message = String(error.message || '')
    console.log(JSON.stringify({
      error: /[\u4e00-\u9fff]/.test(message) && message.length < 350 && !/https?:|Bearer|password|secret/i.test(message) ? message : '无法完成配置。请检查本机控制接口、密钥、节点、出口和原始脚本；已有配置未自动接入客户端。',
      ...(error.code === 'personal-guard-conflict' && { personalRoutePresent: true, personalScript: error.script }),
    }))
    process.exitCode = 1
  })
}
