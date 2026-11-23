import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnvironmentRepair } from './environment-repair.mjs'
import { desktopRoot } from './desktop-common.mjs'
import { disableSetupIPv6 } from './setup-environment.mjs'

async function fixture(t, partial = false) {
  const home = await mkdtemp(join(tmpdir(), 'guardnook-ipv6-batch-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const state = { 'Wi-Fi': 'Off', 'Thunderbolt Bridge': 'Automatic', "Pat's USB": 'Link-local only', 'Test VPN': 'Automatic' }
  const approvals = []
  const execute = async (file, args) => {
    if (file.endsWith('/osascript')) {
      const [header, ...commands] = args.at(-1).split('\n')
      const record = (await manager.history()).history[0]
      assert.ok(['applying', 'restoring'].includes(record.status))
      const backup = JSON.parse(await readFile(join(desktopRoot(home), 'environment-backups-v2', record.id + '.json'), 'utf8'))
      assert.equal(backup.before['ipv6-batch'].length, 3)
      assert.equal(header, 'set -e')
      approvals.push(commands)
      for (const [index, command] of commands.entries()) {
        if (partial && approvals.length === 1 && index === 1) return { ok: false, text: '' }
        const option = command.match(/^\/usr\/sbin\/networksetup (\S+) /)?.[1]
        const service = command.includes("Pat'\\''s USB") ? "Pat's USB" : 'Thunderbolt Bridge'
        const mode = { '-setv6off': 'Off', '-setv6automatic': 'Automatic', '-setv6LinkLocal': 'Link-local only' }[option]
        assert.ok(mode)
        state[service] = mode
      }
      return { ok: true, text: '' }
    }
    assert.equal(file, '/usr/sbin/networksetup')
    if (args[0] === '-listallnetworkservices') return { ok: true, text: Object.keys(state).join('\n') }
    if (args[0] === '-listnetworkserviceorder') return { ok: true, text: Object.keys(state).map((name, index) =>
      `(${index + 1}) ${name}\n(Hardware Port: ${name}, Device: ${['en0', 'bridge0', 'en8', 'utun2'][index]})`).join('\n') }
    assert.equal(args[0], '-getinfo')
    return { ok: true, text: `IPv6: ${state[args[1]]}` }
  }
  const manager = createEnvironmentRepair({ home, execute })
  return { state, approvals, manager }
}

test('batch disables every eligible service with one authorization, skips WIFI already off and restores original modes', async t => {
  const { state, approvals, manager } = await fixture(t)
  assert.match((await disableSetupIPv6({ confirmed: true }, { manager })).note, /复查 2 个/)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].length, 2)
  assert.ok(approvals[0].every(command => command.includes('-setv6off') && !command.includes('Wi-Fi') && !command.includes('Test VPN')))
  assert.equal(state['Thunderbolt Bridge'], 'Off')
  assert.equal(state["Pat's USB"], 'Off')
  assert.equal(state['Test VPN'], 'Automatic')
  await disableSetupIPv6({ confirmed: true }, { manager })
  assert.equal(approvals.length, 1)
  const history = (await manager.history()).history
  const restored = await manager.restore(history[0].id)
  assert.equal(restored.history[0].status, 'restored')
  assert.equal(approvals.length, 2)
  assert.equal(state['Thunderbolt Bridge'], 'Automatic')
  assert.equal(state["Pat's USB"], 'Link-local only')
})

test('partial system changes remain recoverable without rewriting services that stayed unchanged', async t => {
  const { state, approvals, manager } = await fixture(t, true)
  await disableSetupIPv6({ confirmed: true }, { manager })
  const history = (await manager.history()).history
  assert.equal(history[0].status, 'partial')
  assert.equal(Object.values(state).filter(mode => mode === 'Off').length, 2)
  const restored = await manager.restore(history[0].id)
  assert.equal(restored.history[0].status, 'restored')
  assert.equal(approvals[1].length, 1)
})
