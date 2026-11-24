import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, createServer } from 'node:net'
import { createServer as createHTTPServer } from 'node:http'
import { once } from 'node:events'
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { validateShareConfig } from './config.mjs'
import { confirmRelay, portableConfig, saveRelay } from './setup.mjs'
import { composeProfileScript } from './profile.mjs'
import { createGuard, verifyPolicy } from './guard.mjs'
import { verifyDeviceExit } from './device-exit.mjs'
import { validateProbeChain } from './probe.mjs'
import { connectTunnel } from './tunnel.mjs'
import { createGateway } from './gateway.mjs'
import { checkSocks5, globalIPv6Present, parseSocks5Link, probeRelayPath, relayRules, verifyRelayMembers } from './relay.mjs'

const relayID = '0123456789abcdef0123456789abcdef'
const password = 'p@ss:#/?%+你好'
const credentials = { username: 'relay_user', password }
const config = (confirmed = true) => validateShareConfig({
  ...portableConfig({ expectedIP: '198.51.100.7', selectedProxy: 'GN-Exit', guardGoogleAuth: false }, 'a'.repeat(64)),
  coverageVersion: 1, relay: { id: relayID, host: '192.0.2.23', port: 1080, confirmed, auth: true, nodes: ['East', 'West'], checkPort: 29901 },
})
const profileInput = () => ({
  mode: 'rule', 'mixed-port': 60123, 'proxy-groups': [{ name: 'Other', type: 'select', proxies: ['DIRECT'] }],
  proxies: [{ name: 'East', type: 'socks5', server: '127.0.0.1', port: 60001 },
    { name: 'West', type: 'socks5', server: '127.0.0.1', port: 60002 }],
  dns: { enable: false, 'nameserver-policy': { 'corp.test': ['192.0.2.53'] } },
  rules: ['DOMAIN,corp.test,DIRECT', 'MATCH,Other'],
})
const original = 'function main(config, name) { config.userProfile = name; return config; }'
const generated = (c, raw = profileInput()) => runInNewContext(
  composeProfileScript(original, c, credentials) + '\nmain(input, "Fixture")', { input: raw },
)

function controllerState(c) {
  const ruleType = { 'DOMAIN-SUFFIX': 'DomainSuffix', DOMAIN: 'Domain', AND: 'AND', 'IP-CIDR': 'IPCIDR', 'IP-CIDR6': 'IPCIDR6' }
  const profile = generated(c)
  const rules = profile.rules.filter(rule => !rule.startsWith('MATCH,')).map(rule => {
    const parts = rule.split(',')
    const policyIndex = parts.at(-1) === 'no-resolve' ? -2 : -1
    return { type: ruleType[parts[0]], payload: parts.slice(1, policyIndex).join(','), proxy: parts.at(policyIndex) }
  })
  return {
    '/configs': { mode: 'rule', tun: { enable: true, device: 'utun1024' } },
    '/proxies': { proxies: {
      East: { type: 'Socks5' }, West: { type: 'Socks5' },
      'GN-Exit': { type: 'Socks5', udp: false, 'dialer-proxy': '入口选择' },
      '入口选择': { type: 'Selector', udp: false, all: ['East', 'West'], now: 'East' },
      '出口选择': { type: 'Selector', udp: false, all: ['GN-Exit'], now: 'GN-Exit' },
      [c.pinnedProxy]: { type: 'Selector', udp: false, all: ['出口选择'], now: '出口选择' },
      [c.policyGroup]: { type: 'Selector', all: ['REJECT', c.gatewayProxy], now: 'REJECT' },
      [c.gatewayProxy]: { type: 'Http', udp: false },
    } },
    '/rules': { rules },
  }
}

function harness(c, supported = true) {
  const values = supported ? controllerState(c) : { '/configs': { mode: 'rule' }, '/proxies': { proxies: {} }, '/rules': { rules: [] } }
  const controller = { request: async path => values[path], select: async () => {} }
  let until = 0, ip = c.expectedIP, fault, ipv6 = false
  const gateway = { closeAll() { until = 0 }, grant(value) { until = value }, status: () => ({ open: Date.now() < until, expiresAt: until }) }
  const guard = createGuard(c, controller, gateway, async () => ({ ip }), { ipv6: async ({ tunnelInterface }) => {
    assert.equal(tunnelInterface, 'utun1024')
    return ipv6
  }, relayPath: async report => {
    report('entry', { ok: fault !== 'entry_unavailable', durationMs: 12 })
    if (fault === 'entry_unavailable') throw new Error(fault)
    report('exit', { ok: !fault, durationMs: 15 })
    if (fault) throw new Error(fault)
  } })
  return { guard, values, ip(value) { ip = value }, fault(value) { fault = value }, ipv6() { ipv6 = true } }
}

test('relay reports TUN re-enabled even while its rules are missing', async () => {
  const { guard, values } = harness(validateShareConfig({ ...config(), requireTun: true }), false)
  try {
    values['/configs'].tun = { enable: false }
    assert.equal(await guard.checkTun(), false)
    values['/configs'].tun.enable = true
    const status = await guard.inspect()
    assert.equal(status.tunEnabled, true)
    assert.equal(status.reason, 'guard-route-not-installed')
    assert.equal(status.gateway.open, false)
  } finally {
    await guard.dispose()
  }
})

test('SOCKS5 link accepts no auth and decodes literal special credentials exactly once', () => {
  assert.deepEqual(parseSocks5Link(' socks5://198.51.100.7:1080 '),
    { host: '198.51.100.7', port: 1080, username: '', password: '' })
  assert.deepEqual(parseSocks5Link(`socks5://u:${encodeURIComponent(password)}@relay.example:1080`),
    { host: 'relay.example', port: 1080, username: 'u', password })
  assert.throws(() => parseSocks5Link('socks5://u:x%zz@relay.example:1080'), error => !error.message.includes('x%zz'))
  assert.throws(() => parseSocks5Link('https://u:p@relay.example:1080'))
})

test('relay adds entry and exit selectors and a fixed exit without moving unrelated rules or bypassing the gateway', () => {
  const c = config(), before = profileInput(), result = generated(c, before)
  assert.equal(result.userProfile, 'Fixture')
  assert.deepEqual(Array.from(result.rules.slice(-2)), before.rules)
  assert.equal(result['mixed-port'], before['mixed-port'])
  assert.equal(result.dns['nameserver-policy']['corp.test'][0], '192.0.2.53')
  assert.equal(result['proxy-groups'][0].name, 'Other')
  const entry = result['proxy-groups'].find(group => group.name === '入口选择')
  assert.equal(entry.type, 'select')
  assert.equal(entry['empty-fallback'], 'REJECT')
  assert.deepEqual(Array.from(entry.proxies), ['East', 'West'])
  const exitGroup = result['proxy-groups'].find(group => group.name === '出口选择')
  assert.equal(exitGroup.type, 'select')
  assert.deepEqual(Array.from(exitGroup.proxies), ['GN-Exit'])
  assert.equal(result.proxies.find(proxy => proxy.name === 'GN-Exit')['dialer-proxy'], '入口选择')
  assert.equal(result.proxies.find(proxy => proxy.name === 'GN-Exit').password, password)
  assert.equal(result.rules[0], relayRules(c)[0])
  assert.ok(result.rules.includes(`DOMAIN-SUFFIX,claude.ai,${c.policyGroup}`))
  assert.ok(result.rules.every(rule => !rule.endsWith(',GN-Exit')))
  const keyword = validateShareConfig({ ...c, relay: { ...c.relay, nodes: [], keyword: 'east' } })
  const filtered = generated(keyword)['proxy-groups'].find(group => group.name === '入口选择')
  assert.deepEqual(Array.from(filtered.proxies), ['East'])
  assert.equal(filtered.filter, '(?i)east')
  const renamed = generated(keyword, { ...profileInput(), proxies: [profileInput().proxies[1]] })
  assert.deepEqual(Array.from(renamed['proxy-groups'].find(group => group.name === '入口选择').proxies), ['REJECT'])
})

test('device-wide mode replaces ordinary rules and DNS, and requires verified TUN coverage', () => {
  const c = validateShareConfig({ ...config(), deviceWide: true, requireTun: true })
  const raw = profileInput()
  raw.listeners = [{ name: 'bypass', type: 'http', port: 48888, proxy: 'DIRECT' }]
  const result = generated(c, raw)
  assert.deepEqual(Array.from(result.rules.slice(-3)), ['NETWORK,UDP,REJECT', 'IP-CIDR6,::/0,REJECT,no-resolve', `MATCH,${c.pinnedProxy}`])
  assert.ok(result.rules.includes(`DOMAIN-SUFFIX,claude.ai,${c.policyGroup}`))
  assert.deepEqual(Array.from(result['proxy-groups'], group => group.name).sort(),
    [c.policyGroup, c.pinnedProxy, '入口选择', '出口选择'].sort())
  assert.ok(!result.rules.some(rule => rule.endsWith(',DIRECT')))
  assert.ok(!result.listeners.some(row => row.name === 'bypass'))
  assert.ok(result.dns.nameserver.every(url => url.endsWith('#' + c.pinnedProxy)))
  assert.equal(result.dns['nameserver-policy'], undefined)
  assert.equal(result.tun['strict-route'], true)
  assert.equal(result.tun['auto-route'], true)
  assert.throws(() => validateShareConfig({ ...c, requireTun: false }), /TUN/)
})

test('saved relay strips auth from both config copies and waits for the matching Clash import', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guardnook-share-relay-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await saveRelay(root, {
    relayID, confirmChanges: true, entry: { nodes: ['East', 'West'] }, exit: { host: 'relay.example', port: 1080, ...credentials },
  }, async () => ({ nodes: [{ name: 'East' }, { name: 'West' }] }))
  const saved = await readFile(join(root, 'config.json'), 'utf8')
  const snapshot = await readFile(join(result.scriptPath, '..', 'config.json'), 'utf8')
  const script = await readFile(result.scriptPath, 'utf8')
  for (const text of [saved, snapshot]) assert.ok(!text.includes(password) && !text.includes(credentials.username))
  assert.ok(script.includes(password))
  assert.equal(result.expectedIP, null)
  const c = validateShareConfig(JSON.parse(saved)), { guard } = harness(c, false)
  assert.equal((await guard.inspect()).phase, 'awaiting-rules')
  assert.equal((await guard.enable()).gateway.open, false)
  const afterImport = harness(c)
  assert.equal((await afterImport.guard.inspect()).reason, 'relay-awaiting-confirmation')
  assert.equal((await afterImport.guard.enable()).gateway.open, false)
  assert.ok(!JSON.stringify(afterImport.guard.status()).includes(password))
})

test('entry selector change keeps verified egress; changed egress blocks immediately on next check', async () => {
  const c = config(), { guard, values, ip } = harness(c)
  await guard.enable(); await guard.inspect(); await guard.inspect()
  assert.equal(guard.status().phase, 'protected')
  values['/proxies'].proxies['入口选择'].now = 'West'
  assert.equal((await guard.inspect()).phase, 'protected')
  ip('198.51.100.8')
  const changed = await guard.inspect()
  assert.equal(changed.reason, 'egress_mismatch')
  assert.equal(changed.relay.stages.egress.ok, false)
  assert.equal(changed.gateway.open, false)
  assert.equal(await guard.admit(), false)
})

test('confirmation only accepts the still-fresh IPv4 from the matching relay generation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guardnook-relay-confirm-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let evidence
  const server = createHTTPServer((_request, response) => response.end(JSON.stringify(evidence)))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => server.close())
  const configuration = validateShareConfig({ ...config(false), serverPort: server.address().port })
  const path = join(root, 'config.json'), ip = '198.51.100.19'
  await writeFile(path, JSON.stringify(configuration))
  evidence = { policyGroup: configuration.policyGroup, pinnedProxy: configuration.pinnedProxy,
    reason: 'relay-awaiting-confirmation', last: { ip, verifiedAt: Date.now() },
    relay: { id: relayID, stages: { entry: { ok: true }, exit: { ok: true }, egress: { ok: true } } } }
  await assert.rejects(confirmRelay(root, { relayID, expectedIP: '198.51.100.20' }), /变化/)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).relay.confirmed, false)
  await confirmRelay(root, { relayID, expectedIP: ip })
  const result = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(result.expectedIP, ip)
  assert.equal(result.relay.confirmed, true)
  assert.equal(result.startProtected, true)
  assert.ok(!JSON.stringify(result).includes(password))
})

test('missing subscription entries, invalid credentials and global IPv6 have distinct reasons', async () => {
  const c = config()
  const missing = harness(c)
  missing.values['/proxies'].proxies['入口选择'].all = ['REJECT']
  assert.equal((await missing.guard.inspect()).reason, 'entry_unavailable')
  const auth = harness(c)
  auth.fault('exit_auth_failed')
  assert.equal((await auth.guard.enable()).reason, 'exit_auth_failed')
  assert.equal(auth.guard.status().relay.stages.exit.ok, false)
  assert.ok(!JSON.stringify(auth.guard.status()).includes(password))
  const address = harness(c)
  address.ipv6()
  assert.equal((await address.guard.enable()).reason, 'global_ipv6_present')
})

test('IPv6 blocks only when a non-guard-TUN global address can connect directly over an attested route', async () => {
  const localOnly = {
    lo0: [{ family: 'IPv6', address: '::1', internal: true }],
    utun1: [{ family: 'IPv6', address: 'fe80::abcd' }],
    utun1024: [{ family: 'IPv6', address: '2001:db8::10' }],
  }
  const route = name => async (_file, args) => {
    assert.deepEqual(args.slice(0, 3), ['-n', 'get', '-inet6'])
    return { stdout: `  interface: ${name}\n` }
  }
  const fixed = { os: 'darwin', tunnelInterface: 'utun1024' }
  let unexpectedProbes = 0
  const mustNotCall = () => { unexpectedProbes++; throw new Error('No eligible IPv6 address should be tested') }
  const ignored = await globalIPv6Present({ ...fixed, interfaces: () => localOnly, run: mustNotCall, connect: mustNotCall })
  assert.equal(ignored, false)
  assert.equal(unexpectedProbes, 0)

  const interfaces = () => ({ ...localOnly, en0: [{ family: 'IPv6', address: '2001:db8::9' }] })
  const connected = []
  const connect = async (host, source) => { connected.push([host, source]); return true }
  assert.equal(await globalIPv6Present({ ...fixed, interfaces, run: route('en0'), connect }), true)
  assert.equal(connected.length, 2)
  assert.ok(connected.every(([, source]) => source === '2001:db8::9'))
  assert.equal(await globalIPv6Present({ ...fixed, interfaces, run: route('en0'), connect: async () => false }), false)
  assert.equal(await globalIPv6Present({ ...fixed, interfaces, run: route('utun1024'), connect }), false)
  let probes = 0
  assert.equal(await globalIPv6Present({ ...fixed, interfaces, run: async () => {
    const before = probes++ < 2
    return { stdout: 'interface: ' + (before ? 'en0' : 'utun1024') }
  }, connect }), false)
})

test('wire-level SOCKS5 auth failure does not include the credential', async t => {
  let handshake
  const server = createServer(socket => {
    socket.once('data', () => {
      socket.write(Buffer.from([5, 2]))
      socket.once('data', bytes => { handshake = bytes; socket.write(Buffer.from([1, 1])) })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = createConnection(server.address().port, '127.0.0.1')
  t.after(() => { client.destroy(); server.close() })
  await once(client, 'connect')
  await assert.rejects(checkSocks5(client, credentials), { message: 'exit_auth_failed' })
  assert.ok(handshake.includes(Buffer.from(password)))
})

test('installed Mihomo accepts the generated fixture and reports rule and proxy evidence', {
  skip: !process.env.GUARDNOOK_TEST_MIHOMO,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'guardnook-mihomo-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const free = async () => {
    const socket = createServer()
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
    const { port } = socket.address()
    await new Promise(resolve => socket.close(resolve))
    return port
  }
  const bind = async handler => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => server.close())
    return server.address().port
  }
  let authCount = 0
  const exitPort = await bind(socket => {
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.write(Buffer.from([5, 2]))
      socket.once('data', received => {
        authCount++
        const success = received.includes(Buffer.from(password))
        socket.write(Buffer.from([1, success ? 0 : 1]))
        if (success) socket.once('data', request => {
          assert.equal(request.readUInt16BE(request.length - 2), 443)
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          socket.on('data', bytes => socket.write(bytes))
        })
      })
    })
  })
  const entryPort = await bind(socket => {
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.write(Buffer.from([5, 0]))
      socket.once('data', request => {
        if (request.readUInt16BE(request.length - 2) !== exitPort) { socket.destroy(); return }
        const upstream = createConnection(exitPort, '127.0.0.1', () => {
          socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          socket.pipe(upstream).pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
      })
    })
  })
  const c = validateShareConfig({ ...config(), clientPort: await free(), probePort: await free(),
    relay: { ...config().relay, host: '127.0.0.1', port: exitPort } })
  const control = await free(), input = profileInput()
  for (const proxy of input.proxies) proxy.port = entryPort
  const fixture = generated(c, input)
  fixture['external-controller'] = '127.0.0.1:' + control
  delete fixture['mixed-port']
  const path = join(root, 'fixture.json')
  await writeFile(path, JSON.stringify(fixture, null, 2), { mode: 0o600 })
  const child = spawn(process.env.GUARDNOOK_TEST_MIHOMO, ['-d', root, '-f', path], { stdio: 'ignore' })
  const closed = once(child, 'close')
  t.after(async () => { child.kill(); await closed })
  const read = async name => (await fetch('http://127.0.0.1:' + control + name, { signal: AbortSignal.timeout(800) })).json()
  let configs
  for (let attempt = 0; !configs && attempt < 40 && child.exitCode === null; attempt++) {
    try { configs = await read('/configs') } catch { await wait(60) }
  }
  assert.ok(configs, 'Separate Mihomo fixture must start')
  const [proxies, rules] = await Promise.all([read('/proxies'), read('/rules')])
  assert.equal(proxies.proxies['GN-Exit']['dialer-proxy'], '入口选择')
  assert.equal(proxies.proxies['入口选择'].type, 'Selector')
  assert.equal(proxies.proxies['出口选择'].type, 'Selector')
  assert.deepEqual(proxies.proxies['GuardNookShare-Pinned'].all, ['出口选择'])
  assert.ok(verifyPolicy({ configs, proxies, rules }, c))
  const receipt = []
  const controller = { request: path => {
    assert.ok(!path.includes('/delay?'), 'A verified relay path must not depend on the auxiliary delay check')
    return read(path)
  } }
  const emit = (stage, value) => receipt.push([stage, value.ok])
  await probeRelayPath(c, controller, credentials, emit)
  assert.deepEqual(receipt, [['entry', true], ['exit', true]])
  await assert.rejects(probeRelayPath(c, controller, { ...credentials, password: 'wrong' }, emit),
    { message: 'exit_auth_failed' })
  assert.equal(authCount, 2)
  const tunnel = await connectTunnel(c, 'claude.ai:443')
  try {
    const reply = once(tunnel, 'data', { signal: AbortSignal.timeout(2000) })
    tunnel.resume()
    tunnel.write('isolated fixture')
    assert.equal((await reply)[0].toString(), 'isolated fixture')
    const chain = validateProbeChain(await read('/connections'), c, tunnel.localPort, c.probePort)
    assert.ok(chain.includes('GN-Exit'))
    assert.equal(authCount, 3)
  } finally { tunnel.destroy() }

  const device = validateShareConfig({ ...c, deviceWide: true, requireTun: true, gatewayPort: await free() })
  const wideInput = profileInput()
  for (const proxy of wideInput.proxies) proxy.port = entryPort
  const wide = generated(device, wideInput)
  wide.tun.enable = false // no host routing change in the isolated fixture
  const native = await free()
  wide['mixed-port'] = native
  wide['external-controller'] = '127.0.0.1:' + control
  await writeFile(path, JSON.stringify(wide), { mode: 0o600 })
  const local = (name, method, body) => fetch('http://127.0.0.1:' + control + name, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  })
  assert.ok((await local('/configs?force=true', 'PUT', { path })).ok)
  const [wideConfigs, wideProxies, wideRules] = await Promise.all([read('/configs'), read('/proxies'), read('/rules')])
  const snapshot = { configs: wideConfigs, proxies: wideProxies, rules: wideRules }
  assert.throws(() => verifyPolicy(snapshot, device), /tun-required/)
  const simulatedTun = { ...wideConfigs, tun: { ...wideConfigs.tun, enable: true } }
  assert.ok(verifyPolicy({ ...snapshot, configs: simulatedTun }, device))
  assert.throws(() => verifyPolicy({ ...snapshot, configs: { ...simulatedTun,
    tun: { ...simulatedTun.tun, 'strict-route': false } } }, device), /device-tun-coverage/)
  const isolatedController = {
    request: async pathname => pathname === '/configs' ? simulatedTun : read(pathname),
    select: async name => {
      const response = await local('/proxies/' + encodeURIComponent(device.policyGroup), 'PUT', { name })
      assert.ok(response.ok)
    },
  }
  let measuredIP = device.expectedIP
  let guard
  const gateway = createGateway(device, undefined, async () => {
    if (!await guard.admit()) throw new Error('Guard admission denied')
  })
  guard = createGuard(device, isolatedController, gateway, async () => ({ ip: measuredIP }), {
    ipv6: async () => false,
    relayPath: report => probeRelayPath(device, isolatedController, credentials, report),
  })
  await gateway.start()
  const echo = async (host, witness) => {
    const tunnel = await connectTunnel(device, host + ':443', native)
    try {
      const controller = new AbortController()
      try {
        const reply = Promise.race([
          once(tunnel, 'data', { signal: controller.signal }).then(([bytes]) => bytes.toString()),
          once(tunnel, 'close', { signal: controller.signal }).then(() => { throw new Error('Tunnel closed') }),
          wait(2000, null, { signal: controller.signal }).then(() => { throw new Error('Tunnel did not carry data') }),
        ])
        tunnel.resume()
        tunnel.write('gate test')
        const echoed = await reply
        if (witness) await witness(tunnel)
        return echoed
      } finally { controller.abort() }
    } finally { tunnel.destroy() }
  }

  try {
    await guard.enable()
    await assert.rejects(echo('claude.ai'))
    for (let sample = 1; sample < device.recoverySamples; sample++) await guard.inspect()
    assert.equal(guard.status().phase, 'protected')
    assert.equal(await echo('api.anthropic.com'), 'gate test')

    assert.equal(await echo('claude.ai', async existing => {
      const closed = once(existing, 'close', { signal: AbortSignal.timeout(2000) })
      measuredIP = '198.51.100.8'
      const changed = await guard.inspect()
      assert.equal(changed.reason, 'egress_mismatch')
      assert.equal(changed.gateway.open, false)
      await closed
    }), 'gate test')

    assert.equal((await read('/proxies')).proxies[device.policyGroup].now, 'REJECT')
    await assert.rejects(echo('claude.ai'))
    await assert.rejects(echo('api.anthropic.com'))
    assert.equal(await echo('example.com', async () => {
      const connections = await read('/connections')
      assert.ok(connections.connections.some(row => row.metadata?.host === 'example.com'
        && row.chains.includes(device.pinnedProxy) && row.chains.includes('GN-Exit')
        && !row.chains.includes(device.gatewayProxy)))
    }), 'gate test')

    measuredIP = device.expectedIP
    for (let sample = 1; sample < device.recoverySamples; sample++) {
      assert.equal((await guard.inspect()).gateway.open, false)
    }
    assert.equal((await guard.inspect()).phase, 'protected')
    assert.equal(await echo('claude.ai'), 'gate test')
  } finally {
    await guard.dispose()
    await gateway.stop()
  }

})

test('an actual relay connection failure uses the auxiliary check only to localize the failure', async () => {
  const c = config(), receipt = []
  const connect = async ({ timeoutMs }) => {
    assert.ok(timeoutMs > 4000 && timeoutMs <= c.timeoutMs)
    receipt.push(['connect', true])
    throw new Error('fixture unreachable')
  }
  const emit = (stage, result) => receipt.push([stage, result.ok])
  await assert.rejects(probeRelayPath(c, { request: async () => ({ delay: 3 }) }, credentials, emit, { connect }), /exit_unreachable/)
  assert.deepEqual(receipt, [['connect', true], ['entry', true], ['exit', false]])
  receipt.length = 0
  await assert.rejects(probeRelayPath(c, { request: async () => ({}) }, credentials, emit, { connect }), /entry_unavailable/)
  assert.deepEqual(receipt, [['connect', true], ['entry', false], ['exit', false]])
})


test('standalone file-provider nodes count as real entries without allowing missing or unsafe nodes', () => {
  const c = config()
  const { proxies } = controllerState(c)['/proxies']
  delete proxies.East
  delete proxies.West
  const fileProvider = { vehicleType: 'File', proxies: [
    { name: 'East', type: 'Trojan' }, { name: 'West', type: 'AnyTLS' },
  ] }
  assert.doesNotThrow(() => verifyRelayMembers(c.relay, proxies, fileProvider))
  assert.throws(() => verifyRelayMembers(c.relay, proxies), /entry_unavailable/)
  assert.throws(() => verifyRelayMembers(c.relay, proxies, { ...fileProvider, vehicleType: 'HTTP' }), /entry_unavailable/)
  fileProvider.proxies[1].type = 'Direct'
  assert.throws(() => verifyRelayMembers(c.relay, proxies, fileProvider), /entry_unavailable/)
})

test('TUN permits shared carrier and private subnets but forbids public route exclusions', () => {
  const config = { deviceWide: true, pinnedProxy: 'pinned' }
  const rules = { rules: [{ type: 'Network', payload: 'udp', proxy: 'REJECT' },
    { type: 'IPCIDR6', payload: '::/0', proxy: 'REJECT' }, { type: 'Match', proxy: 'pinned' }] }
  const tun = { enable: true, 'auto-route': true, 'strict-route': true, 'dns-hijack': ['any:53'],
    'route-exclude-address': ['100.64.0.0/10', '100.65.0.0/16', '10.0.0.0/8'] }
  assert.doesNotThrow(() => verifyDeviceExit({ tun }, rules, config, 0))
  for (const unsafe of ['100.64.0.0/9', '100.128.0.0/10', '192.168.0.0/12', '1.1.1.1/32', '::/0']) {
    assert.throws(() => verifyDeviceExit({ tun: { ...tun, 'route-exclude-address': [unsafe] } }, rules, config, 0), /device-tun-coverage/)
  }
})
