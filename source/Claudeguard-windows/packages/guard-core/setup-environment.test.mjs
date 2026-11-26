import test from 'node:test'
import assert from 'node:assert/strict'
import { disableSetupIPv6, changeSetupPreferences, readSetupEnvironment } from './setup-environment.mjs'
import { inspectGlobalIPv6 } from './relay.mjs'

test('preflight reads TUN and uses the same live IPv6 probe as relay verification', async () => {
  const commands = []
  const reports = {
    '-listallnetworkservices': 'An asterisk denotes that a network service is disabled.\nWi-Fi\nUSB Ethernet\nVPN\n*Disabled',
    '-listnetworkserviceorder': '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n(2) USB Ethernet\n(Hardware Port: USB Ethernet, Device: en8)\n(3) VPN\n(Hardware Port: VPN, Device: utun1)',
    'Wi-Fi': 'IP address: 192.0.2.27\nIPv6: Off',
    'USB Ethernet': 'IP address: none\nIPv6: Automatic',
    'AppleLocale': 'zh_CN',
    'AppleLanguages': '(\n   "en-US"\n)',
  }
  const controller = { request: async (path, method) => {
    assert.equal(path, '/configs'); assert.equal(method, 'GET')
    return { tun: { enable: true, device: 'utun1024' } }
  } }
  const execute = async (command, args) => {
    commands.push([command, ...args])
    return { ok: true, text: reports[args.at(-1)] ?? '' }
  }
  const ipv6 = options => {
    assert.equal(options.tunnelInterface, 'utun1024')
    return inspectGlobalIPv6({ ...options, os: 'darwin', interfaces: () => ({
      utun1024: [{ family: 'IPv6', address: '2001:db8::10' }],
    }), run: () => assert.fail('Own TUN is not probed') })
  }
  const result = await readSetupEnvironment(controller, { execute, ipv6 })
  assert.deepEqual(result.services, [
    { name: 'USB Ethernet', active: false, mode: 'Automatic' },
    { name: 'Wi-Fi', active: true, mode: 'Off' },
  ])
  assert.equal(result.tunEnabled, true)
  assert.equal(result.globalIPv6, false)
  assert.equal(result.locale, 'zh_CN')
  assert.equal(result.language, 'en-US')
  assert.ok(commands.every(([, action]) => ['-listallnetworkservices', '-listnetworkserviceorder', '-getinfo', 'read'].includes(action)))
  const unavailable = await readSetupEnvironment(controller, { execute, ipv6: async () => { throw new Error('unavailable') } })
  assert.equal(unavailable.globalIPv6, null)
})

test('home checks retain local preferences while the Clash controller is offline', async () => {
  const controller = { request: async () => { throw new Error('offline') } }
  const execute = async (_file, args) => ({ ok: true, text: args.at(-1) === 'AppleLocale' ? 'en_US' : '' })
  const result = await readSetupEnvironment(controller, {
    execute, allowOffline: true, ipv6: async () => ({ present: false }),
  })
  assert.equal(result.controllerOnline, false)
  assert.equal(result.tunEnabled, null)
  assert.equal(result.locale, 'en_US')
  assert.equal(result.globalIPv6, false)
})

test('US East preference preset previews and applies only requested preferences', async () => {
  const token = 'b'.repeat(64), calls = []
  const manager = {
    preview: async (...args) => { calls.push(['preview', ...args]); return { planToken: token } },
    repair: async (...args) => { calls.push(['repair', ...args]); return { note: 'fixture' } },
  }
  const input = { preset: 'us-east', preferenceIDs: ['timezone'] }
  assert.equal((await changeSetupPreferences({ ...input, operation: 'wizard-preferences-preview' }, { manager })).planToken, token)
  await assert.rejects(changeSetupPreferences({ ...input, preferenceIDs: ['tun'], operation: 'wizard-preferences-preview' }, { manager }), /偏好/)
  await assert.rejects(changeSetupPreferences({ ...input, operation: 'wizard-preferences-apply', planToken: token }, { manager }), /确认/)
  await changeSetupPreferences({ ...input, operation: 'wizard-preferences-apply', planToken: token, confirmed: true }, { manager })
  const policy = { timezone: 'America/New_York', locale: 'en_US', language: 'en-US' }
  assert.deepEqual(calls, [['preview', ['timezone'], policy], ['repair', ['timezone'], policy, token]])
})

test('one-click IPv6 requires intent, makes a rollback plan, and does not request authorization when already off', async () => {
  const token = 'a'.repeat(64), calls = []
  const manager = {
    preview: async (...args) => { calls.push(['preview', ...args]); return { planToken: token, plan: [{ id: 'Wi-Fi' }] } },
    repair: async (...args) => { calls.push(['repair', ...args]); return { history: [{ status: 'applied' }] } },
  }
  await assert.rejects(disableSetupIPv6({}, { manager }), /请先点击/)
  assert.equal(calls.length, 0)
  assert.match((await disableSetupIPv6({ confirmed: true, ids: ['tun'] }, { manager })).note, /复查 1 个/)
  assert.deepEqual(calls, [['preview', ['ipv6-batch'], {}], ['repair', ['ipv6-batch'], {}, token]])
  calls.length = 0
  assert.match((await disableSetupIPv6({ confirmed: true }, { manager: { ...manager, preview: async () => ({ plan: [] }) } })).note, /没有需要/)
  assert.equal(calls.length, 0)
})
