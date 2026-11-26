import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicJSON, readTheme, writeTheme, THEME_CHROME } from '../src/storage.mjs'
import { privateDirectory, ACL_MARKER } from '../src/private-dir.mjs'
import { createRelayVault } from '../src/relay-vault.mjs'
import { createRuntime, describeStartError } from '../src/runtime.mjs'
import { trayMenuKey, trayMenuItems } from '../src/taskbar.mjs'
import { portableConfig } from '../../../packages/guard-core/setup.mjs'

const core = fileURLToPath(new URL('../../../packages/guard-core', import.meta.url))
const temp = async (t, prefix) => { const dir = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir }
const freePort = async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port
}
const fourPorts = async () => { const ports = new Set(); while (ports.size < 4) ports.add(await freePort()); return [...ports] }
const fakeController = async (t, tun = true) => {
  const server = createServer((req, res) => {
    const value = req.url === '/version' ? { version: 'test-mihomo' }
      : req.url === '/proxies' ? { proxies: { Entry: { type: 'Trojan' }, Other: { type: 'Trojan' } } }
      : req.url === '/configs' ? { mode: 'rule', tun: { enable: tun } } : req.url === '/rules' ? { rules: [] } : { connections: [] }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return `http://127.0.0.1:${server.address().port}`
}

// ---------- 1. privateDirectory ----------
test('fix 1: icacls runs once, a failure is logged and never blocks startup', async t => {
  const dir = join(await temp(t, 'cg-acl-'), 'data')
  const calls = [], logs = []
  const exec = async (file, args) => { calls.push(file); return { stdout: file === 'whoami.exe' ? '"pc\\\\estel","S-1-5-21-1-2-3-1001"' : '' } }
  assert.deepEqual(await privateDirectory(dir, { platform: 'win32', exec, log: m => logs.push(m) }), { applied: true })
  assert.deepEqual(calls, ['whoami.exe', 'icacls.exe'])
  await readFile(join(dir, ACL_MARKER), 'utf8')
  assert.equal((await privateDirectory(dir, { platform: 'win32', exec })).reason, 'already-applied')
  assert.equal(calls.length, 2, 'second launch skips whoami and icacls')

  const broken = join(await temp(t, 'cg-acl-'), 'data')
  const failing = async () => { throw Object.assign(new Error('Access is denied'), { code: 5 }) }
  const result = await privateDirectory(broken, { platform: 'win32', exec: failing, log: m => logs.push(m) })
  assert.equal(result.reason, 'failed')
  assert.equal(logs.length, 1)
  assert.ok((await readdir(broken)).every(name => name !== ACL_MARKER), 'no marker, so the next launch retries')
  assert.equal((await privateDirectory(join(broken, 'x'), { platform: 'linux', exec: failing })).reason, 'not-windows')
})

// ---------- 2. atomicJSON retry + block write failure ----------
test('fix 2: atomic writes retry a locked target and clean the temp file when they give up', async t => {
  const dir = await temp(t, 'cg-atomic-')
  const target = join(dir, 'state.json')
  let attempts = 0
  const flaky = async (from, to) => {
    attempts++
    if (attempts < 3) throw Object.assign(new Error('locked'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' })
    const { rename } = await import('node:fs/promises'); return rename(from, to)
  }
  await atomicJSON(target, { manual: true }, { rename: flaky, backoffMs: 1 })
  assert.equal(attempts, 3)
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { manual: true })

  let tries = 0
  const locked = async () => { tries++; throw Object.assign(new Error('locked'), { code: 'EACCES' }) }
  await assert.rejects(atomicJSON(target, { manual: false }, { rename: locked, attempts: 4, backoffMs: 1 }), /locked/)
  assert.equal(tries, 4)
  const fatal = async () => { tries++; throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
  tries = 0
  await assert.rejects(atomicJSON(target, {}, { rename: fatal, backoffMs: 1 }), /gone/)
  assert.equal(tries, 1, 'non-lock errors are not retried')
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
})

test('fix 2: a failed manual-block write still blocks, reports in Chinese and leaves no unhandled rejection', async t => {
  const dir = await temp(t, 'cg-block-')
  const url = await fakeController(t)
  const [serverPort, clientPort, probePort, gatewayPort] = await fourPorts()
  await writeFile(join(dir, 'config.json'), JSON.stringify(portableConfig({ targetPlatform: 'win32', controllerSocket: '', controllerURL: url,
    expectedIP: '203.0.113.1', selectedProxy: 'Entry', requireTun: true, serverPort, clientPort, probePort, gatewayPort }, 'a'.repeat(64))))
  const runtime = await createRuntime(core, dir)
  t.after(() => runtime.stop())
  await runtime.start()
  await rm(join(dir, 'state.json'), { force: true })
  await mkdir(join(dir, 'state.json')) // rename onto a directory fails (EISDIR / EPERM)
  const unhandled = []
  const onUnhandled = reason => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  t.after(() => process.off('unhandledRejection', onUnhandled))
  await assert.rejects(runtime.action('block'), /已阻断 Claude，但无法保存/)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(unhandled.length, 0)
  assert.equal(runtime.status().manual, true)
  assert.equal(runtime.status().gateway.open, false)
})

// ---------- 3. tray menu ----------
test('fix 3: the tray menu is rebuilt when the config appears, so 重新验证 becomes available', () => {
  const grey = { key: 'unconfigured', label: '待导入守护规则' }
  assert.notEqual(trayMenuKey(grey, false), trayMenuKey(grey, true))
  const label = (items, text) => items.find(item => item.label === text)
  assert.equal(label(trayMenuItems(grey, false), '重新验证').enabled, false)
  assert.equal(label(trayMenuItems(grey, true), '重新验证').enabled, true)
  assert.equal(label(trayMenuItems(grey, true), '立即阻断 Claude').enabled, false)
  assert.equal(label(trayMenuItems({ key: 'protected', label: '保护中' }, true), '立即阻断 Claude').enabled, true)
})

// ---------- 4 + 6. save with a busy port; relay secrets pruned ----------
test('fix 4 + 6: a saved config whose gateway port is busy reports why, and old relay secrets are pruned', async t => {
  const dir = await temp(t, 'cg-save-')
  const url = await fakeController(t)
  const [serverPort, clientPort, probePort, gatewayPort] = await fourPorts()
  const vault = new Map()
  const removed = []
  const runtime = await createRuntime(core, dir, {
    storeRelayCredentials: async (id, credentials) => { vault.set(id, credentials) },
    loadRelayCredentials: async id => vault.get(id),
    removeRelayCredentials: async id => { vault.delete(id) },
    pruneRelayCredentials: async keep => { for (const id of [...vault.keys()]) if (id !== keep) { vault.delete(id); removed.push(id) } },
  })
  t.after(() => runtime.stop())
  const input = { exitMode: 'relay', confirmChanges: true, deviceWide: true, entry: { nodes: ['Entry'] }, controllerURL: url,
    serverPort, clientPort, probePort, gatewayPort }
  const first = await runtime.save({ ...input, relayLink: 'socks5://one:pw1@198.51.100.8:1080' })
  const firstID = first.settings.relay.id
  assert.deepEqual([...vault.keys()], [firstID])

  // Occupy the gateway port, then save a different relay.
  await runtime.stop()
  const blocker = net.createServer(); blocker.listen(gatewayPort, '127.0.0.1'); await once(blocker, 'listening')
  t.after(() => new Promise(resolve => blocker.close(resolve)))
  await assert.rejects(runtime.save({ ...input, relayLink: 'socks5://two:pw2@198.51.100.9:1080' }), new RegExp(`配置已保存，但端口 ${gatewayPort} 已被其他程序占用`))
  const status = runtime.status()
  assert.equal(status.state, 'unconfigured')
  assert.match(status.reason, /端口 \d+ 已被其他程序占用/)
  assert.ok(runtime.settings(), 'the new config was written')
  const secondID = runtime.settings().relay.id
  assert.notEqual(secondID, firstID)
  assert.deepEqual([...vault.keys()], [secondID], 'the replaced relay secret was deleted')
  assert.deepEqual(removed, [firstID])

  // A failed relay save removes the secret it just stored and keeps the current one.
  await assert.rejects(runtime.save({ ...input, entry: { nodes: ['Missing'] }, relayLink: 'socks5://three:pw3@198.51.100.10:1080' }))
  assert.deepEqual([...vault.keys()], [secondID])

  // Switching to an existing fixed node drops every relay secret.
  await new Promise(resolve => blocker.close(resolve))
  await runtime.save({ exitMode: 'existing', confirmChanges: true, controllerURL: url, selectedProxy: 'Other', expectedIP: '203.0.113.7',
    requireTun: true, serverPort, clientPort, probePort, gatewayPort })
  assert.deepEqual([...vault.keys()], [])
  assert.equal(runtime.status().state === 'unconfigured', false)
})

test('fix 6: the vault prunes only relay secret files other than the current one', async t => {
  const dir = await temp(t, 'cg-prune-')
  const keep = 'a'.repeat(32), old = 'b'.repeat(32)
  for (const id of [keep, old]) await writeFile(join(dir, `relay-secret-${id}.json`), '{}')
  await writeFile(join(dir, 'config.json'), '{}')
  const vault = createRelayVault(dir, { isEncryptionAvailable: () => true })
  assert.deepEqual(await vault.prune(keep), [old])
  assert.deepEqual((await readdir(dir)).sort(), ['config.json', `relay-secret-${keep}.json`])
  await vault.remove(keep)
  assert.deepEqual(await readdir(dir), ['config.json'])
  await assert.rejects(vault.remove('../x'), /Invalid/)
})

test('start errors are explained in Chinese', () => {
  assert.match(describeStartError(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE', port: 19904 })), /端口 19904 已被其他程序占用/)
  assert.match(describeStartError(new Error('请重新保存 Windows 节点配置')), /^守护未启动：请重新保存/)
  assert.match(describeStartError(new Error('boom')), /^守护未启动。/)
})

test('外观: defaults to light, persists dark in appearance.json, ignores the old preferences.json and rejects other values', async t => {
  const dir = await temp(t, 'gn-theme-')
  assert.equal(await readTheme(dir), 'light')
  await writeFile(join(dir, 'preferences.json'), JSON.stringify({ theme: 'dark' }))
  assert.equal(await readTheme(dir), 'light', '0.1 preferences.json is not read')
  await writeFile(join(dir, 'appearance.json'), '{broken')
  assert.equal(await readTheme(dir), 'light', 'an unreadable file falls back to light')
  assert.equal(await writeTheme(dir, 'dark'), 'dark')
  assert.equal(await readTheme(dir), 'dark')
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'appearance.json'), 'utf8')), { theme: 'dark' })
  await assert.rejects(writeTheme(dir, 'system'), /外观设置无效/)
  assert.equal(await readTheme(dir), 'dark')
  assert.deepEqual(Object.keys(THEME_CHROME).sort(), ['dark', 'light'])
  assert.equal(THEME_CHROME.light.background, '#f4f4f7', 'light window chrome unchanged')
})
