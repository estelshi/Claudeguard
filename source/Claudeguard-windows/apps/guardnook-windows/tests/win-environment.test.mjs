import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEnvironment, parseSystem, applyScript, elevationWrapper, validateBaseline, READ_SCRIPT, ELEVATE_CANCELLED } from '../src/win-environment.mjs'

// 假 Windows：按脚本内容模拟读取与修改，记录执行过的命令
function fakeWindows(initial = {}) {
  const sys = { timezone: 'China Standard Time', geoId: 45, region: 'CN', regionName: '中国', culture: 'zh-CN', languages: ['zh-Hans-CN', 'en-US'],
    adapters: [{ name: 'Wi-Fi', description: 'Intel Wi-Fi 6E', ipv6: true }, { name: '以太网 2', description: 'Realtek', ipv6: false }], ...initial }
  const log = [], elevatedLog = []
  const geo = { 244: 'US', 45: 'CN', 122: 'JP' }
  const exec = script => {
    let m
    if ((m = script.match(/tzutil\.exe \/s '([^']+)'/))) sys.timezone = m[1]
    if ((m = script.match(/Set-WinHomeLocation -GeoId (\d+)/))) { sys.geoId = Number(m[1]); sys.region = geo[m[1]] || '' }
    if ((m = script.match(/Set-Culture -CultureInfo '([^']+)'/))) sys.culture = m[1]
    for (const [, verb, name] of script.matchAll(/(Enable|Disable)-NetAdapterBinding -Name '((?:[^']|'')+)'/g)) {
      const adapter = sys.adapters.find(a => a.name === name.replaceAll("''", "'"))
      if (adapter) adapter.ipv6 = verb === 'Enable'
    }
  }
  const state = { sys, log, elevatedLog, failCulture: false, cancelUAC: false, failRead: false }
  state.powershell = async script => {
    log.push(script)
    if (script === READ_SCRIPT) return state.failRead ? { ok: false, code: 1, stdout: '' } : { ok: true, code: 0, stdout: '\uFEFF' + JSON.stringify(sys) }
    if (state.failCulture && /Set-Culture/.test(script)) return { ok: false, code: 1, stdout: '' }
    exec(script); return { ok: true, code: 0, stdout: '' }
  }
  state.elevated = async script => {
    elevatedLog.push(script)
    if (state.cancelUAC) return { ok: false, code: ELEVATE_CANCELLED, cancelled: true }
    exec(script); return { ok: true, code: 0, cancelled: false }
  }
  return state
}
async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'gn-env-'))
  const win = fakeWindows(options.sys)
  const env = createEnvironment({ dataDir: dir, powershell: win.powershell, elevated: win.elevated,
    resolve: async () => options.addresses ?? ['198.18.0.12'],
    guardStatus: () => options.status ?? { state: 'protected', requireTun: true, tunEnabled: true },
    clashConfigs: async () => options.configs ?? { ipv6: false, tun: { enable: true } },
    exitProbe: () => ({ ok: true, location: 'US' }), now: (() => { let t = 1e12; return () => t += 1000 })() })
  return { dir, win, env }
}
const strictUS = { template: 'strict', country: 'US', region: 'US', timezone: 'Pacific Standard Time', culture: 'en-US', language: 'en-US' }

test('parses PowerShell JSON with BOM, single values and unknown IPv6 bindings', () => {
  const sys = parseSystem('\uFEFF{"timezone":"UTC ","geoId":244,"region":"US","culture":"en-US","languages":"en-US","adapters":{"name":"Wi-Fi","ipv6":null}}')
  assert.equal(sys.timezone, 'UTC'); assert.deepEqual(sys.languages, ['en-US']); assert.equal(sys.adapters[0].ipv6, null)
  assert.throws(() => parseSystem('not json'), /无法读取/)
})

test('baseline validation rejects injection-shaped values', () => {
  assert.throws(() => validateBaseline({ ...strictUS, timezone: "x'; Remove-Item C:\\" }), /时区/)
  assert.throws(() => validateBaseline({ ...strictUS, culture: 'en-US; calc' }), /区域格式/)
  assert.throws(() => validateBaseline({ ...strictUS, template: 'lax' }), /模板/)
  assert.throws(() => validateBaseline({ ...strictUS, country: 'usa' }), /出口国家/)
  assert.deepEqual(validateBaseline(strictUS), strictUS)
})

test('commands quote adapter names and the elevation wrapper reports UAC cancel as 1223', () => {
  assert.equal(applyScript('ipv6:Bob\'s LAN', false), "Disable-NetAdapterBinding -Name 'Bob''s LAN' -ComponentID ms_tcpip6 -Confirm:$false -ErrorAction Stop")
  assert.throws(() => applyScript('timezone', "a'b"), /无效/)
  assert.throws(() => applyScript('region', { geoId: 'x' }), /无效/)
  const wrapper = elevationWrapper('Disable-NetAdapterBinding -Name \'Wi-Fi\'')
  assert.match(wrapper, /-Verb RunAs/); assert.match(wrapper, /exit 1223/)
  assert.doesNotMatch(wrapper, /Wi-Fi/) // 内层脚本只以 EncodedCommand 传递
})

test('general template records the current system as target on first check; only TUN can block', async () => {
  const { env, dir } = await setup({ configs: { ipv6: true } })
  const audit = await env.inspect()
  assert.equal(audit.policy.template, 'standard'); assert.equal(audit.policy.timezone, 'China Standard Time')
  assert.equal(audit.ready, true)
  assert.deepEqual(audit.rows.filter(r => r.blocking).map(r => r.id), ['tun'])
  assert.equal(audit.rows.find(r => r.id === 'ipv6:Wi-Fi').state, 'warn')
  assert.equal(audit.rows.find(r => r.id === 'ipv6:以太网 2').state, 'ok')
  assert.ok((await readdir(dir)).includes('environment-baseline.json'))
})

test('IPv6 blocks under a TUN-required guard when Clash does not take over IPv6', async () => {
  const { env } = await setup({ configs: { ipv6: false } })
  const audit = await env.inspect()
  const wifi = audit.rows.find(r => r.id === 'ipv6:Wi-Fi')
  assert.equal(wifi.blocking, true); assert.equal(wifi.state, 'fail'); assert.equal(audit.ready, false)
  assert.deepEqual(audit.blockingKeys, ['ipv6:Wi-Fi'])
})

test('strict template: preview shows old→new, preselects only blocking; language is manual only', async () => {
  const { env } = await setup({ configs: { ipv6: true } })
  await env.saveBaseline({ ...strictUS, template: 'standard' })
  let preview = await env.preview()
  assert.deepEqual(preview.plan.map(p => p.key).sort(), ['culture', 'ipv6:Wi-Fi', 'region', 'timezone'])
  assert.ok(preview.plan.every(p => !p.selected), 'general template preselects nothing')
  assert.equal(preview.manual[0].id, 'language')
  await env.saveBaseline(strictUS)
  preview = await env.preview()
  const tz = preview.plan.find(p => p.key === 'timezone')
  assert.equal(tz.before, 'China Standard Time'); assert.equal(tz.after, 'Pacific Standard Time'); assert.equal(tz.selected, true)
  assert.equal(preview.plan.find(p => p.key === 'ipv6:Wi-Fi').admin, true)
  assert.equal(preview.plan.find(p => p.key === 'region').after, 'US')
})

test('apply saves a restore point first, applies selected only, verifies, and restore rewinds newest-first', async () => {
  const { env, win, dir } = await setup()
  await env.saveBaseline(strictUS)
  const preview = await env.preview()
  const plan = preview.plan.map(p => p.key)
  const result = await env.apply({ plan, keys: ['timezone', 'ipv6:Wi-Fi'], planToken: preview.planToken })
  assert.equal(result.status, 'applied')
  assert.equal(win.sys.timezone, 'Pacific Standard Time'); assert.equal(win.sys.adapters[0].ipv6, false)
  assert.equal(win.sys.culture, 'zh-CN', 'unselected item untouched')
  assert.equal(win.elevatedLog.length, 1)
  const files = await readdir(join(dir, 'environment-backups'))
  assert.equal(files.length, 1)
  if (process.platform !== 'win32') assert.equal((await stat(join(dir, 'environment-backups', files[0]))).mode & 0o777, 0o600)
  const saved = JSON.parse(await readFile(join(dir, 'environment-backups', files[0]), 'utf8'))
  assert.equal(saved.before.timezone, 'China Standard Time'); assert.equal(saved.before['ipv6:Wi-Fi'], true)

  // 第二次修改：区域格式
  const second = await env.preview(['culture'])
  await env.apply({ plan: ['culture'], keys: ['culture'], planToken: second.planToken })
  const { history } = await env.history()
  assert.equal(history.length, 2)
  await assert.rejects(env.restore(history[1].id), /先恢复更新/)
  assert.equal((await env.restore(history[0].id)).status, 'restored'); assert.equal(win.sys.culture, 'zh-CN')
  const back = await env.restore(history[1].id)
  assert.equal(back.status, 'restored')
  assert.equal(win.sys.timezone, 'China Standard Time'); assert.equal(win.sys.adapters[0].ipv6, true)
  assert.equal((await env.restore(history[1].id)).note, '这次更改已经恢复过。')
})

test('a plan becomes invalid if the system changes after preview', async () => {
  const { env, win } = await setup()
  await env.saveBaseline(strictUS)
  const preview = await env.preview()
  win.sys.timezone = 'Tokyo Standard Time'
  await assert.rejects(env.apply({ plan: preview.plan.map(p => p.key), keys: ['timezone'], planToken: preview.planToken }), /预览后变了/)
  await assert.rejects(env.apply({ plan: ['timezone'], keys: ['culture'], planToken: preview.planToken }), /不在预览里/)
  await assert.rejects(env.apply({ plan: ['timezone'], keys: ['timezone'] }), /先预览/)
})

test('declined UAC and a failed command leave a partial record that can be restored', async () => {
  const { env, win } = await setup()
  await env.saveBaseline(strictUS)
  win.cancelUAC = true; win.failCulture = true
  const preview = await env.preview()
  const result = await env.apply({ plan: preview.plan.map(p => p.key), keys: ['timezone', 'culture', 'ipv6:Wi-Fi'], planToken: preview.planToken })
  assert.equal(result.status, 'partial')
  assert.ok(result.outcomes.some(o => /取消了管理员授权/.test(o)))
  assert.ok(result.outcomes.some(o => /时区：已修改/.test(o)))
  assert.equal(win.sys.adapters[0].ipv6, true)
  win.cancelUAC = false; win.failCulture = false
  const restored = await env.restore(result.history[0].id)
  assert.equal(restored.status, 'restored'); assert.equal(win.sys.timezone, 'China Standard Time')
  assert.equal(win.elevatedLog.length, 1, 'restore does not touch IPv6 that never changed')
})

test('restore stops instead of overwriting a setting changed by something else', async () => {
  const { env, win } = await setup()
  await env.saveBaseline(strictUS)
  const preview = await env.preview(['timezone'])
  const result = await env.apply({ plan: ['timezone'], keys: ['timezone'], planToken: preview.planToken })
  win.sys.timezone = 'Tokyo Standard Time'
  const restored = await env.restore(result.history[0].id)
  assert.equal(restored.status, 'restore-partial'); assert.match(restored.note, /被改过/)
  assert.equal(win.sys.timezone, 'Tokyo Standard Time')
})

test('unknown or unsupported keys and tampered records are refused', async () => {
  const { env, dir } = await setup()
  await env.saveBaseline({ ...strictUS, region: 'ZZ' })
  const audit = await env.inspect()
  assert.equal(audit.rows.find(r => r.id === 'region').fixable, false, 'region without GeoId mapping is manual')
  await assert.rejects(env.preview(['region']), /不能自动修复/)
  await assert.rejects(env.preview(['language']), /不能自动修复/)
  await assert.rejects(env.restore('../../etc/passwd'), /无效/)
  await env.history()
  const id = '11111111-2222-3333-4444-555555555555'
  await writeFile(join(dir, 'environment-backups', id + '.json'), JSON.stringify({ version: 1, id, at: 1, keys: ['rm -rf'], before: {}, after: {}, status: 'applied' }))
  await assert.rejects(env.restore(id), /格式无效/)
})

test('unconfigured guard: TUN is informational and failure to read Windows is reported in Chinese', async () => {
  const { env, win } = await setup({ status: { state: 'unconfigured' }, addresses: ['104.18.1.1'] })
  const audit = await env.inspect()
  assert.equal(audit.rows.find(r => r.id === 'tun').state, 'info')
  assert.equal(audit.rows.find(r => r.id === 'dns').state, 'warn')
  win.failRead = true
  await assert.rejects(env.inspect(), /无法读取 Windows 设置/)
})
