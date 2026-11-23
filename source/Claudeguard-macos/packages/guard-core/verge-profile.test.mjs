import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStandaloneProfile, installVergeProfile, standaloneProfileName, standaloneStatus } from './verge-profile.mjs'
import { desktopRoot } from './desktop-common.mjs'
import { originalBackup, prepareDeviceVerge, restoreVergeScript, vergePaths } from './verge.mjs'

const VERGE_RELATIVE = 'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev'

const PROFILES = `# Profiles Config for Clash Verge
current: orig1
items:
- uid: orig1
  type: remote
  name: 追云加速
  url: https://subscription.invalid/one
  file: orig1.yaml
  updated: 1700000000
- uid: orig2
  type: remote
  name: 家宽链式代理
  url: https://subscription.invalid/two
  file: orig2.yaml
  updated: 1700000001
`

const SHARE_SCRIPT = [
  'function main(config) {',
  '  // GN-Exit and GuardNookShare-Pinned are rewritten here',
  '  return config',
  '}',
  '',
].join('\n')

const FOREIGN_SCRIPT = 'function main(config) {\n  // personal GuardNook-Claude script\n  return config\n}\n'

function shareConfig(overrides = {}) {
  return {
    expectedIP: '204.245.140.87',
    controllerSocket: '/tmp/verge/verge-mihomo.sock',
    controllerURL: '',
    controllerSecret: '',
    selectedProxy: 'GN-Exit',
    coverageVersion: 1,
    targetPlatform: 'darwin',
    frozenExitProxy: '',
    frozenSources: [],
    upstreamBindings: {},
    upstreamChain: [],
    policyGroup: 'GuardNookShare-Claude',
    pinnedProxy: 'GuardNookShare-Pinned',
    pinnedEntry: 'GuardNookShare-Entry',
    gatewayProxy: 'GuardNookShare-Gateway',
    gatewayPort: 19904,
    probePort: 19903,
    clientPort: 19901,
    serverPort: 19791,
    intervalMs: 3000,
    timeoutMs: 10000,
    leaseMs: 20000,
    recoverySamples: 3,
    deviceWide: true,
    publicTunExit: false,
    publicProxyExit: false,
    kernelProcessPath: '',
    requireTun: true,
    guardGoogleAuth: false,
    proxyUser: 'claude-guard',
    proxyPassword: 'a'.repeat(64),
    gatewayAllowlist: null,
    clientID: 'verge',
    startProtected: true,
    relay: {
      id: '0123456789abcdef0123456789abcdef',
      host: '204.245.140.87',
      port: 3000,
      checkPort: 24958,
      auth: true,
      confirmed: true,
      keyword: '',
      nodes: ['入口A', '入口B'],
    },
    ...overrides,
  }
}

const VERGE_SETTINGS = 'enable_tun_mode: false\nenable_dns_settings: true\nenable_system_proxy: false\n'

const credentials = { username: 'relay', password: 'secret' }

async function fakeVerge({ script = SHARE_SCRIPT } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'gn-profile-'))
  const dir = join(home, VERGE_RELATIVE)
  await mkdir(join(dir, 'profiles'), { recursive: true })
  await writeFile(join(dir, 'verge.yaml'), VERGE_SETTINGS, { mode: 0o644 })
  await writeFile(join(dir, 'profiles.yaml'), PROFILES, { mode: 0o644 })
  await writeFile(join(dir, 'profiles', 'orig1.yaml'), 'proxies: []\n', { mode: 0o600 })
  await writeFile(join(dir, 'profiles', 'orig2.yaml'), 'proxies: []\n', { mode: 0o600 })
  if (script !== null) await writeFile(join(dir, 'profiles', 'Script.js'), script, { mode: 0o600 })
  return home
}

test('独立订阅名称使用固定格式', () => {
  assert.equal(standaloneProfileName('204.245.140.87'), 'GuardNook：204.245.140.87')
})

test('生成的订阅只有四个分组、三个本机入口和守护规则', () => {
  const { config, text } = buildStandaloneProfile(shareConfig(), { originalUid: 'orig1', credentials })
  assert.deepEqual(config['proxy-groups'].map(group => group.name),
    ['入口选择', '出口选择', 'GuardNookShare-Pinned', 'GuardNookShare-Claude'])
  assert.deepEqual(config.listeners.map(listener => listener.name),
    ['GN-entry-check', 'GuardNook-client', 'Claude-guard-probe'])
  assert.equal(config['proxy-providers']['gn-entry'].path, 'profiles/orig1.yaml')
  assert.equal(config.rules[0], 'AND,((DOMAIN-SUFFIX,claude.ai),(NETWORK,UDP),(DST-PORT,443)),REJECT')
  assert.deepEqual(config.rules.slice(-3), ['NETWORK,UDP,REJECT', 'IP-CIDR6,::/0,REJECT,no-resolve', 'MATCH,GuardNookShare-Pinned'])
  assert.equal(config.mode, 'rule')
  assert.equal(config.tun.enable, true)
  const exit = config.proxies.find(proxy => proxy.name === 'GN-Exit')
  assert.equal(exit.type, 'socks5')
  assert.equal(exit.server, '204.245.140.87')
  assert.equal(exit.port, 3000)
  assert.equal(exit['dialer-proxy'], '入口选择')
  assert.match(text, /^mode: 'rule'$/m)
  assert.match(text, /^  gn-entry:$/m)
  assert.doesNotMatch(text, /204\.245\.140\.87:3000/)
})

test('安装后写入独立订阅、切为当前项并保留原订阅', async () => {
  const home = await fakeVerge()
  const result = await installVergeProfile({ home, config: shareConfig(), credentials, now: 1700000002000 })
  assert.equal(result.name, 'GuardNook：204.245.140.87')
  assert.equal(result.originalUid, 'orig1')
  assert.equal(result.reused, false)
  assert.match(result.uid, /^l[0-9A-Za-z]{11}$/)
  assert.equal(result.scriptNeutralized, true)

  const paths = vergePaths(home)
  const list = await readFile(paths.profilesYaml, 'utf8')
  assert.match(list, new RegExp(`^current: ${result.uid}$`, 'm'))
  assert.match(list, /name: 追云加速/)
  assert.match(list, /name: 家宽链式代理/)
  assert.ok(list.includes(`name: GuardNook：204.245.140.87`))
  assert.equal((list.match(/^- uid: /gm) || []).length, 3)

  const profile = await stat(result.profilePath)
  assert.equal(profile.mode & 0o777, 0o600)
  assert.equal(await readFile(result.profilePath, 'utf8'), buildStandaloneProfile(shareConfig(), { originalUid: 'orig1', credentials }).text)

  const backup = await stat(result.profilesBackupPath)
  assert.equal(backup.mode & 0o777, 0o600)
  assert.equal(await readFile(result.profilesBackupPath, 'utf8'), PROFILES)

  assert.equal(await readFile(paths.script, 'utf8'), 'function main(config) {\n  return config;\n}\n')
  assert.ok(result.scriptBackupPath)
  assert.equal((await stat(result.scriptBackupPath)).mode & 0o777, 0o600)
  assert.equal(await readFile(result.scriptBackupPath, 'utf8'), SHARE_SCRIPT)

  const record = JSON.parse(await readFile(join(desktopRoot(home), 'standalone.json'), 'utf8'))
  assert.equal(record.uid, result.uid)
  assert.equal(record.originalUid, 'orig1')
  assert.equal((await stat(join(desktopRoot(home), 'standalone.json'))).mode & 0o777, 0o600)

  assert.deepEqual(await standaloneStatus(home), {
    installed: true,
    selected: true,
    uid: result.uid,
    name: 'GuardNook：204.245.140.87',
    originalUid: 'orig1',
    current: result.uid,
  })
})

test('重复安装复用同一个独立订阅', async () => {
  const home = await fakeVerge()
  const first = await installVergeProfile({ home, config: shareConfig(), credentials, now: 1700000002000 })
  const second = await installVergeProfile({ home, config: shareConfig(), credentials, now: 1700000003000 })
  assert.equal(second.uid, first.uid)
  assert.equal(second.reused, true)
  assert.equal(second.scriptNeutralized, false)
  const list = await readFile(vergePaths(home).profilesYaml, 'utf8')
  assert.equal((list.match(/GuardNook：/g) || []).length, 1)
  assert.equal((list.match(/^- uid: /gm) || []).length, 3)
  const backups = await readdir(join(desktopRoot(home), 'Backups/verge-profile'))
  assert.equal(backups.filter(name => name.startsWith('profiles.')).length, 2)
  assert.equal(backups.filter(name => name.startsWith('verge.')).length, 1)
})

test('非 GuardNook 的全局扩展脚本不被改写', async () => {
  const home = await fakeVerge({ script: FOREIGN_SCRIPT })
  const result = await installVergeProfile({ home, config: shareConfig(), credentials })
  assert.equal(result.scriptNeutralized, false)
  assert.equal(result.scriptBackupPath, null)
  assert.equal(await readFile(vergePaths(home).script, 'utf8'), FOREIGN_SCRIPT)
})

test('原订阅文件缺失时停止写入', async () => {
  const home = await fakeVerge()
  const paths = vergePaths(home)
  await writeFile(paths.profilesYaml, 'current: missing\n- uid: missing\n  type: remote\n  name: 缺失\n')
  await assert.rejects(installVergeProfile({ home, config: shareConfig(), credentials }), /原订阅文件不存在/)
})

test('没有可用的原订阅时给出明确错误', async () => {
  const home = await fakeVerge()
  const paths = vergePaths(home)
  await writeFile(paths.profilesYaml, 'current: GuardNook：204.245.140.87\n- uid: l12345678901\n  type: local\n  name: GuardNook：204.245.140.87\n  file: l12345678901.yaml\n')
  await assert.rejects(installVergeProfile({ home, config: shareConfig(), credentials }), /找不到可用的原订阅/)
})

test('缺少凭据时不生成独立订阅', () => {
  assert.throws(() => buildStandaloneProfile(shareConfig(), { originalUid: 'orig1', credentials: null }),
    /无法读取保存的 SOCKS5 凭据/)
})

test('恢复原脚本取最早的原始备份，跳过备份里的空脚本与 GuardNook 脚本', async () => {
  const home = await fakeVerge({ script: SHARE_SCRIPT })
  const dir = join(desktopRoot(home), 'Backups', 'verge-global-script')
  await mkdir(dir, { recursive: true })
  const noop = 'function main(config) {\n  return config;\n}\n'
  const original = 'function main(config) {\n  // user script\n  return config\n}\n'
  for (const [name, text, stamp] of [
    ['Script.js.2026-11-22T10-00-00-000Z.aaaa1111.bak', original, 1],
    ['Script.js.2026-11-22T11-00-00-000Z.bbbb2222.bak', noop, 2],
    ['Script.js.2026-11-22T12-00-00-000Z.cccc3333.bak', SHARE_SCRIPT, 3],
  ]) {
    const file = join(dir, name)
    await writeFile(file, text)
    await utimes(file, stamp, stamp)
  }
  assert.equal(await originalBackup(home), join(dir, 'Script.js.2026-11-22T10-00-00-000Z.aaaa1111.bak'))
  const result = await restoreVergeScript({ home })
  assert.equal(result.restored, true)
  assert.equal(await readFile(vergePaths(home).script, 'utf8'), original)
})


test('独立订阅预检保持只读，安装时开启 TUN 并保留系统代理开关', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = vergePaths(home)
  await prepareDeviceVerge(home)
  assert.equal(await readFile(paths.settings, 'utf8'), VERGE_SETTINGS)
  const installed = await installVergeProfile({ home, config: shareConfig(), credentials })
  assert.equal(await readFile(installed.settingsBackupPath, 'utf8'), VERGE_SETTINGS)
  assert.equal((await stat(installed.settingsBackupPath)).mode & 0o777, 0o600)
  assert.equal(await readFile(paths.settings, 'utf8'),
    'enable_tun_mode: true\nenable_dns_settings: false\nenable_system_proxy: false\n')
  assert.equal((await stat(paths.settings)).mode & 0o777, 0o644)
  const retry = await installVergeProfile({ home, config: shareConfig(), credentials })
  assert.equal(retry.settingsBackupPath, null)
})

test('不明确的 TUN 设置会在写入任何订阅前停止', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = vergePaths(home)
  const malformed = VERGE_SETTINGS + 'enable_tun_mode: false\n'
  await writeFile(paths.settings, malformed)
  await assert.rejects(installVergeProfile({ home, config: shareConfig(), credentials }), /设置格式/)
  assert.equal(await readFile(paths.settings, 'utf8'), malformed)
  assert.equal(await readFile(paths.profilesYaml, 'utf8'), PROFILES)
  assert.equal(await readFile(paths.script, 'utf8'), SHARE_SCRIPT)
})


test('首次 profile-apply 打开 TUN，并安排启动后连续验证', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = desktopRoot(home)
  const base = shareConfig()
  const path = join(root, 'config.json')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify({ ...base, startProtected: false,
    expectedIP: '203.0.113.1', relay: { ...base.relay, confirmed: false } }), { mode: 0o600 })
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url))], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
    input: JSON.stringify({ operation: 'profile-apply', expectedIP: base.expectedIP, relayCredentials: credentials }),
  })
  assert.equal(result.status, 0, result.stdout)
  const config = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(config.expectedIP, base.expectedIP)
  assert.equal(config.startProtected, true)
  assert.match(await readFile(vergePaths(home).settings, 'utf8'), /^enable_tun_mode: true$/m)
})
