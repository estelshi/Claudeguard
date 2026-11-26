import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { coverageRules } from '../../../packages/guard-core/coverage.mjs'
import { portableConfig } from '../../../packages/guard-core/setup.mjs'
import { composeProfileScript } from '../../../packages/guard-core/profile.mjs'
import { closeClaudeConnections } from '../../../packages/guard-core/tun-connections.mjs'

const configuration = () => portableConfig({ targetPlatform: 'win32', controllerSocket: '', controllerURL: 'http://127.0.0.1:9090', expectedIP: '203.0.113.1', selectedProxy: 'selected', requireTun: true }, 'a'.repeat(64))
test('Windows setup retains platform and TUN requirements and accepts only local controller URLs', () => {
  const c = configuration()
  assert.equal(c.targetPlatform, 'win32'); assert.equal(c.requireTun, true)
  assert.throws(() => portableConfig({ ...c, controllerURL: 'http://evil.test:9090' }, 'a'.repeat(64)))
  assert.throws(() => portableConfig({ ...c, targetPlatform: 'other' }, 'a'.repeat(64)))
})
test('generated self-contained Clash script uses executable rules and retains existing intranet behavior', () => {
  const c = { ...configuration(), coverageVersion: 1 }, source = composeProfileScript('function main(c) { c.rules.unshift("DOMAIN,corp.test,DIRECT"); return c; }', c)
  const context = { input: { mode: 'rule', proxies: [{ name: 'selected', type: 'ss', server: 'example.test', port: 443, cipher: 'aes-128-gcm', password: 'sample' }], 'proxy-groups': [], rules: ['MATCH,DIRECT'], tun: { enable: true } } }
  vm.createContext(context); vm.runInContext(source + '\nresult=main(input)', context)
  const result = context.result
  assert.ok(result.rules.includes(`PROCESS-NAME,Claude.exe,${c.policyGroup}`))
  assert.ok(result.rules.includes('DOMAIN,corp.test,DIRECT'))
  assert.ok(result.rules.includes(`AND,((PROCESS-NAME,claude.exe),(NETWORK,UDP)),REJECT`))
  const regex = coverageRules(c).find(r => r.startsWith('PROCESS-PATH-REGEX,')).split(',')[1]
  const windowsPath = new RegExp(regex.replace('(?i)', ''), 'i')
  assert.equal(windowsPath.test('C:\\Users\\Example\\AppData\\Local\\Programs\\Claude\\helper.exe'), true)
  assert.equal(windowsPath.test('C:/Tools/claude-code/helper.exe'), true)
  assert.equal(windowsPath.test('C:\\Tools\\Unrelated\\helper.exe'), false)
  assert.equal(result.tun.enable, true)
  assert.equal(result['proxy-groups'].find(p => p.name === c.policyGroup).proxies[0], 'REJECT')
  assert.equal(source.includes('controllerSecret'), false)
  assert.equal(coverageRules({ ...c, targetPlatform: 'darwin' }).some(r => r.includes('Claude.exe')), false)
})
test('Windows Claude connections are drained on TUN failure without deleting other apps', async () => {
  const deleted = []
  await closeClaudeConnections(configuration(), { request: async (path, method) => {
    if (method === 'DELETE') { deleted.push(path); return {} }
    return { connections: [
      { id: 'claude', metadata: { process: 'Claude.exe', host: 'shared.test' } },
      { id: 'code', metadata: { process: 'claude-code.exe' } },
      { id: 'path', metadata: { process: 'helper.exe', processPath: 'C:\\Users\\Example\\AppData\\Local\\Programs\\Claude\\helper.exe' } },
      { id: 'ordinary', metadata: { process: 'other.exe', host: 'shared.test' } },
    ] }
  } })
  assert.deepEqual(deleted.sort(), ['/connections/claude', '/connections/code', '/connections/path'])
})
