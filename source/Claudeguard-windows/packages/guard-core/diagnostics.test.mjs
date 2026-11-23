import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, CLAUDE_DOMAINS } from './config.mjs'
import { reviewDomains, reviewDNS, reviewUDP, safeResolver, reviewConnections, createDiagnostics } from './diagnostics.mjs'
import { validateProbeChain } from './probe.mjs'
import { identifyRoute, checkClientRoute, createRouteCheck, CHECK_HOSTS } from './route-check.mjs'

test('fixed exit checks measure both sources, discard failures, and require an open guard', async () => {
  const expectedIP = '198.51.100.7'
  let open = true, calls = []
  const guard = { status: () => ({ state: open ? 'protected' : 'blocked', enabled: true, gateway: { open } }) }
  const checks = createRouteCheck({ expectedIP }, {}, guard, undefined, async (_c, _controller, source) => {
    calls.push(source)
    if (source === 'ipv4') return { ip: expectedIP, chains: ['must not be exported'] }
    throw new Error('must not be exported')
  })
  const request = checks.verifyFixedExits()
  assert.equal(checks.verifyFixedExits(), request)
  const result = await request
  assert.deepEqual(calls, ['ipv4', 'cloudflare'])
  assert.equal(result.ipv4.state, 'verified')
  assert.equal(result.ipv4.ip, expectedIP)
  assert.equal(result.cloudflare.state, 'unavailable')
  assert.equal(result.cloudflare.ip, undefined)
  assert.doesNotMatch(JSON.stringify(result), /must not be exported/)
  open = false
  assert.deepEqual(await checks.verifyFixedExits(), { state: 'gate-closed' })
  assert.equal(calls.length, 2)

  open = true
  const closes = createRouteCheck({ expectedIP }, {}, guard, undefined, async () => {
    open = false
    return { ip: expectedIP }
  })
  assert.deepEqual(await closes.verifyFixedExits(), { state: 'gate-closed' })
})

test('an auxiliary probe needs the matching host and the pinned chain', () => {
  const c = { pinnedProxy: 'fixed', probePort: 19903 }
  const conn = { connections: [{ metadata: { host: 'api.ipify.org', sourcePort: 40000, inboundPort: c.probePort }, chains: ['fixed'] }] }
  assert.deepEqual(validateProbeChain(conn, c, 40000, c.probePort, 'api.ipify.org'), ['fixed'])
  assert.throws(() => validateProbeChain(conn, c, 40000, c.probePort, 'www.cloudflare.com'))
  conn.connections[0].chains = ['DIRECT']
  assert.throws(() => validateProbeChain(conn, c, 40000, c.probePort, 'api.ipify.org'))
})

test('single Claude entry check requires an open guard and route evidence, without leaking the ordinary IP', async () => {
  let open = true, calls = 0
  const config = { clientPort: 19901, expectedIP: '198.51.100.7' }
  const guard = { status: () => ({ state: open ? 'protected' : 'blocked', enabled: true, gateway: { open } }) }
  const probe = createRouteCheck(config, {}, guard, async (_config, _controller, host) => {
    assert.equal(host, 'claude.ai'); calls++
    return { route: { guarded: false }, ip: '198.51.100.1', state: 'needs-review' }
  })
  assert.deepEqual(await probe.verifyClient(), { state: 'needs-review' })
  open = false
  assert.deepEqual(await probe.verifyClient(), { state: 'gate-closed' })
  assert.equal(calls, 1)
  open = true
  const verified = createRouteCheck(config, {}, guard, async () => ({
    route: { guarded: true }, ip: config.expectedIP, checkedAt: 123, durationMs: 27,
  }))
  assert.deepEqual(await verified.verifyClient(), { state: 'verified', clientPort: 19901, ip: config.expectedIP, checkedAt: 123, durationMs: 27 })
  const closes = createRouteCheck(config, {}, guard, async () => {
    open = false
    return { route: { guarded: true }, ip: config.expectedIP }
  })
  assert.deepEqual(await closes.verifyClient(), { state: 'gate-closed' })
})
const c = { ...DEFAULT_CONFIG }

test('domain review honours priority and treats unresolved context as unknown', () => {
  const rules = CLAUDE_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload, proxy: c.policyGroup }))
  let rows = reviewDomains(rules, c)
  assert.equal(rows.find(row => row.host === 'api.anthropic.com').coverage, 'covered')
  assert.equal(rows.find(row => row.host === 'claudemcpclient.com').coverage, 'unknown')
  assert.equal(rows.find(row => row.host === 'github.com').category, 'shared')
  rows = reviewDomains([{ type: 'Domain', payload: 'api.anthropic.com', proxy: 'DIRECT' }, ...rules], c)
  assert.equal(rows.find(row => row.host === 'api.anthropic.com').coverage, 'other')
  rows = reviewDomains([{ type: 'RuleSet', payload: 'unknown-list', proxy: 'DIRECT' }, ...rules], c)
  assert.equal(rows.find(row => row.host === 'api.anthropic.com').coverage, 'unknown')
})
test('DNS audit redacts URL credentials and cannot substitute configuration for a leak test', () => {
  const resolver = `https://username:never-print@dns.example/dns-query?token=never-print#${c.policyGroup}`
  assert.deepEqual(safeResolver(resolver, c), { transport: 'https', host: 'dns.example', pinned: true })
  const policy = Object.fromEntries(CLAUDE_DOMAINS.map(host => [`+.${host}`, [resolver]]))
  const local = Object.fromEntries(CLAUDE_DOMAINS.map(host => [host, { server: '127.0.0.1', port: 1053 }]))
  const runtime = { ipv6: false, dns: { enable: true, ipv6: false, 'nameserver-policy': policy } }
  let result = reviewDNS(runtime, c, local)
  assert.equal(result.state, 'configured'); assert.equal(result.leakTest, 'not-tested')
  assert.ok(!JSON.stringify(result).includes('never-print'))
  delete local['claude.ai']; result = reviewDNS(runtime, c, local)
  assert.equal(result.state, 'needs-review')
  assert.equal(reviewDNS(null, c).state, 'unknown')
})
test('DNS audit accepts TUN dns hijack without per-domain resolver files', () => {
  const resolver = `https://1.1.1.1/dns-query#${c.pinnedProxy}`
  const policy = Object.fromEntries(CLAUDE_DOMAINS.map(host => [`+.${host}`, [resolver]]))
  const dns = { enable: true, ipv6: false, 'nameserver-policy': policy }
  const tunRuntime = { ipv6: false, dns, tun: { enable: true, 'dns-hijack': ['any:53'] } }
  const result = reviewDNS(tunRuntime, c, {})
  assert.equal(result.state, 'configured'); assert.equal(result.via, 'tun')
  const offRuntime = { ...tunRuntime, tun: { enable: false, 'dns-hijack': ['any:53'] } }
  assert.equal(reviewDNS(offRuntime, c, {}).state, 'needs-review')
})
test('UDP review accepts one AND reject rule per Claude domain', () => {
  const rules = CLAUDE_DOMAINS.map(host => `AND,((DOMAIN-SUFFIX,${host}),(NETWORK,UDP),(DST-PORT,443)),REJECT`)
  const proxies = { proxies: { [c.gatewayProxy]: { udp: false } } }
  const result = reviewUDP({ rules }, proxies, c)
  assert.equal(result.domainReject, true); assert.equal(result.state, 'configured')
})
test('passive connection review shows only relevant hosts and labels coverage limits', () => {
  const result = reviewConnections({ connections: [
    { metadata: { host: 'private.company', process: 'browser', sourceIP: 'secret-ip' }, chains: ['DIRECT'] },
    { metadata: { host: 'api.anthropic.com', network: 'tcp' }, chains: [c.gatewayProxy, c.policyGroup] },
    { metadata: { host: 'claude.ai', inboundPort: c.probePort }, chains: [c.pinnedProxy] },
    { metadata: { host: 'claude.com', network: 'udp', processPath: '/secret' }, chains: ['DIRECT'] },
  ] }, c)
  assert.equal(result.state, 'needs-review'); assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].host, 'claude.com')
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.equal(reviewConnections({ connections: [] }, c).state, 'no-observed-bypass')
})
test('auxiliary failure preserves unknowns and only reads the controller', async () => {
  const calls = [], controller = { request: async path => { calls.push(path); throw new Error('private error') },
    select: () => assert.fail('diagnostics cannot switch policies') }
  const diagnostics = createDiagnostics(c, controller, async () => { throw new Error('private error') })
  const result = await diagnostics.inspect()
  assert.equal(result.state, 'partial'); assert.equal(result.dns.state, 'unknown'); assert.equal(result.observations, null)
  assert.deepEqual(calls.sort(), ['/connections', '/proxies', '/rules'])
  assert.ok(!JSON.stringify(result).includes('private error'))
})
test('client route identity requires host, source and client inbound; no arbitrary target or closed-gate test', async () => {
  const conn = { connections: [{ metadata: { host: 'claude.ai', sourcePort: 40000, inboundPort: c.clientPort }, chains: [c.gatewayProxy, c.policyGroup] }] }
  assert.equal(identifyRoute(conn, c, 'claude.ai', 40000).guarded, true)
  assert.equal(identifyRoute(conn, c, 'claude.ai', 40001).state, 'unknown')
  assert.equal(identifyRoute(conn, c, 'api.anthropic.com', 40000).state, 'unknown')
  await assert.rejects(checkClientRoute(c, {}, 'internal.example'), /Unsupported/)
  let open = false, calls = []
  const routeCheck = createRouteCheck(c, {}, { status: () => ({ gateway: { open } }) }, async (_c, _controller, host) => { calls.push(host); return { host, state: 'unavailable' } })
  assert.equal((await routeCheck.inspect()).state, 'gate-closed'); assert.equal(calls.length, 0)
  open = true; const result = await routeCheck.inspect()
  assert.deepEqual(calls, CHECK_HOSTS); assert.equal(result.rows.length, 3)
})
test('malformed auxiliary controller data returns unknown instead of crashing the guard process', async () => {
  const diagnostics = createDiagnostics(c, { request: async () => ({ rules: [null] }) }, async () => ({ runtime: null }))
  const result = await diagnostics.inspect()
  assert.equal(result.state, 'unknown'); assert.equal(result.domains.length, 0)
})
