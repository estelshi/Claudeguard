import test from 'node:test'
import assert from 'node:assert/strict'
import { deviceExitRules, uuRemoteExceptionRules, verifyDeviceExit } from './device-exit.mjs'

function parsed(text) {
  if (text.startsWith('PROCESS-NAME,')) {
    const rest = text.slice('PROCESS-NAME,'.length)
    const index = rest.lastIndexOf(',')
    return { type: 'ProcessName', payload: rest.slice(0, index), proxy: rest.slice(index + 1) }
  }
  if (text.startsWith('PROCESS-PATH-REGEX,')) {
    const rest = text.slice('PROCESS-PATH-REGEX,'.length)
    const index = rest.lastIndexOf(',')
    return { type: 'ProcessPathRegex', payload: rest.slice(0, index), proxy: rest.slice(index + 1) }
  }
  throw new Error(text)
}

// Captured from a live Mihomo /rules response for a 428d141 standalone
// profile (Clash Verge). IPv6 CIDR is reported as IPCIDR, MATCH payload is
// empty, and PROCESS-PATH-REGEX keeps a single escaped backslash.
function liveMihomoDeviceTail(c) {
  return uuRemoteExceptionRules().map(parsed).concat([
    { type: 'Network', payload: 'udp', proxy: 'REJECT' },
    { type: 'IPCIDR', payload: '::/0', proxy: 'REJECT' },
    { type: 'Match', payload: '', proxy: c.pinnedProxy },
  ])
}

function tunConfigs(extra = {}) {
  return {
    'find-process-mode': 'strict',
    tun: { enable: true, 'auto-route': true, 'strict-route': true, 'dns-hijack': ['any:53'] },
    ...extra,
  }
}

test('verifyDeviceExit accepts live Mihomo payloads for the UU and pinned tail', () => {
  const config = { deviceWide: true, allowUURemote: true, pinnedProxy: 'GuardNookShare-Pinned' }
  const rules = { rules: liveMihomoDeviceTail(config) }
  assert.doesNotThrow(() => verifyDeviceExit(tunConfigs(), rules, config, 0))
})

test('verifyDeviceExit still requires UU DIRECT exceptions and the pinned reject tail', () => {
  const config = { deviceWide: true, allowUURemote: true, pinnedProxy: 'GuardNookShare-Pinned' }
  const live = liveMihomoDeviceTail(config)
  const tun = tunConfigs()
  const missingUu = { rules: live.filter(rule => rule.type !== 'ProcessName' && rule.type !== 'ProcessPathRegex') }
  assert.throws(() => verifyDeviceExit(tun, missingUu, config, 0), /device-rules-required/)
  const diverted = { rules: live.map(rule => rule.type === 'Match' ? { ...rule, proxy: '入口选择' } : rule) }
  assert.throws(() => verifyDeviceExit(tun, diverted, config, 0), /device-rules-required/)
  const udpDirect = { rules: live.map(rule => rule.type === 'Network' ? { ...rule, proxy: 'DIRECT' } : rule) }
  assert.throws(() => verifyDeviceExit(tun, udpDirect, config, 0), /device-rules-required/)
  const openV6 = { rules: live.map(rule => rule.payload === '::/0' ? { ...rule, proxy: 'DIRECT' } : rule) }
  assert.throws(() => verifyDeviceExit(tun, openV6, config, 0), /device-rules-required/)
})

test('verifyDeviceExit still accepts the generated IPCIDR6 form of the IPv6 reject', () => {
  const config = { deviceWide: true, allowUURemote: true, pinnedProxy: 'pinned' }
  const rules = { rules: deviceExitRules(config).map(text => {
    if (text.startsWith('PROCESS-NAME,')) {
      const rest = text.slice('PROCESS-NAME,'.length)
      const index = rest.lastIndexOf(',')
      return { type: 'ProcessName', payload: rest.slice(0, index), proxy: rest.slice(index + 1) }
    }
    if (text.startsWith('PROCESS-PATH-REGEX,')) {
      const rest = text.slice('PROCESS-PATH-REGEX,'.length)
      const index = rest.lastIndexOf(',')
      return { type: 'ProcessPathRegex', payload: rest.slice(0, index), proxy: rest.slice(index + 1) }
    }
    if (text === 'NETWORK,UDP,REJECT') return { type: 'Network', payload: 'udp', proxy: 'REJECT' }
    if (text.startsWith('IP-CIDR6,::/0,REJECT')) return { type: 'IPCIDR6', payload: '::/0', proxy: 'REJECT' }
    if (text.startsWith('MATCH,')) return { type: 'Match', proxy: text.slice('MATCH,'.length) }
    throw new Error(text)
  }) }
  assert.doesNotThrow(() => verifyDeviceExit(tunConfigs(), rules, config, 0))
})

const pinnedTail = c => [
  { type: 'Network', payload: 'udp', proxy: 'REJECT' },
  { type: 'IPCIDR', payload: '::/0', proxy: 'REJECT' },
  { type: 'Match', payload: '', proxy: c.pinnedProxy },
]

test('UU Remote exception is off by default: only the 3-rule pinned tail', () => {
  const config = { deviceWide: true, pinnedProxy: 'GuardNookShare-Pinned' }
  assert.deepEqual(deviceExitRules(config), ['NETWORK,UDP,REJECT', 'IP-CIDR6,::/0,REJECT,no-resolve', 'MATCH,GuardNookShare-Pinned'])
  assert.deepEqual(deviceExitRules({ ...config, allowUURemote: false }), deviceExitRules(config))
  // No process matching is required when there are no PROCESS-* rules.
  const tun = tunConfigs({ 'find-process-mode': 'off' })
  assert.doesNotThrow(() => verifyDeviceExit(tun, { rules: pinnedTail(config) }, config, 0))
})

test('allowUURemote puts the UU DIRECT rules first, before the pinned tail', () => {
  const config = { deviceWide: true, allowUURemote: true, pinnedProxy: 'GuardNookShare-Pinned' }
  const rules = deviceExitRules(config)
  assert.deepEqual(rules.slice(0, uuRemoteExceptionRules().length), uuRemoteExceptionRules())
  assert.deepEqual(rules.slice(-3), ['NETWORK,UDP,REJECT', 'IP-CIDR6,::/0,REJECT,no-resolve', 'MATCH,GuardNookShare-Pinned'])
  assert.throws(() => verifyDeviceExit(tunConfigs({ 'find-process-mode': 'off' }), { rules: liveMihomoDeviceTail(config) }, config, 0), /device-process-mode/)
})

test('verifyDeviceExit fails when loaded UU rules do not match allowUURemote', () => {
  const off = { deviceWide: true, allowUURemote: false, pinnedProxy: 'GuardNookShare-Pinned' }
  const on = { ...off, allowUURemote: true }
  // UU rules loaded but the flag is off.
  assert.throws(() => verifyDeviceExit(tunConfigs(), { rules: liveMihomoDeviceTail(off) }, off, 0), /device-rules-required/)
  // Flag on but only the 3-rule tail is loaded.
  assert.throws(() => verifyDeviceExit(tunConfigs(), { rules: pinnedTail(on) }, on, 0), /device-rules-required/)
})
