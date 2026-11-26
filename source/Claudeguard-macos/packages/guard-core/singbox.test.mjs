import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig, validateShareConfig, SHARE_IDENTITY } from './config.mjs'
import { createController } from './controller.mjs'
import { createGuard } from './guard.mjs'
import { validateProbeChain } from './probe.mjs'
import { identifyRoute } from './route-check.mjs'
import { connectionRows } from './connection-log.mjs'
import { closeClaudeConnections } from './tun-connections.mjs'
import { catalogue, saveSingboxSetup, singboxConfig } from './setup.mjs'
import { reviewDomains } from './diagnostics.mjs'
import {
  singboxExpectedRules, singboxPayload, singboxRuleGroups, verifySingboxPolicy, routeTarget, singboxTagMatches,
  v2raynRules, singboxSnippet, singboxCatalogue, tunFromFile, controllerFromFile, isSingboxVersion, shadowsGuardedHost,
} from './singbox.mjs'

const PASSWORD = 'b'.repeat(64)
const EXIT = '香港 HK-01(固定)', EXIT_TAG = `1234567890-proxy-${EXIT}`, GW_TAG = '987654321-proxy-GuardNookShare-Gateway'
const base = (extra = {}) => validateShareConfig({ ...SHARE_IDENTITY, expectedIP: '203.0.113.20', proxyPassword: PASSWORD,
  controllerURL: 'http://127.0.0.1:10813', backendKind: 'singbox', selectedProxy: EXIT, clientPort: 10808, probePort: 10809,
  singbox: { exitRemark: EXIT, configPath: 'C:\\v2rayN\\binConfigs\\config.json' }, ...extra })

// What v2rayN 7.x puts in front of user rules (TUN on, sniffing on), as sing-box prints it.
const v2raynPrefix = [
  { type: 'default', payload: 'network=udp port=[135 137 138...]', proxy: 'reject' },
  { type: 'default', payload: 'ip_cidr=[224.0.0.0/3 ff00::/8]', proxy: 'reject' },
  { type: 'default', payload: 'ip_cidr=[172.18.0.1/32 fdfe:dcba:9876::1/128]', proxy: 'reject(drop)' },
  { type: 'default', payload: 'port=53 process_path=C:\\v2rayN\\bin\\sing_box\\sing-box.exe', proxy: 'hijack-dns' },
  { type: 'default', payload: 'process_path=C:\\v2rayN\\bin\\sing_box\\sing-box.exe', proxy: 'route(direct)' },
  { type: 'default', payload: '', proxy: 'sniff' },
  { type: 'logical', payload: 'port=53 || protocol=dns', proxy: 'hijack-dns' },
  { type: 'default', payload: 'clash_mode=Direct', proxy: 'route(direct)' },
  { type: 'default', payload: 'clash_mode=Global', proxy: 'route(proxy)' },
]
function guardRules(c, { exit = EXIT_TAG, gateway = GW_TAG } = {}) {
  return singboxExpectedRules(c).map(rule => ({ type: 'default', payload: rule.payload, proxy: `route(${rule.target === 'exit' ? exit : gateway})` }))
}
function snapshot(c, { rules = [...v2raynPrefix, ...guardRules(c), { type: 'default', payload: 'domain_suffix=[cn]', proxy: 'route(direct)' }], mode = 'Rule', tun = true } = {}) {
  return {
    configs: { mode, 'mode-list': ['Rule', 'Global', 'Direct'] },
    proxies: { proxies: { direct: { type: 'Direct' }, proxy: { type: 'VLESS' }, [EXIT_TAG]: { type: 'VLESS', udp: true },
      [GW_TAG]: { type: 'HTTP', udp: false }, GLOBAL: { type: 'Selector', all: ['proxy', 'direct'], now: 'proxy' } } },
    rules: { rules }, tun,
  }
}

test('sing-box options validate additively; Mihomo configs keep their exact shape', () => {
  const mihomo = validateConfig({ proxyPassword: PASSWORD })
  assert.equal('backendKind' in mihomo, false); assert.equal('singbox' in mihomo, false)
  const c = base()
  assert.deepEqual({ ...c.singbox }, { exitRemark: EXIT, gatewayRemark: 'GuardNookShare-Gateway', probeInbound: 'socks2', configPath: 'C:\\v2rayN\\binConfigs\\config.json' })
  for (const bad of [{ backendKind: 'xray' }, { backendKind: 'mihomo', singbox: { exitRemark: 'x' } }])
    assert.throws(() => validateConfig({ ...bad, proxyPassword: PASSWORD }))
  for (const singbox of [{ exitRemark: '' }, { exitRemark: 'proxy' }, { exitRemark: 'a,b' }, { exitRemark: 'x', probeInbound: 'socks' },
    { exitRemark: 'x', probeInbound: 'tun' }, { exitRemark: 'x', configPath: 'relative/config.json' }, { exitRemark: 'GuardNookShare-Gateway' }])
    assert.throws(() => base({ singbox, selectedProxy: singbox.exitRemark }), undefined, JSON.stringify(singbox))
  assert.throws(() => base({ controllerURL: '' }), /controller/)
  assert.throws(() => base({ deviceWide: true }))
  assert.throws(() => base({ coverageVersion: 1 }), /只支持/)
  assert.throws(() => base({ selectedProxy: 'other' }), /只支持/)
})

test('rule groups stay at three hosts so sing-box prints them in full', () => {
  for (const requireTun of [false, true]) {
    const c = base({ requireTun })
    for (const group of singboxRuleGroups(c)) assert.ok(group.items.length <= 3 && group.items.length > 0)
    const expected = singboxExpectedRules(c)
    assert.equal(expected[0].payload, 'inbound=socks2'); assert.equal(expected[0].target, 'exit')
    assert.equal(expected[1].payload, 'domain_suffix=[claude.ai claude.com anthropic.com]')
    assert.ok(expected.some(rule => rule.payload === 'domain=[accounts.google.com google.com www.google.com]'))
    assert.ok(expected.every(rule => !rule.payload.includes('...')))
  }
  assert.equal(singboxPayload({ key: 'domain', items: ['a.com'] }), 'domain=a.com')
  assert.equal(routeTarget('route(1-proxy-HK)'), '1-proxy-HK'); assert.equal(routeTarget('route(x,network_strategy=fallback)'), 'x')
  assert.equal(routeTarget('reject'), null); assert.equal(routeTarget('sniff'), null)
  assert.ok(singboxTagMatches(EXIT_TAG, EXIT)); assert.ok(singboxTagMatches(EXIT, EXIT)); assert.ok(!singboxTagMatches('proxy', EXIT))
  assert.ok(isSingboxVersion({ version: 'sing-box 1.12.12' })); assert.ok(!isSingboxVersion({ version: 'v1.19.8' }))
})

test('v2rayN template: probe inbound first, then domains to the gateway node; snippet carries no password', () => {
  const c = base({ requireTun: true })
  const rules = v2raynRules(c)
  assert.deepEqual(rules[0].inboundTag, ['socks2']); assert.equal(rules[0].outboundTag, EXIT)
  assert.ok(rules.slice(1).every(rule => rule.outboundTag === 'GuardNookShare-Gateway' && rule.domain.length <= 3
    && rule.domain.every(d => /^(domain|full):/.test(d))))
  assert.ok(rules.some(rule => rule.domain?.includes('domain:claude.ai')))
  const snippet = singboxSnippet(c)
  assert.ok(!JSON.stringify(snippet).includes(PASSWORD))
  assert.equal(snippet.outbounds[0].server_port, c.gatewayPort); assert.equal(snippet.inbounds[0].listen, '127.0.0.1')
  assert.deepEqual(snippet.route.rules[0], { inbound: ['socks2'], outbound: EXIT })
  assert.equal(singboxSnippet(c, { includePassword: true }).outbounds[0].password, PASSWORD)
})

test('verifies v2rayN-generated sing-box rules and resolves the exit and gateway tags', () => {
  const c = base({ requireTun: true })
  assert.deepEqual(verifySingboxPolicy(snapshot(c), c), { exitTag: EXIT_TAG, gatewayTag: GW_TAG })
  // Plain sing-box: tags are the names as written.
  const plain = snapshot(c, { rules: guardRules(c, { exit: EXIT, gateway: 'GuardNookShare-Gateway' }) })
  plain.proxies.proxies[EXIT] = { type: 'Trojan' }; plain.proxies.proxies['GuardNookShare-Gateway'] = { type: 'HTTP' }
  assert.deepEqual(verifySingboxPolicy(plain, c), { exitTag: EXIT, gatewayTag: 'GuardNookShare-Gateway' })
})

test('rule checks fail closed', () => {
  const c = base()
  const failure = (value, message) => assert.throws(() => verifySingboxPolicy(value, c), new RegExp(message))
  failure(snapshot(c, { rules: v2raynPrefix }), 'guard-route-not-installed')
  failure(snapshot(c, { mode: 'Global' }), 'rule-mode-required')
  // v2rayN falls back to its main "proxy" outbound when a remark is missing.
  failure(snapshot(c, { rules: [...v2raynPrefix, ...guardRules(c, { exit: 'proxy' })] }), 'protected-rules-changed')
  failure(snapshot(c, { rules: [...v2raynPrefix, ...guardRules(c, { gateway: 'proxy' })] }), 'protected-rules-changed')
  // One group removed.
  failure(snapshot(c, { rules: [...v2raynPrefix, ...guardRules(c).slice(0, -1)] }), 'protected-rules-changed')
  // Gateway rules ahead of the probe inbound would loop the gateway's own upstream.
  const [probe, ...domains] = guardRules(c)
  failure(snapshot(c, { rules: [...domains, probe] }), 'protected-rules-changed')
  // A user rule in front that can catch Claude.
  for (const rule of [{ type: 'default', payload: 'domain_keyword=claude', proxy: 'route(proxy)' },
    { type: 'default', payload: 'domain_suffix=ai', proxy: 'route(direct)' },
    { type: 'default', payload: 'geosite=anthropic', proxy: 'route(proxy)' },
    { type: 'default', payload: 'port=443', proxy: 'route(proxy)' },
    { type: 'default', payload: 'domain_suffix=[a.com b.com c.com...]', proxy: 'route(direct)' }])
    failure(snapshot(c, { rules: [rule, ...guardRules(c)] }), 'protected-rules-changed')
  // Harmless visible domain lists in front are fine; reject in front is fine.
  assert.ok(verifySingboxPolicy(snapshot(c, { rules: [{ type: 'default', payload: 'domain_suffix=[baidu.com qq.com]', proxy: 'route(direct)' },
    { type: 'default', payload: 'domain_suffix=claude.ai', proxy: 'reject' }, ...guardRules(c)] }), c))
  // Gateway must be the HTTP node and present; exit must be a concrete node.
  const s = snapshot(c); s.proxies.proxies[GW_TAG].type = 'VLESS'; failure(s, 'guard-route-not-installed')
  const t = snapshot(c); t.proxies.proxies[EXIT_TAG] = { type: 'Selector', all: ['a'], now: 'a' }; failure(t, 'frozen-chain-changed')
  const u = snapshot(c); delete u.proxies.proxies[EXIT_TAG]; failure(u, 'protected-rules-changed')
  assert.equal(shadowsGuardedHost({ type: 'default', payload: 'process_path=C:\\Claude\\claude.exe' }, c), true)
})

test('TUN evidence comes only from the matching generated config file', () => {
  const file = { inbounds: [{ type: 'mixed', tag: 'socks' }, { type: 'tun', tag: 'tun' }], experimental: { clash_api: { external_controller: '127.0.0.1:10813' } } }
  assert.equal(tunFromFile(file, 'http://127.0.0.1:10813'), true)
  assert.equal(tunFromFile({ ...file, inbounds: [{ type: 'mixed' }] }, 'http://127.0.0.1:10813'), false)
  assert.equal(tunFromFile(file, 'http://127.0.0.1:10814'), null) // stale or another instance
  assert.equal(tunFromFile(null, 'http://127.0.0.1:10813'), null)
  assert.equal(controllerFromFile({ experimental: { clash_api: { external_controller: '192.168.1.2:9090' } } }), null)
  assert.equal(controllerFromFile(file), 'http://127.0.0.1:10813')
})

test('probe, client route, connection log and drain use sing-box connection rows', async () => {
  const c = base()
  const rows = { connections: [
    { id: 'p1', metadata: { type: 'mixed/socks2', sourcePort: '50001', host: 'claude.ai' }, chains: [EXIT_TAG] },
    { id: 'g1', metadata: { type: 'tun/tun', sourcePort: '50002', host: 'claude.ai', processPath: 'C:\\Claude\\claude.exe' }, chains: [GW_TAG], start: '2026-11-23T01:00:00Z' },
    { id: 'c1', metadata: { type: 'mixed/socks', sourcePort: '50003', host: 'claude.ai' }, chains: [GW_TAG] },
    { id: 'o1', metadata: { type: 'tun/tun', sourcePort: '50004', host: 'example.com' }, chains: ['proxy'] },
    { id: 'p2', metadata: { type: 'mixed/socks', sourcePort: '50005', host: 'claude.ai' }, chains: ['proxy'] },
  ] }
  assert.deepEqual(validateProbeChain(rows, c, 50001, 10809), [EXIT_TAG])
  assert.throws(() => validateProbeChain(rows, c, 50005, 10809), /pinned/) // wrong inbound and node
  assert.throws(() => validateProbeChain(rows, c, 50003, 10809), /pinned/) // gateway row is not the probe
  assert.equal(identifyRoute(rows, c, 'claude.ai', 50003).guarded, true)
  assert.equal(identifyRoute(rows, c, 'claude.ai', 50005).guarded, false)
  assert.deepEqual(connectionRows(rows, c).map(row => row.id).sort(), ['c1', 'g1'])
  const deleted = []
  const controller = { request: async (path, method) => { if (method === 'DELETE') { deleted.push(path); return null } return rows } }
  assert.equal(await closeClaudeConnections(c, controller, { managedOnly: true }), 2)
  assert.deepEqual(deleted.sort(), ['/connections/c1', '/connections/g1'])
  const domains = reviewDomains(snapshot(c).rules.rules, c)
  assert.equal(domains.find(row => row.host === 'claude.ai').coverage, 'covered')
})

// A loopback HTTP server standing in for sing-box's clash_api.
async function clashAPI(state, { secret = '' } = {}) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    if (secret && req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end(); return }
    const send = value => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.method === 'GET' && req.url === '/version') return send({ version: 'sing-box 1.12.12', premium: true, meta: true })
    if (req.method === 'GET' && req.url === '/configs') return send(state.configs)
    if (req.method === 'GET' && req.url === '/proxies') return send(state.proxies)
    if (req.method === 'GET' && req.url === '/rules') return send(state.rules)
    if (req.method === 'GET' && req.url === '/connections') return send({ connections: [] })
    if (req.method === 'DELETE' && req.url.startsWith('/connections/')) { res.writeHead(204); res.end(); return }
    res.writeHead(404); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` }
}

test('guard over a mocked sing-box API: verifies, opens after recovery samples, never writes a selector', async () => {
  const api = await clashAPI(null)
  const c = base({ controllerURL: api.url, requireTun: true })
  const state = snapshot(c); api.server.removeAllListeners('request')
  let tunFile = { inbounds: [{ type: 'tun' }], experimental: { clash_api: { external_controller: new URL(api.url).host } } }
  api.server.on('request', (req, res) => {
    api.seen.push(`${req.method} ${req.url}`)
    const body = { '/configs': state.configs, '/proxies': state.proxies, '/rules': state.rules }[req.url]
    if (req.method !== 'GET' || !body) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body))
  })
  const readFile = async () => { if (!tunFile) throw new Error('ENOENT'); return JSON.stringify(tunFile) }
  const controller = createController(c, { readFile })
  let open = false, expiresAt = 0, drains = 0
  const gateway = { status: () => ({ open, expiresAt }), grant: until => { open = true; expiresAt = until }, closeAll: () => { open = false; expiresAt = 0 } }
  const guard = createGuard(c, controller, gateway, async () => ({ ip: c.expectedIP }), { readFile, drain: async () => { drains++ } })
  try {
    await guard.enable() // first recovery sample
    assert.equal(gateway.status().open, false)
    for (let i = 2; i <= 3; i++) { await guard.inspect(); assert.equal(gateway.status().open, i === 3, `sample ${i}`) }
    assert.equal(guard.status().state, 'protected'); assert.equal(guard.status().backendKind, 'singbox'); assert.equal(guard.status().tunEnabled, true)
    assert.equal(await guard.admit(), true)
    assert.ok(api.seen.every(line => line.startsWith('GET ')), 'no PUT/PATCH to sing-box')
    // TUN off in the regenerated file closes the gate.
    tunFile = { ...tunFile, inbounds: [{ type: 'mixed' }] }
    assert.equal(await guard.checkTun(), false)
    assert.equal(gateway.status().open, false); assert.equal(guard.status().reason, 'tun-required'); assert.ok(drains >= 1)
    // Unreadable file: unknown TUN state stays blocked.
    tunFile = null
    await guard.inspect()
    assert.equal(guard.status().reason, 'tun-status-unavailable'); assert.equal(guard.status().tunEnabled, null); assert.equal(gateway.status().open, false)
    // Rules removed while protected: blocked.
    tunFile = { inbounds: [{ type: 'tun' }], experimental: { clash_api: { external_controller: new URL(api.url).host } } }
    for (let i = 0; i < 3; i++) await guard.inspect()
    assert.equal(gateway.status().open, true)
    state.rules = { rules: v2raynPrefix }
    await guard.inspect()
    assert.equal(gateway.status().open, false); assert.equal(guard.status().reason, 'guard-route-not-installed')
    // Mismatched exit blocks.
    state.rules = { rules: guardRules(c) }
    const mismatch = createGuard(c, controller, gateway, async () => ({ ip: '198.51.100.9' }), { readFile })
    await mismatch.enable(); await mismatch.inspect()
    assert.equal(mismatch.status().reason, 'exit-ip-mismatch'); assert.equal(gateway.status().open, false)
    await mismatch.dispose()
  } finally { await guard.dispose(); api.server.close() }
})

test('controller sends the Bearer secret, deletes by id, and follows v2rayN to a new loopback port', async () => {
  const api = await clashAPI(snapshot(base()), { secret: 's3cret' })
  try {
    const c = base({ controllerURL: api.url, controllerSecret: 's3cret' })
    const controller = createController(c)
    assert.equal((await controller.request('/version')).version, 'sing-box 1.12.12')
    await controller.request('/connections/abc', 'DELETE')
    assert.ok(api.seen.includes('DELETE /connections/abc'))
    assert.equal(await controller.select('REJECT'), null)
    assert.throws(() => controller.select('proxy'), /Unsafe/)
    // TUN toggled in v2rayN: old port refused, the generated file names the new one.
    const dead = http.createServer(); dead.listen(0, '127.0.0.1'); await once(dead, 'listening')
    const deadURL = `http://127.0.0.1:${dead.address().port}`; dead.close(); await once(dead, 'close')
    const moved = createController(base({ controllerURL: deadURL, controllerSecret: 's3cret' }), {
      readFile: async () => JSON.stringify({ experimental: { clash_api: { external_controller: new URL(api.url).host } } }) })
    assert.equal((await moved.request('/version')).version, 'sing-box 1.12.12')
    assert.equal(moved.url(), api.url)
    // Mihomo never follows a file.
    const mihomo = createController(validateConfig({ controllerURL: deadURL, proxyPassword: PASSWORD }), { readFile: async () => { throw new Error('must not read') } })
    await assert.rejects(mihomo.request('/version'))
  } finally { api.server.close() }
})

test('setup: sing-box catalogue, Mihomo/sing-box mix-ups and saved templates', async () => {
  const c = base()
  const api = await clashAPI(snapshot(c))
  const root = await mkdtemp(join(tmpdir(), 'gn-singbox-'))
  try {
    const listed = await catalogue({ backendKind: 'singbox', controllerURL: api.url, targetPlatform: 'win32' })
    assert.equal(listed.backendKind, 'singbox'); assert.match(listed.version, /sing-box/)
    assert.deepEqual(listed.nodes.map(n => n.name), [EXIT])
    assert.deepEqual(singboxCatalogue(snapshot(c).proxies).map(n => n.tag), [EXIT_TAG])
    await assert.rejects(catalogue({ controllerURL: api.url, controllerSocket: '' }), /sing-box 内核/)
    await assert.rejects(saveSingboxSetup(root, { controllerURL: api.url, exitRemark: EXIT, expectedIP: '192.168.1.2', targetPlatform: 'win32' }), /public/)
    const saved = await saveSingboxSetup(root, { controllerURL: api.url, exitRemark: EXIT, expectedIP: '203.0.113.20', requireTun: true,
      singboxConfigPath: 'C:\\v2rayN\\binConfigs\\config.json', targetPlatform: 'win32', startProtected: true })
    assert.equal(saved.backendKind, 'singbox'); assert.equal(saved.gateway.port, 19904)
    const config = validateShareConfig(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')))
    assert.equal(config.backendKind, 'singbox'); assert.equal(config.selectedProxy, EXIT); assert.equal(config.clientPort, 10808); assert.equal(config.probePort, 10809)
    const rules = JSON.parse(await readFile(saved.scriptPath, 'utf8'))
    assert.deepEqual(rules, v2raynRules(config))
    assert.ok(!(await readFile(saved.snippetPath, 'utf8')).includes(config.proxyPassword))
    const manifest = JSON.parse(await readFile(join(root, 'SETUP.json'), 'utf8'))
    assert.equal(manifest.kind, 'singbox')
    // Re-saving keeps the gateway password the user typed into v2rayN.
    await saveSingboxSetup(root, { controllerURL: api.url, exitRemark: EXIT, expectedIP: '203.0.113.21', targetPlatform: 'win32' })
    assert.equal(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).proxyPassword, config.proxyPassword)
    assert.throws(() => singboxConfig({ controllerURL: api.url, exitRemark: '', expectedIP: '203.0.113.20' }, PASSWORD))
  } finally { api.server.close(); await rm(root, { recursive: true, force: true }) }
})
