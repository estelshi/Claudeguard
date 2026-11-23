// 自动识别本机 Clash 控制接口（external-controller）。移植自早先的 Windows 版本。
// 只读：读取 Clash Verge Rev 的配置文件，并探测本机回环地址；不改写任何 Clash 配置。
// 顺序：Verge 配置里写的地址 → 127.0.0.1:9097（Verge Rev 默认）→ 127.0.0.1:9090（Mihomo 默认）。
// 密钥只留在主进程，渲染进程只拿到「是否找到密钥」；密钥只发给 Verge 配置里写明的那个地址，
// 不会拿去试探默认端口（与共用核心 discover 的约定一致）。
import { join } from 'node:path'
import { readFile as fsReadFile } from 'node:fs/promises'

const VERGE_DIRS = env => [
  env.APPDATA && join(env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev'),
  env.USERPROFILE && join(env.USERPROFILE, '.config', 'clash-verge-rev'),
].filter(Boolean)
// 运行时配置优先（反映 Verge 实际交给内核的值）
const CONFIG_FILES = ['clash-verge.yaml', 'config.yaml']
const DEFAULT_PORTS = [9097, 9090]

// 只取顶层标量，够用且不引入 YAML 依赖
export function topLevel(text, key) {
  const match = String(text).match(new RegExp(`^${key.replace(/-/g, '\\-')}:[ \\t]*(.*)$`, 'm'))
  if (!match) return undefined
  let value = match[1].replace(/\s+#.*$/, '').trim()
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
  return value
}

// external-controller 写法：127.0.0.1:9097 / :9097 / 0.0.0.0:9097 / localhost:9097 / [::1]:9097
export function controllerURL(value) {
  if (!value) return null
  const match = String(value).trim().match(/^(?:https?:\/\/)?(\[[^\]]+\]|[^:/]*):(\d{1,5})\/?$/)
  if (!match) return null
  const host = match[1], port = Number(match[2])
  if (!port || port > 65535) return null
  if (!['', '0.0.0.0', '127.0.0.1', 'localhost', '[::]', '[::1]', '::'].includes(host)) return null
  return `http://127.0.0.1:${port}`
}

async function readFirst(paths, readFile) {
  for (const path of paths) {
    try { return { path, text: await readFile(path, 'utf8') } } catch {}
  }
  return null
}

async function probe(url, secret, fetchImpl, timeout) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetchImpl(url + '/version', { headers: secret ? { Authorization: `Bearer ${secret}` } : {}, signal: controller.signal })
    if (response.status === 401 || response.status === 403) return { reachable: true, authorized: false }
    if (!response.ok) return { reachable: false }
    const body = await response.json().catch(() => ({}))
    return { reachable: true, authorized: true, version: body.version || '' }
  } catch { return { reachable: false } }
  finally { clearTimeout(timer) }
}

/**
 * 返回：
 *  status: 'found'      已连通，可直接读节点
 *          'needs-secret' 端口在，但密钥不对 / 没找到
 *          'disabled'   找到 Clash Verge，但它没开「外部控制器」
 *          'not-found'  没有发现正在运行的控制接口
 *  controllerURL, version, source ('verge' | 'default-port'), secret（仅主进程使用）
 */
export async function detectClash({ env = process.env, readFile = fsReadFile, fetch: fetchImpl = globalThis.fetch, timeout = 800 } = {}) {
  let vergeSeen = false, enabled, configured = null, secret = ''
  for (const dir of VERGE_DIRS(env)) {
    const verge = await readFirst([join(dir, 'verge.yaml')], readFile)
    const config = await readFirst(CONFIG_FILES.map(name => join(dir, name)), readFile)
    if (!verge && !config) continue
    vergeSeen = true
    if (verge) { const flag = topLevel(verge.text, 'enable_external_controller'); if (flag !== undefined) enabled = flag === 'true' }
    if (config) {
      configured = controllerURL(topLevel(config.text, 'external-controller'))
      secret = topLevel(config.text, 'secret') || ''
    }
    break
  }

  const candidates = [...new Set([configured, ...DEFAULT_PORTS.map(p => `http://127.0.0.1:${p}`)].filter(Boolean))]
  let locked = null
  for (const url of candidates) {
    const own = url === configured ? secret : ''
    const result = await probe(url, own, fetchImpl, timeout)
    if (result.reachable && result.authorized) return { status: 'found', controllerURL: url, version: result.version, source: url === configured ? 'verge' : 'default-port', secret: own, hasSecret: !!own }
    if (result.reachable && !locked) locked = url
  }
  if (locked) return { status: 'needs-secret', controllerURL: locked, source: locked === configured ? 'verge' : 'default-port', secret: '', hasSecret: false }
  if (vergeSeen && enabled === false) return { status: 'disabled', controllerURL: configured || 'http://127.0.0.1:9097', source: 'verge', secret: '', hasSecret: false }
  return { status: 'not-found', controllerURL: configured || null, source: vergeSeen ? 'verge' : null, secret: '', hasSecret: false }
}

// ---------- v2rayN（sing-box 内核） ----------
// 只读：读取 v2rayN 生成给 sing-box 的配置 binConfigs\config.json（以及 guiConfigs\guiNConfig.json 里的本地端口），
// 再探测本机回环地址。v2rayN 7.x 源码：clash_api 地址为 127.0.0.1:(本地端口+5，开启 TUN 时再 +1，被占用时顺延)，
// 不设 secret；第二本地端口（inbound 标签 socks2）= 本地端口 + 1，只监听 127.0.0.1。以上来自源码阅读，未在真机核对。
// 密钥（若用户自己给 sing-box 设置了）只发给配置文件里写明的地址。
const V2RAYN_DIRS = env => [
  env.V2RAYN_HOME,
  env.USERPROFILE && join(env.USERPROFILE, 'v2rayN'),
  env.USERPROFILE && join(env.USERPROFILE, 'Desktop', 'v2rayN'),
  env.USERPROFILE && join(env.USERPROFILE, 'Desktop', 'v2rayN-windows-64'),
  env.USERPROFILE && join(env.USERPROFILE, 'Downloads', 'v2rayN'),
  env.USERPROFILE && join(env.USERPROFILE, 'Downloads', 'v2rayN-windows-64'),
  env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'v2rayN'),
  env.ProgramFiles && join(env.ProgramFiles, 'v2rayN'),
  'C:\\v2rayN', 'D:\\v2rayN', 'C:\\v2rayN-windows-64', 'D:\\v2rayN-windows-64',
].filter(Boolean)
const V2RAYN_PORTS = [10813, 10814]

const pick = (object, key) => {
  if (!object || typeof object !== 'object') return undefined
  const found = Object.keys(object).find(name => name.toLowerCase() === key.toLowerCase())
  return found === undefined ? undefined : object[found]
}
const parseJSON = text => { try { const value = JSON.parse(text); return value && typeof value === 'object' ? value : null } catch { return null } }

// sing-box 配置的入站是 { type, tag, listen_port }；Xray 配置是 { protocol, port }
export function readSingboxConfig(value) {
  if (!value || !Array.isArray(value.inbounds)) return null
  if (value.inbounds.some(inbound => inbound?.protocol && !inbound?.type)) return { core: 'xray' }
  const port = tag => { const inbound = value.inbounds.find(item => item?.tag === tag); return Number.isInteger(inbound?.listen_port) ? inbound.listen_port : null }
  return { core: 'sing-box', controllerURL: controllerURL(value.experimental?.clash_api?.external_controller),
    secret: typeof value.experimental?.clash_api?.secret === 'string' ? value.experimental.clash_api.secret : '',
    localPort: port('socks'), secondPort: port('socks2'), tun: value.inbounds.some(item => item?.type === 'tun') }
}

/**
 * 返回：
 *  status: 'found'        已连通 sing-box 控制接口
 *          'needs-secret'  端口在，但要密钥
 *          'xray'          v2rayN 正在用 Xray 内核（暂不支持）
 *          'wrong-kind'    回应的是 Mihomo / Clash，不是 sing-box
 *          'not-found'     没有发现
 *  controllerURL, version, source ('v2rayn-config' | 'default-port'), configPath, localPort, secondPort, tun, secret（仅主进程）
 */
export async function detectV2rayN({ env = process.env, readFile = fsReadFile, fetch: fetchImpl = globalThis.fetch, timeout = 800, processDirs = async () => [] } = {}) {
  let parsed = null, configPath = null, gui = null, xray = false
  const dirs = [...new Set([...(await processDirs().catch(() => [])), ...V2RAYN_DIRS(env)])]
  for (const dir of dirs) {
    const file = join(dir, 'binConfigs', 'config.json')
    const text = await readFile(file, 'utf8').catch(() => null)
    const value = text && text.length < 8 * 1024 * 1024 ? readSingboxConfig(parseJSON(text)) : null
    if (!value) continue
    if (value.core === 'xray') { xray = true; continue }
    parsed = value; configPath = file
    const guiText = await readFile(join(dir, 'guiConfigs', 'guiNConfig.json'), 'utf8').catch(() => null)
    gui = guiText ? parseJSON(guiText) : null
    break
  }
  const inbound = Array.isArray(pick(gui, 'Inbound')) ? pick(gui, 'Inbound')[0] : null
  const guiPort = Number(pick(inbound, 'LocalPort'))
  const localPort = parsed?.localPort || (Number.isInteger(guiPort) && guiPort > 0 ? guiPort : 10808)
  const secondPort = parsed?.secondPort || null
  const configured = parsed?.controllerURL || null, secret = parsed?.secret || ''
  const extra = { configPath, localPort, secondPort, secondPortEnabled: !!secondPort, tun: parsed ? parsed.tun : null }
  const candidates = [...new Set([configured, ...[localPort + 5, localPort + 6, ...V2RAYN_PORTS].map(p => `http://127.0.0.1:${p}`)].filter(Boolean))]
  let locked = null, mihomo = null
  for (const url of candidates) {
    const own = url === configured ? secret : ''
    const result = await probe(url, own, fetchImpl, timeout)
    if (result.reachable && result.authorized) {
      if (/sing-box/i.test(result.version || '')) return { status: 'found', controllerURL: url, version: result.version, source: url === configured ? 'v2rayn-config' : 'default-port',
        secret: own, hasSecret: !!own, ...extra, configPath: url === configured ? configPath : null }
      mihomo ||= url
      continue
    }
    if (result.reachable && !locked) locked = url
  }
  if (locked) return { status: 'needs-secret', controllerURL: locked, source: locked === configured ? 'v2rayn-config' : 'default-port', secret: '', hasSecret: false, ...extra }
  if (xray && !parsed) return { status: 'xray', controllerURL: null, source: 'v2rayn-config', secret: '', hasSecret: false, ...extra }
  if (mihomo) return { status: 'wrong-kind', controllerURL: mihomo, source: 'default-port', secret: '', hasSecret: false, ...extra }
  return { status: 'not-found', controllerURL: configured, source: parsed ? 'v2rayn-config' : null, secret: '', hasSecret: false, ...extra }
}
