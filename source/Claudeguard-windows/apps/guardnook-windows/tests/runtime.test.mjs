import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntime } from '../src/runtime.mjs'
import { portableConfig } from '../../../packages/guard-core/setup.mjs'

const freePort = async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
test('Windows runtime stays closed when TUN is off and persists manual block through restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'guardnook-runtime-'))
  const controller = createServer((req, res) => {
    const value = req.url === '/configs' ? { mode: 'rule', tun: { enable: false } }
      : req.url === '/proxies' ? { proxies: {} } : req.url === '/rules' ? { rules: [] } : { connections: [] }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value))
  })
  controller.listen(0, '127.0.0.1'); await once(controller, 'listening')
  let runtime
  try {
    const ports = new Set()
    while (ports.size < 4) ports.add(await freePort())
    const [serverPort, clientPort, probePort, gatewayPort] = [...ports]
    const config = portableConfig({ targetPlatform: 'win32', controllerSocket: '', controllerURL: `http://127.0.0.1:${controller.address().port}`, expectedIP: '203.0.113.1', selectedProxy: 'fixed', requireTun: true, serverPort, clientPort, probePort, gatewayPort }, 'a'.repeat(64))
    await writeFile(join(directory, 'config.json'), JSON.stringify(config))
    runtime = await createRuntime(fileURLToPath(new URL('../../../packages/guard-core', import.meta.url)), directory)
    await runtime.start()
    const enabled = await runtime.action('enable')
    assert.equal(enabled.gateway.open, false)
    assert.equal(enabled.reason, 'tun-required')
    await runtime.action('block')
    assert.equal(JSON.parse(await readFile(join(directory, 'state.json'))).manual, true)
    await runtime.stop(); await runtime.start()
    assert.equal(runtime.status().manual, true)
    assert.equal(runtime.status().gateway.open, false)
    assert.equal(runtime.settings().expectedIP, '203.0.113.1')
    assert.equal(Object.hasOwn(runtime.settings(), 'proxyPassword'), false)
    assert.equal(Object.hasOwn(runtime.settings(), 'controllerSecret'), false)
    await assert.rejects(runtime.action('arbitrary-command'))
  } finally {
    await runtime?.stop()
    controller.closeAllConnections(); await new Promise(resolve => controller.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('Windows SOCKS5 setup uses the vault, the common device policy, and a closed gateway before import', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claudeguard-windows-relay-'))
  const controller = createServer((req, res) => {
    const response = req.url === '/version' ? { version: 'test-mihomo' }
      : req.url === '/proxies' ? { proxies: { Entry: { type: 'Trojan' } } }
      : req.url === '/configs' ? { mode: 'rule', tun: { enable: true } }
      : req.url === '/rules' ? { rules: [] } : { connections: [] }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(response))
  })
  controller.listen(0, '127.0.0.1')
  await once(controller, 'listening')
  const vault = new Map()
  let runtime
  try {
    const ports = new Set()
    while (ports.size < 4) ports.add(await freePort())
    const [serverPort, clientPort, probePort, gatewayPort] = [...ports]
    const core = fileURLToPath(new URL('../../../packages/guard-core', import.meta.url))
    runtime = await createRuntime(core, directory, {
      storeRelayCredentials: async (id, credentials) => vault.set(id, credentials),
      loadRelayCredentials: async id => vault.get(id),
    })
    const reply = await runtime.save({
      exitMode: 'relay', confirmChanges: true, relayLink: 'socks5://test:p%40ssword@198.51.100.8:1080',
      deviceWide: true, entry: { nodes: ['Entry'] }, controllerURL: `http://127.0.0.1:${controller.address().port}`,
      serverPort, clientPort, probePort, gatewayPort,
    })
    assert.equal(reply.settings.relay.confirmed, false)
    assert.equal(reply.settings.deviceWide, true)
    assert.equal(vault.get(reply.settings.relay.id).password, 'p@ssword')
    assert.doesNotMatch(await readFile(join(directory, 'config.json'), 'utf8'), /p@ssword|p%40ssword/)
    assert.match(await readFile(reply.scriptPath, 'utf8'), /"deviceWide":true/)
    assert.equal(runtime.status().gateway.open, false)
    await assert.rejects(runtime.confirmRelay(), /实测/)
  } finally {
    await runtime?.stop()
    controller.closeAllConnections()
    await new Promise(resolve => controller.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})

test('Windows v2rayN (sing-box) setup saves rules, keeps the gateway closed until rules and TUN are confirmed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claudeguard-windows-singbox-'))
  const controller = createServer((req, res) => {
    const response = req.url === '/version' ? { version: 'sing-box 1.12.12', premium: true, meta: true }
      : req.url === '/proxies' ? { proxies: { proxy: { type: 'VLESS' }, '1-proxy-HK-01': { type: 'VLESS' } } }
      : req.url === '/configs' ? { mode: 'Rule' } : req.url === '/rules' ? { rules: [] } : { connections: [] }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response))
  })
  controller.listen(0, '127.0.0.1'); await once(controller, 'listening')
  let runtime
  try {
    const ports = new Set()
    while (ports.size < 2) ports.add(await freePort())
    const [serverPort, gatewayPort] = [...ports]
    runtime = await createRuntime(fileURLToPath(new URL('../../../packages/guard-core', import.meta.url)), directory)
    const saved = await runtime.save({ backendKind: 'singbox', controllerURL: `http://127.0.0.1:${controller.address().port}`, exitRemark: 'HK-01',
      expectedIP: '203.0.113.30', requireTun: true, startProtected: true, serverPort, gatewayPort, clientPort: 10808, probePort: 10809, singboxConfigPath: '' })
    assert.equal(saved.backendKind, 'singbox')
    assert.equal(runtime.settings().backendKind, 'singbox'); assert.equal(runtime.settings().singbox.exitRemark, 'HK-01')
    assert.equal(Object.hasOwn(runtime.settings(), 'proxyPassword'), false)
    const status = await runtime.action('inspect')
    assert.equal(status.gateway.open, false)
    assert.equal(status.backendKind, 'singbox')
    assert.ok(['tun-status-unavailable', 'guard-route-not-installed'].includes(status.reason), status.reason)
    const rules = JSON.parse(await runtime.template('rules'))
    assert.deepEqual(rules[0].inboundTag, ['socks2']); assert.equal(rules[0].outboundTag, 'HK-01')
    const password = await runtime.template('gateway-password')
    assert.match(password, /^[a-f0-9]{64}$/)
    // v2rayN InnerFmt link: v2rayn://http/<base64url JSON>, ConfigVersion 4, ConfigType 10 (HTTP)
    const link = await runtime.template('gateway-link')
    assert.match(link, /^v2rayn:\/\/http\/[A-Za-z0-9_-]+$/)
    assert.deepEqual(JSON.parse(Buffer.from(link.slice('v2rayn://http/'.length), 'base64url').toString('utf8')),
      { ConfigType: 10, ConfigVersion: 4, Remarks: 'GuardNookShare-Gateway', Address: '127.0.0.1', Port: gatewayPort, Username: 'claude-guard', Password: password })
    assert.equal(new URL(link).pathname.slice(1), link.slice('v2rayn://http/'.length), 'whole payload sits in the URI path')
    // RulesItem import format (ServiceLib/Models/Entities/RulesItem.cs)
    for (const rule of rules) {
      assert.deepEqual(Object.keys(rule).filter(k => !['remarks', 'outboundTag', 'inboundTag', 'domain', 'enabled'].includes(k)), [])
      assert.equal(rule.enabled, true); assert.equal(typeof rule.outboundTag, 'string')
    }
    assert.equal(JSON.parse(await runtime.template('singbox-snippet')).outbounds[0].server_port, gatewayPort)
    await assert.rejects(runtime.template('other'))
  } finally {
    await runtime?.stop()
    controller.closeAllConnections(); await new Promise(resolve => controller.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
