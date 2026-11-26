import http from 'node:http'
import { readFile as fsReadFile } from 'node:fs/promises'
import { controllerFromFile, readSingboxFile } from './singbox.mjs'

export function controllerOptions(config) {
  const headers = config.controllerSecret ? { authorization: `Bearer ${config.controllerSecret}` } : {}
  if (config.controllerURL) {
    const url = new URL(config.controllerURL)
    return { hostname: url.hostname === '[::1]' ? '::1' : url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, port: Number(url.port), headers }
  }
  return { socketPath: config.controllerSocket, headers }
}

export function createController(config, { readFile = fsReadFile } = {}) {
  // v2rayN moves its sing-box clash_api port when TUN is toggled. For the
  // sing-box backend only, a refused connection re-reads the loopback address
  // from v2rayN's own generated config file and retries once.
  const singbox = config.backendKind === 'singbox'
  let current = config
  const send = (path, method = 'GET', body, { timeoutMs = config.timeoutMs } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const options = controllerOptions(current)
    const req = http.request({
      ...options, path, method,
      headers: { ...options.headers, ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => {
        data += chunk
        if (data.length > 4 * 1024 * 1024) req.destroy(new Error('Controller response too large'))
      })
      res.on('error', reject)
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Controller HTTP ${res.statusCode}`)); return
        }
        try { resolve(data ? JSON.parse(data) : null) } catch { reject(new Error('Invalid controller JSON')) }
      })
    })
    const deadline = setTimeout(() => req.destroy(new Error('Controller timeout')), timeoutMs)
    req.on('close', () => clearTimeout(deadline))
    req.on('error', reject)
    req.end(payload)
  })
  const request = async (path, method, body, options) => {
    try { return await send(path, method, body, options) }
    catch (error) {
      if (!singbox || error?.code !== 'ECONNREFUSED' || !config.singbox?.configPath) throw error
      const next = controllerFromFile(await readSingboxFile(config.singbox.configPath, readFile))
      if (!next || next === current.controllerURL) throw error
      current = { ...current, controllerURL: next }
      return send(path, method, body, options)
    }
  }
  return { request, url: () => current.controllerURL || '', select(name) {
    if (![config.gatewayProxy, 'REJECT'].includes(name)) throw new Error('Unsafe selector choice')
    // sing-box has no ClaudeGuard selector: the local gateway lease is the
    // only gate, and it is closed whenever the guard is not verified.
    if (singbox) return Promise.resolve(null)
    return request(`/proxies/${encodeURIComponent(config.policyGroup)}`, 'PUT', { name })
  } }
}
