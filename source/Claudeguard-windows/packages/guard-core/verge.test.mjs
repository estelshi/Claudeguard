import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDeviceVerge, applyVergeScript, latestBackup, parseProfilesYaml, readVergeState, restoreVergeScript, sha256, vergePaths, verifyVergeLoaded } from './verge.mjs'

const ORIGINAL = 'function main(config) { return config; }\n'
const SHARE_A = 'function main(config) { return config; }\n// 入口选择 GN-Exit GuardNookShare-Claude A\n'
const SHARE_B = 'function main(config) { return config; }\n// 入口选择 GN-Exit GuardNookShare-Claude B\n'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'gn-verge-'))
  const paths = vergePaths(home)
  await mkdir(join(paths.dir, 'profiles'), { recursive: true })
  await writeFile(paths.script, ORIGINAL, { mode: 0o600 })
  await writeFile(paths.profilesYaml, 'current: abc\nitems:\n- uid: other\n  type: script\n  name: null\n- uid: abc\n  type: remote\n  name: 追云加速\n')
  return { home, ...paths }
}

const modeOf = async path => (await lstat(path)).mode & 0o777

test('parseProfilesYaml finds the current subscription', () => {
  const parsed = parseProfilesYaml('current: abc\nitems:\n- uid: x\n  type: merge\n  name: null\n- uid: abc\n  type: remote\n  name: 追云加速\n')
  assert.equal(parsed.selected.uid, 'abc')
  assert.equal(parsed.selected.name, '追云加速')
})

test('readVergeState reports script hash and current profile', async () => {
  const { home, script } = await fixture()
  const state = await readVergeState(home)
  assert.equal(state.scriptExists, true)
  assert.equal(state.scriptSize, Buffer.byteLength(ORIGINAL))
  assert.equal(state.scriptSHA256, sha256(ORIGINAL))
  assert.equal(state.currentProfile.uid, 'abc')
})

test('apply backs up, writes atomically at 0600, and keeps no temp file', async () => {
  const { home, script } = await fixture()
  const result = await applyVergeScript({ home, scriptText: SHARE_A, now: 1700000000000 })
  assert.equal(result.applied, true)
  assert.equal(await readFile(script, 'utf8'), SHARE_A)
  assert.equal(result.scriptSHA256, sha256(SHARE_A))
  assert.equal(result.previousSHA256, sha256(ORIGINAL))
  assert.equal(await modeOf(script), 0o600)
  assert.equal(await readFile(result.backupPath, 'utf8'), ORIGINAL)
  assert.equal(await modeOf(result.backupPath), 0o600)
  assert.equal(await modeOf(join(result.backupPath, '..')), 0o700)
  assert.deepEqual(await readdir(join(script, '..')), ['Script.js'])
})

test('applying the same script is a no-op', async () => {
  const { home } = await fixture()
  await applyVergeScript({ home, scriptText: SHARE_A, now: 1700000000000 })
  const second = await applyVergeScript({ home, scriptText: SHARE_A, now: 1700000001000 })
  assert.equal(second.applied, false)
  assert.equal(second.unchanged, true)
})

test('restore returns the original script, skipping backups of earlier GuardNook scripts', async () => {
  const { home, script } = await fixture()
  await applyVergeScript({ home, scriptText: SHARE_A, now: 1700000000000 })
  await applyVergeScript({ home, scriptText: SHARE_B, now: 1700000001000 })
  const restored = await restoreVergeScript({ home })
  assert.equal(restored.restored, true)
  assert.equal(restored.scriptSHA256, sha256(ORIGINAL))
  assert.equal(await readFile(script, 'utf8'), ORIGINAL)
  assert.equal(await modeOf(script), 0o600)
})

test('restore skips an older share script backup without the Chinese label', async () => {
  const { home } = await fixture()
  await applyVergeScript({ home, scriptText: SHARE_A, now: 1700000000000 })
  const legacy = join(home, 'Library/Application Support/GuardNook Share/Backups/verge-global-script',
    'Script.js.2026-11-22T18-36-32-273Z.0990d9dc.bak')
  await writeFile(legacy, 'function main(config) { return config; }\n// GN-Entry GN-Exit GuardNookShare-Claude legacy\n', { mode: 0o600 })
  const newer = new Date(1800000000000)
  await utimes(legacy, newer, newer)
  const restored = await restoreVergeScript({ home })
  assert.equal(restored.scriptSHA256, sha256(ORIGINAL))
})

test('restore only has GuardNook backups to choose from', async () => {
  const { home, script } = await fixture()
  await applyVergeScript({ home, scriptText: SHARE_A, now: 1700000000000 })
  const original = await latestBackup(home)
  await rm(original)
  await assert.rejects(restoreVergeScript({ home }), /备份/)
  assert.equal(await readFile(script, 'utf8'), SHARE_A)
})

test('restore never writes a backup containing personal guard rules', async () => {
  const { home, script } = await fixture()
  await writeFile(script, ORIGINAL + '\n// Claude-guard-gateway\n')
  await applyVergeScript({ home, scriptText: SHARE_A, now: 1700000000000 })
  await assert.rejects(restoreVergeScript({ home }), /个人版/)
  assert.equal(await readFile(script, 'utf8'), SHARE_A)
})

test('restore rejects a backup outside the backup directory', async () => {
  const { home } = await fixture()
  await assert.rejects(restoreVergeScript({ home, backupPath: '/tmp/Script.js.1700000000000.abcd1234.bak' }), /位置异常/)
})

test('restore fails when no backup exists', async () => {
  const { home } = await fixture()
  await assert.rejects(restoreVergeScript({ home }), /备份/)
})

test('rejects a script that is not generated by GuardNook Share', async () => {
  const { home, script } = await fixture()
  await assert.rejects(applyVergeScript({ home, scriptText: 'function main(config) { return config; }' }), /不是 ClaudeGuard/)
  assert.equal(await readFile(script, 'utf8'), ORIGINAL)
})

test('rejects a personal edition script even if it carries share markers', async () => {
  const { home } = await fixture()
  await assert.rejects(applyVergeScript({ home,
    scriptText: SHARE_A + '// __beforeGuardNookContainment GuardNook-Gateway\n' }), /个人版/)
})

test('rejects a symlinked global script', async () => {
  const { home, script } = await fixture()
  const elsewhere = join(home, 'other.js')
  await writeFile(elsewhere, ORIGINAL, { mode: 0o600 })
  await rm(script)
  await symlink(elsewhere, script)
  await assert.rejects(applyVergeScript({ home, scriptText: SHARE_A }), /不是普通文件/)
})

test('rejects a missing global script instead of creating one', async () => {
  const { home, script } = await fixture()
  await rm(script)
  await assert.rejects(applyVergeScript({ home, scriptText: SHARE_A }), /未找到 Clash Verge/)
})

const BLOCK = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com']
  .map(domain => ({ type: 'AND', payload: `((DomainSuffix,${domain}) && (Network,udp) && (DstPort,443))`, proxy: 'REJECT' }))
  .concat({ type: 'Domain', payload: 'gn-abc.invalid', proxy: 'REJECT' })

test('verifyVergeLoaded requires entry, exit and the guard rule', async () => {
  const responses = {
    '/proxies': { proxies: { '入口选择': {}, 'GN-Exit': {}, 'GuardNookShare-Claude': {} } },
    '/rules': { rules: [...BLOCK, { type: 'DomainSuffix', payload: 'claude.ai', proxy: 'GuardNookShare-Claude' }] },
  }
  const controller = { request: async path => responses[path] }
  const config = { policyGroup: 'GuardNookShare-Claude' }
  const loaded = await verifyVergeLoaded({ config, relay: { id: 'abc' }, controller })
  assert.equal(loaded.loaded, true)
  assert.equal(loaded.entry, true)
  assert.equal(loaded.exit, true)
  assert.equal(loaded.guardRule, true)
  assert.equal(loaded.atTop, true)
  assert.equal(loaded.blockIndex, 0)
  assert.equal(loaded.reason, null)
})

test('verifyVergeLoaded reports rules shadowed by a foreign REJECT prefix', async () => {
  const foreign = [{ type: 'DomainSuffix', payload: 'claude.ai', proxy: 'REJECT' },
    { type: 'ProcessName', payload: 'Claude', proxy: 'REJECT' }]
  const responses = {
    '/proxies': { proxies: { '入口选择': {}, 'GN-Exit': {}, 'GuardNookShare-Claude': {} } },
    '/rules': { rules: [...foreign, ...BLOCK, { type: 'DomainSuffix', payload: 'claude.ai', proxy: 'GuardNookShare-Claude' }] },
  }
  const loaded = await verifyVergeLoaded({ config: { policyGroup: 'GuardNookShare-Claude' }, relay: { id: 'abc' },
    controller: { request: async path => responses[path] } })
  assert.equal(loaded.loaded, false)
  assert.equal(loaded.entry, true)
  assert.equal(loaded.exit, true)
  assert.equal(loaded.guardRule, true)
  assert.equal(loaded.atTop, false)
  assert.equal(loaded.blockIndex, 2)
  assert.equal(loaded.reason, 'rules-shadowed')
  assert.equal(loaded.shadowCount, 2)
  assert.deepEqual(loaded.shadow, ['DomainSuffix,claude.ai', 'ProcessName,Claude'])
})

test('verifyVergeLoaded reports not-loaded without the exit proxy', async () => {
  const responses = {
    '/proxies': { proxies: { '入口选择': {}, 'GuardNookShare-Claude': {} } },
    '/rules': { rules: [{ type: 'Domain', payload: 'gn-abc.invalid', proxy: 'REJECT' }] },
  }
  const loaded = await verifyVergeLoaded({ config: { policyGroup: 'GuardNookShare-Claude' }, relay: { id: 'abc' },
    controller: { request: async path => responses[path] } })
  assert.equal(loaded.loaded, false)
  assert.equal(loaded.exit, false)
  assert.equal(loaded.reason, 'not-loaded')
})

test('verifyVergeLoaded survives an unavailable controller', async () => {
  const loaded = await verifyVergeLoaded({ config: { policyGroup: 'GuardNookShare-Claude' }, relay: { id: 'abc' },
    controller: { request: async () => { throw new Error('Controller timeout') } } })
  assert.equal(loaded.loaded, false)
  assert.equal(loaded.reason, 'controller-unavailable')
})

test('readVergeState tolerates a missing script', async () => {
  const { home, script } = await fixture()
  await rm(script)
  const state = await readVergeState(home)
  assert.equal(state.scriptExists, false)
  assert.equal(state.scriptSHA256, null)
  const info = await stat(join(state.dir, 'profiles.yaml'))
  assert.equal(info.isFile(), true)
})


test('device activation updates only TUN and DNS toggles and refuses a personal script', async t => {
  const { home, settings, script } = await fixture()
  t.after(() => rm(home, { recursive: true, force: true }))
  const prefs = 'enable_tun_mode: false\nenable_dns_settings: true\nkeep_this: enabled\n'
  await writeFile(settings, prefs)
  const wide = SHARE_A + '// "deviceWide":true\n'
  await applyDeviceVerge({ home, scriptText: wide })
  assert.equal(await readFile(settings, 'utf8'), 'enable_tun_mode: true\nenable_dns_settings: false\nkeep_this: enabled\n')
  assert.equal(await readFile(script, 'utf8'), wide)
  await writeFile(script, '// Claude-guard-gateway')
  await writeFile(settings, prefs)
  await assert.rejects(applyDeviceVerge({ home, scriptText: wide }), /个人版/)
  assert.equal(await readFile(settings, 'utf8'), prefs)
})
