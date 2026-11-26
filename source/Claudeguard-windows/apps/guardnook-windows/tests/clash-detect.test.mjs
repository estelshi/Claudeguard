import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { detectClash, controllerURL, topLevel } from '../src/clash-detect.mjs'

const APPDATA = 'C:\\Users\\a\\AppData\\Roaming'
const dir = join(APPDATA, 'io.github.clash-verge-rev.clash-verge-rev')
const files = map => async path => { if (path in map) return map[path]; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
const server = routes => async (url, options) => {
  const handler = routes[url]
  if (!handler) throw new Error('ECONNREFUSED')
  return handler(options)
}
const ok = version => () => ({ ok: true, status: 200, json: async () => ({ version }) })
const env = { APPDATA, USERPROFILE: 'C:\\Users\\a' }

test('parses controller addresses and only accepts loopback', () => {
  assert.equal(controllerURL('127.0.0.1:9097'), 'http://127.0.0.1:9097')
  assert.equal(controllerURL(':9090'), 'http://127.0.0.1:9090')
  assert.equal(controllerURL('0.0.0.0:9097'), 'http://127.0.0.1:9097')
  assert.equal(controllerURL('192.168.1.2:9090'), null)
  assert.equal(controllerURL(''), null)
  assert.equal(topLevel("secret: 'abc' # x\nexternal-controller: ''", 'secret'), 'abc')
  assert.equal(topLevel("external-controller: ''", 'external-controller'), '')
})

test('finds Verge controller and secret, keeps secret out of renderer', async () => {
  const result = await detectClash({ env,
    readFile: files({ [join(dir, 'verge.yaml')]: 'enable_external_controller: true\n', [join(dir, 'clash-verge.yaml')]: 'external-controller: 127.0.0.1:9097\nsecret: s3cret\n' }),
    fetch: server({ 'http://127.0.0.1:9097/version': o => o.headers.Authorization === 'Bearer s3cret' ? ok('v1.19.8')() : { ok: false, status: 401 } }) })
  assert.equal(result.status, 'found'); assert.equal(result.controllerURL, 'http://127.0.0.1:9097')
  assert.equal(result.source, 'verge'); assert.equal(result.hasSecret, true); assert.equal(result.version, 'v1.19.8')
})

test('reports disabled external controller in Verge 2.x', async () => {
  const result = await detectClash({ env,
    readFile: files({ [join(dir, 'verge.yaml')]: 'enable_external_controller: false\n', [join(dir, 'clash-verge.yaml')]: "external-controller: ''\nsecret: set-your-secret\nexternal-controller-pipe: \\\\.\\pipe\\verge-mihomo\n" }),
    fetch: server({}) })
  assert.equal(result.status, 'disabled')
})

test('falls back to default ports, and flags a locked controller', async () => {
  assert.equal((await detectClash({ env, readFile: files({}), fetch: server({ 'http://127.0.0.1:9090/version': ok('v1') }) })).status, 'found')
  const locked = await detectClash({ env, readFile: files({}), fetch: server({ 'http://127.0.0.1:9097/version': () => ({ ok: false, status: 401 }) }) })
  assert.equal(locked.status, 'needs-secret'); assert.equal(locked.secret, '')
  assert.equal((await detectClash({ env, readFile: files({}), fetch: server({}) })).status, 'not-found')
})

test('never sends the Verge secret to a default port it was not configured for', async () => {
  const seen = []
  const result = await detectClash({ env,
    readFile: files({ [join(dir, 'clash-verge.yaml')]: 'external-controller: 127.0.0.1:7777\nsecret: s3cret\n' }),
    fetch: async (url, options) => { seen.push([url, options.headers.Authorization || '']); if (url.includes(':9097')) return { ok: true, status: 200, json: async () => ({ version: 'v1' }) }; throw new Error('ECONNREFUSED') } })
  assert.equal(result.status, 'found'); assert.equal(result.controllerURL, 'http://127.0.0.1:9097'); assert.equal(result.hasSecret, false)
  assert.deepEqual(seen.filter(([, auth]) => auth).map(([url]) => url), ['http://127.0.0.1:7777/version'])
})

// ---------- v2rayN（sing-box 内核） ----------
import { detectV2rayN, readSingboxConfig } from '../src/clash-detect.mjs'
const V2 = join(env.USERPROFILE, 'Desktop', 'v2rayN')
const singboxFile = (port = 10813, extra = {}) => JSON.stringify({ inbounds: [{ type: 'mixed', tag: 'socks', listen: '127.0.0.1', listen_port: 10808 },
  { type: 'mixed', tag: 'socks2', listen: '127.0.0.1', listen_port: 10809 }, { type: 'tun', tag: 'tun' }],
  experimental: { clash_api: { external_controller: `127.0.0.1:${port}`, ...extra } } })
const singboxAt = version => () => ({ ok: true, status: 200, json: async () => ({ version, premium: true, meta: true }) })

test('v2rayN: reads the generated sing-box config and finds its clash_api', async () => {
  const result = await detectV2rayN({ env,
    readFile: files({ [join(V2, 'binConfigs', 'config.json')]: singboxFile(10814) }),
    fetch: server({ 'http://127.0.0.1:10814/version': singboxAt('sing-box 1.12.12') }) })
  assert.equal(result.status, 'found'); assert.equal(result.controllerURL, 'http://127.0.0.1:10814'); assert.equal(result.source, 'v2rayn-config')
  assert.equal(result.configPath, join(V2, 'binConfigs', 'config.json')); assert.equal(result.secondPort, 10809); assert.equal(result.tun, true)
  assert.equal(result.hasSecret, false)
})

test('v2rayN: Xray core, Mihomo on the port, default-port fallback and not found', async () => {
  const xrayFile = JSON.stringify({ inbounds: [{ protocol: 'socks', port: 10808, tag: 'socks' }] })
  assert.equal((await detectV2rayN({ env, readFile: files({ [join(V2, 'binConfigs', 'config.json')]: xrayFile }), fetch: server({}) })).status, 'xray')
  assert.equal((await detectV2rayN({ env, readFile: files({}), fetch: server({ 'http://127.0.0.1:10813/version': ok('v1.19.8') }) })).status, 'wrong-kind')
  const fallback = await detectV2rayN({ env, readFile: files({}), fetch: server({ 'http://127.0.0.1:10813/version': singboxAt('sing-box 1.11.4') }) })
  assert.equal(fallback.status, 'found'); assert.equal(fallback.source, 'default-port'); assert.equal(fallback.configPath, null)
  assert.equal((await detectV2rayN({ env, readFile: files({}), fetch: server({}) })).status, 'not-found')
  assert.equal(readSingboxConfig({ inbounds: [{ type: 'tun' }] }).tun, true)
})

test('v2rayN: a configured sing-box secret only goes to its own address', async () => {
  const seen = []
  const result = await detectV2rayN({ env, processDirs: async () => [V2],
    readFile: files({ [join(V2, 'binConfigs', 'config.json')]: singboxFile(10900, { secret: 'abc' }) }),
    fetch: async (url, options) => { seen.push([url, options.headers.Authorization || '']); if (url.includes(':10900')) return options.headers.Authorization === 'Bearer abc' ? singboxAt('sing-box 1.12.0')() : { ok: false, status: 401 }; throw new Error('ECONNREFUSED') } })
  assert.equal(result.status, 'found'); assert.equal(result.hasSecret, true); assert.equal(result.secret, 'abc')
  assert.deepEqual(seen.filter(([, auth]) => auth).map(([url]) => url), ['http://127.0.0.1:10900/version'])
})
