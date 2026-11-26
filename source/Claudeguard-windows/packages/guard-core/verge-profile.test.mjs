import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStandaloneProfile, installVergeProfile, parseYamlDocument, standaloneProfileName, standaloneStatus } from './verge-profile.mjs'
import { deviceExitRules, uuRemoteExceptionRules } from './device-exit.mjs'
import { desktopRoot } from './desktop-common.mjs'
import { planProfileApply, setUURemote } from './setup.mjs'
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


const ORIGIN = `# Clash origin fixture
mode: rule
allow-lan: true
ipv6: false
dns:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - 1.1.1.1
    - 8.8.8.8
  fallback: []
proxies:
  - name: 入口A
    type: http
    server: 127.0.0.1
    port: 8081
  - name: 入口B
    type: http
    server: 127.0.0.1
    port: 8082
  - name: 普通节点
    type: http
    server: 127.0.0.1
    port: 8083
proxy-groups:
  - name: 自动选择
    type: url-test
    proxies:
      - 入口A
      - 入口B
      - 普通节点
  - name: 追云加速
    type: select
    proxies: [自动选择, 入口A, 入口B, 普通节点]
  - name: 子集组
    type: select
    proxies:
      - 入口A
      - 入口B
rules:
  - DOMAIN-SUFFIX,example.com,追云加速
  - MATCH,追云加速
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
    expectedIP: '100.64.20.87',
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
      host: '100.64.20.87',
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
  await writeFile(join(dir, 'profiles', 'orig1.yaml'), ORIGIN, { mode: 0o600 })
  await writeFile(join(dir, 'profiles', 'orig2.yaml'), 'proxies: []\n', { mode: 0o600 })
  if (script !== null) await writeFile(join(dir, 'profiles', 'Script.js'), script, { mode: 0o600 })
  return home
}

test('独立订阅名称使用固定格式', () => {
  assert.equal(standaloneProfileName('100.64.20.87'), 'GuardNook：100.64.20.87')
})

test('生成的订阅只有四组，普通流量走固定出口', () => {
  const { config, text } = buildStandaloneProfile(shareConfig(), { originalUid: 'orig1', credentials, originalText: ORIGIN })
  assert.deepEqual(config['proxy-groups'].map(group => group.name),
    ['入口选择', '出口选择', 'GuardNookShare-Pinned', 'GuardNookShare-Claude'])
  assert.ok(['GN-entry-check', 'GuardNook-client', 'Claude-guard-probe']
    .every(name => config.listeners.map(listener => listener.name).includes(name)))
  assert.equal(config['proxy-providers']['gn-entry'].path, 'profiles/orig1.yaml')
  const entry = config['proxy-groups'].find(group => group.name === '入口选择')
  assert.ok(entry.use.includes('gn-entry'))
  assert.equal(config.rules[0], 'AND,((DOMAIN-SUFFIX,claude.ai),(NETWORK,UDP),(DST-PORT,443)),REJECT')
  assert.deepEqual(config.rules.slice(-3), [
    'NETWORK,UDP,REJECT',
    'IP-CIDR6,::/0,REJECT,no-resolve',
    'MATCH,GuardNookShare-Pinned',
  ])
  assert.deepEqual(config.rules.slice(-deviceExitRules({ deviceWide: true, pinnedProxy: 'GuardNookShare-Pinned' }).length),
    deviceExitRules({ deviceWide: true, pinnedProxy: 'GuardNookShare-Pinned' }))
  // UU Remote is opt-in: by default nothing bypasses the pinned exit.
  assert.ok(uuRemoteExceptionRules().every(rule => !config.rules.includes(rule)))
  assert.ok(!config.rules.includes('NETWORK,UDP,DIRECT'))
  assert.ok(!config.rules.includes('MATCH,入口选择'))
  assert.ok(!config.rules.some(rule => /追云加速|自动选择|子集组/.test(rule)))
  assert.equal(config.ipv6, false)
  assert.equal(config.tun.enable, true)
  assert.equal(config.mode, 'rule')
  assert.equal(config['allow-lan'], true)
  assert.deepEqual(config.dns.nameserver, [
    'https://1.1.1.1/dns-query#GuardNookShare-Pinned',
    'https://8.8.8.8/dns-query#GuardNookShare-Pinned',
  ])
  const claude = config['proxy-groups'].find(group => group.name === 'GuardNookShare-Claude')
  assert.deepEqual(claude.proxies, ['REJECT', 'GuardNookShare-Gateway'])
  const exit = config.proxies.find(proxy => proxy.name === 'GN-Exit')
  assert.equal(exit.type, 'socks5')
  assert.equal(exit.server, '100.64.20.87')
  assert.equal(exit.port, 3000)
  assert.equal(exit.username, 'relay')
  assert.equal(exit.password, 'secret')
  assert.equal(exit['dialer-proxy'], '入口选择')
  assert.match(text, /^mode: 'rule'$/m)
  assert.match(text, /^  gn-entry:$/m)
  assert.doesNotMatch(text, /204\.245\.140\.87:3000/)
})

test('安装后写入独立订阅、切为当前项并保留原订阅', async () => {
  const home = await fakeVerge()
  const result = await installVergeProfile({ home, config: shareConfig(), credentials, now: 1700000002000 })
  assert.equal(result.name, 'GuardNook：100.64.20.87')
  assert.equal(result.originalUid, 'orig1')
  assert.equal(result.reused, false)
  assert.match(result.uid, /^l[0-9A-Za-z]{11}$/)
  assert.equal(result.scriptNeutralized, true)

  const paths = vergePaths(home)
  const list = await readFile(paths.profilesYaml, 'utf8')
  assert.match(list, new RegExp(`^current: ${result.uid}$`, 'm'))
  assert.match(list, /name: 追云加速/)
  assert.match(list, /name: 家宽链式代理/)
  assert.ok(list.includes(`name: GuardNook：100.64.20.87`))
  assert.equal((list.match(/^- uid: /gm) || []).length, 3)

  const profile = await stat(result.profilePath)
  assert.equal(profile.mode & 0o777, 0o600)
  assert.equal(await readFile(result.profilePath, 'utf8'), buildStandaloneProfile(shareConfig(), { originalUid: 'orig1', credentials, originalText: ORIGIN }).text)

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
    name: 'GuardNook：100.64.20.87',
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
  assert.equal(backups.filter(name => name.startsWith('verge.')).length, 0)
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
  await writeFile(paths.profilesYaml, 'current: GuardNook：100.64.20.87\n- uid: l12345678901\n  type: local\n  name: GuardNook：100.64.20.87\n  file: l12345678901.yaml\n')
  await assert.rejects(installVergeProfile({ home, config: shareConfig(), credentials }), /找不到可用的原订阅/)
})

test('缺少凭据时不生成独立订阅', () => {
  assert.throws(() => buildStandaloneProfile(shareConfig(), { originalUid: 'orig1', credentials: null, originalText: ORIGIN }),
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


test('独立订阅预检保持只读，安装时不改写 TUN 或系统代理开关', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = vergePaths(home)
  await prepareDeviceVerge(home)
  assert.equal(await readFile(paths.settings, 'utf8'), VERGE_SETTINGS)
  const installed = await installVergeProfile({ home, config: shareConfig(), credentials })
  assert.equal(installed.settingsBackupPath, null)
  assert.equal(await readFile(paths.settings, 'utf8'), VERGE_SETTINGS)
  assert.equal((await stat(paths.settings)).mode & 0o777, 0o644)
  const retry = await installVergeProfile({ home, config: shareConfig(), credentials })
  assert.equal(retry.settingsBackupPath, null)
})

test('不明确的 TUN 设置不再阻止生成仅保护 Claude 的独立订阅', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = vergePaths(home)
  const malformed = VERGE_SETTINGS + 'enable_tun_mode: false\n'
  await writeFile(paths.settings, malformed)
  const installed = await installVergeProfile({ home, config: shareConfig(), credentials })
  assert.ok(installed.uid)
  assert.equal(await readFile(paths.settings, 'utf8'), malformed)
  assert.match(await readFile(paths.profilesYaml, 'utf8'), new RegExp(`^current: ${installed.uid}$`, 'm'))
  assert.equal(await readFile(paths.script, 'utf8'), 'function main(config) {\n  return config;\n}\n')
})


test('允许 UU 远程直连时，独立订阅把 UU 例外写在固定出口阻断之前', () => {
  const { config } = buildStandaloneProfile(shareConfig({ allowUURemote: true }), { originalUid: 'orig1', credentials, originalText: ORIGIN })
  const tail = deviceExitRules({ deviceWide: true, allowUURemote: true, pinnedProxy: 'GuardNookShare-Pinned' })
  assert.deepEqual(config.rules.slice(-tail.length), tail)
  assert.ok(uuRemoteExceptionRules().every(rule => config.rules.includes(rule)))
  assert.ok(config.rules.indexOf(uuRemoteExceptionRules()[0]) < config.rules.indexOf('NETWORK,UDP,REJECT'))
  assert.equal(config['find-process-mode'], 'strict')
  assert.notEqual(config.tun.stack, 'system')
})

function runSetup(home, request) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url))], {
    env: { ...process.env, HOME: home }, encoding: 'utf8', input: JSON.stringify(request),
  })
}

test('首次 profile-apply 写入独立订阅，但中转保持待确认，直到第 4 步确认实测出口', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = desktopRoot(home)
  const base = shareConfig()
  const path = join(root, 'config.json')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify({ ...base, startProtected: false, deviceWide: true,
    expectedIP: '203.0.113.1', relay: { ...base.relay, confirmed: false } }), { mode: 0o600 })
  const result = runSetup(home, { operation: 'profile-apply', expectedIP: base.expectedIP, relayCredentials: credentials })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(JSON.parse(result.stdout).relayConfirmed, false)
  const config = JSON.parse(await readFile(path, 'utf8'))
  // The request's IPv4 only names the subscription; it is not trusted as the exit.
  assert.equal(config.expectedIP, base.expectedIP)
  assert.equal(config.relay.confirmed, false)
  assert.equal(config.startProtected, false)
  assert.equal(config.deviceWide, true)
  assert.equal(config.requireTun, true)
  assert.match(await readFile(vergePaths(home).settings, 'utf8'), /^enable_tun_mode: false$/m)
  const record = JSON.parse(await readFile(join(root, 'standalone.json'), 'utf8'))
  const generated = await readFile(join(vergePaths(home).dir, 'profiles', `${record.uid}.yaml`), 'utf8')
  assert.match(generated, /MATCH,GuardNookShare-Pinned/)
  assert.match(generated, /NETWORK,UDP,REJECT/)
  assert.match(generated, /IP-CIDR6,::\/0,REJECT,no-resolve/)
  assert.doesNotMatch(generated, /MATCH,入口选择/)
  assert.doesNotMatch(generated, /NETWORK,UDP,DIRECT/)
  assert.doesNotMatch(generated, /追云加速|自动选择|子集组/)
  assert.doesNotMatch(generated, /UURemote/)
})

test('未确认且没有可用 IPv4 时，profile-apply 不再拿中转地址充当已确认出口', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = desktopRoot(home)
  const base = shareConfig()
  const path = join(root, 'config.json')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const before = JSON.stringify({ ...base, startProtected: false, deviceWide: true,
    expectedIP: '203.0.113.1', relay: { ...base.relay, confirmed: false } })
  await writeFile(path, before, { mode: 0o600 })
  const profiles = await readFile(vergePaths(home).profilesYaml, 'utf8')
  const result = runSetup(home, { operation: 'profile-apply', expectedIP: '203.0.113.1', relayCredentials: credentials })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout, /第 4 步确认实测出口/)
  assert.equal(await readFile(path, 'utf8'), before)
  assert.equal(await readFile(vergePaths(home).profilesYaml, 'utf8'), profiles)
})

test('已确认但仍是占位地址时，profile-apply 不信任中转地址，退回待确认', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = desktopRoot(home)
  const base = shareConfig()
  const path = join(root, 'config.json')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify({ ...base, startProtected: true, deviceWide: false, requireTun: false,
    expectedIP: '203.0.113.1', relay: { ...base.relay, confirmed: true } }), { mode: 0o600 })
  const refused = runSetup(home, { operation: 'profile-apply', expectedIP: '203.0.113.1', relayCredentials: credentials })
  assert.notEqual(refused.status, 0)
  const result = runSetup(home, { operation: 'profile-apply', expectedIP: base.relay.host, relayCredentials: credentials })
  assert.equal(result.status, 0, result.stdout)
  const config = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(config.relay.confirmed, false)
  assert.equal(config.startProtected, false)
  assert.equal(config.deviceWide, true)
  assert.equal(config.requireTun, true)
})

test('已确认的旧配置 deviceWide/requireTun 为 false 时，profile-apply 会改写为 true', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = desktopRoot(home)
  const base = shareConfig()
  const path = join(root, 'config.json')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify({ ...base, startProtected: true, deviceWide: false, requireTun: false,
    allowUURemote: true, relay: { ...base.relay, confirmed: true } }), { mode: 0o600 })
  const result = runSetup(home, { operation: 'profile-apply', relayCredentials: credentials })
  assert.equal(result.status, 0, result.stdout)
  assert.equal(JSON.parse(result.stdout).relayConfirmed, true)
  const config = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(config.deviceWide, true)
  assert.equal(config.requireTun, true)
  assert.equal(config.startProtected, true)
  assert.equal(config.expectedIP, base.expectedIP)
  assert.equal(config.relay.confirmed, true)
  assert.equal(config.allowUURemote, true)
})

test('planProfileApply 只在缺少整机/TUN/确认等字段时改写配置', () => {
  const base = shareConfig()
  const stale = planProfileApply({ ...base, deviceWide: false, requireTun: false }, '')
  assert.equal(stale.persist, true)
  assert.equal(stale.active.deviceWide, true)
  assert.equal(stale.active.requireTun, true)
  const current = planProfileApply(base, '')
  assert.equal(current.persist, false)
  assert.equal(current.active.expectedIP, base.expectedIP)
})

test('set-uu-remote 保存开关并提示需要重新应用配置', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = desktopRoot(home)
  const path = join(root, 'config.json')
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(path, JSON.stringify(shareConfig()), { mode: 0o600 })
  const on = await setUURemote(root, { allowUURemote: true })
  assert.deepEqual(on, { saved: true, allowUURemote: true, needsReapply: true })
  assert.equal(JSON.parse(await readFile(path, 'utf8')).allowUURemote, true)
  assert.equal((await setUURemote(root, { allowUURemote: true })).needsReapply, false)
  await assert.rejects(setUURemote(root, { allowUURemote: 'yes' }), /设置无效/)
  const off = runSetup(home, { operation: 'set-uu-remote', allowUURemote: false })
  assert.equal(off.status, 0, off.stdout)
  assert.equal(JSON.parse(off.stdout).needsReapply, true)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).allowUURemote, false)
})

test('缺少密码时不写出无认证的独立订阅', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = vergePaths(home)
  const before = await readFile(paths.profilesYaml, 'utf8')
  await assert.rejects(installVergeProfile({
    home, config: shareConfig(), credentials: { username: 'relay', password: '' },
  }), /无法读取保存的 SOCKS5 凭据/)
  assert.equal(await readFile(paths.profilesYaml, 'utf8'), before)
  const files = await readdir(join(paths.dir, 'profiles'))
  assert.deepEqual(files.filter(name => name.endsWith('.yaml')).sort(), ['orig1.yaml', 'orig2.yaml'])
})

test('device-apply 不再静默套用整机固定出口', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = desktopRoot(home)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(join(root, 'config.json'), JSON.stringify(shareConfig()), { mode: 0o600 })
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./setup.mjs', import.meta.url))], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
    input: JSON.stringify({ operation: 'device-apply', relayCredentials: credentials }),
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /请改用独立订阅导入固定出口配置/)
})

test('解析原订阅 YAML 并忽略历史整机标志', () => {
  const parsed = parseYamlDocument(ORIGIN)
  assert.deepEqual(parsed.rules, ['DOMAIN-SUFFIX,example.com,追云加速', 'MATCH,追云加速'])
  const { config } = buildStandaloneProfile(shareConfig({ deviceWide: true }), {
    originalUid: 'orig1', credentials, originalText: ORIGIN,
  })
  assert.ok(config.rules.includes('MATCH,GuardNookShare-Pinned'))
  assert.ok(config.rules.includes('NETWORK,UDP,REJECT'))
  assert.ok(config.rules.includes('IP-CIDR6,::/0,REJECT,no-resolve'))
  assert.ok(!config.rules.includes('MATCH,入口选择'))
})


test('原订阅规则不会留下对已删除分组的引用，结尾必须是固定出口', () => {
  const originalText = ORIGIN.replace(
    '  - MATCH,追云加速\n',
    [
      '  - DOMAIN-SUFFIX,leaf.example,入口A',
      '  - GEOIP,CN,DIRECT,no-resolve',
      '  - AND,((DOMAIN-SUFFIX,safe.example),(NETWORK,TCP)),REJECT',
      '  - MATCH,追云加速',
      '',
    ].join('\n'),
  )
  const { config } = buildStandaloneProfile(shareConfig(), { originalUid: 'orig1', credentials, originalText })
  assert.deepEqual(config['proxy-groups'].map(group => group.name),
    ['入口选择', '出口选择', 'GuardNookShare-Pinned', 'GuardNookShare-Claude'])
  assert.deepEqual(config.rules.slice(-3), [
    'NETWORK,UDP,REJECT',
    'IP-CIDR6,::/0,REJECT,no-resolve',
    'MATCH,GuardNookShare-Pinned',
  ])
  assert.deepEqual(config.rules.slice(-deviceExitRules({ deviceWide: true, pinnedProxy: 'GuardNookShare-Pinned' }).length),
    deviceExitRules({ deviceWide: true, pinnedProxy: 'GuardNookShare-Pinned' }))
  assert.ok(uuRemoteExceptionRules().every(rule => !config.rules.includes(rule)))
  assert.ok(!config.rules.some(rule => /追云加速|自动选择|子集组/.test(rule)))
  assert.ok(!config.rules.includes('MATCH,入口选择'))
  assert.ok(!config.rules.includes('NETWORK,UDP,DIRECT'))
})

test('占位出口地址不能用来命名或生成独立订阅', () => {
  assert.throws(() => standaloneProfileName('203.0.113.1'), /文档占位地址|固定出口 IPv4/)
  assert.throws(() => buildStandaloneProfile(shareConfig({ expectedIP: '203.0.113.1' }), {
    originalUid: 'orig1', credentials, originalText: ORIGIN,
  }), /文档占位地址|固定出口 IPv4|请先保存有效/)
})

test('历史无需认证配置不能生成没有密码的独立订阅', async t => {
  const home = await fakeVerge()
  t.after(() => rm(home, { recursive: true, force: true }))
  const paths = vergePaths(home)
  const before = await readFile(paths.profilesYaml, 'utf8')
  assert.throws(() => buildStandaloneProfile(shareConfig({ relay: { ...shareConfig().relay, auth: false } }), {
    originalUid: 'orig1', credentials, originalText: ORIGIN,
  }), /未启用认证|请重新填写/)
  await assert.rejects(installVergeProfile({
    home, config: shareConfig({ relay: { ...shareConfig().relay, auth: false } }), credentials,
  }), /未启用认证|请重新填写/)
  assert.equal(await readFile(paths.profilesYaml, 'utf8'), before)
  const files = await readdir(join(paths.dir, 'profiles'))
  assert.deepEqual(files.filter(name => name.endsWith('.yaml')).sort(), ['orig1.yaml', 'orig2.yaml'])
})
