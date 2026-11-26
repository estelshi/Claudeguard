import https from 'node:https'
import tls from 'node:tls'
import { isIP } from 'node:net'
import { connectTunnel } from './tunnel.mjs'
import { relayEntry, relayEntryMatches, relayExit, relayExitGroup } from './relay.mjs'
import { isSingbox, validateSingboxProbeChain } from './singbox.mjs'

export function validateProbeChain(connections, c, sourcePort, inboundPort, host = 'claude.ai') {
  // sing-box rows carry no inboundPort; the inbound tag identifies the probe path.
  if (isSingbox(c)) return validateSingboxProbeChain(connections, c, sourcePort, host)
  const route = connections.connections?.find(x => Number(x.metadata?.sourcePort) === sourcePort
    && Number(x.metadata?.inboundPort) === inboundPort && x.metadata?.host === host)
  const allowed = [c.pinnedProxy, c.pinnedEntry, c.policyGroup, c.selectedProxy, c.frozenExitProxy,
    ...(c.relay ? [relayExitGroup] : []), ...(c.upstreamChain || [])]
  if (c.relay) {
    if (!route?.chains?.includes(c.pinnedProxy) || !route.chains.includes(relayExit)
      || route.chains.some(name => !allowed.includes(name) && name !== relayEntry && !relayEntryMatches(c.relay, name)))
      throw new Error('Probe route is not the fixed relay')
    return route.chains
  }
  if (!route || !route.chains?.includes(c.pinnedProxy)
    || route.chains.some(x => !allowed.includes(x))) throw new Error('Probe route is not the pinned chain')
  return route.chains
}

const sources = Object.freeze({
  claude: { host: 'claude.ai', path: '/cdn-cgi/trace' },
  ipv4: { host: 'api.ipify.org', path: '/', plainIPv4: true },
  cloudflare: { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' },
})

export function probeExit(c, controller, port = c.probePort) {
  return probeSource(c, controller, port, sources.claude)
}

export function probeFixedExit(c, controller, source) {
  return probeSource(c, controller, c.probePort, sources[source])
}

// TLS is validated end-to-end; fixed anonymous URLs only.
async function probeSource(c, controller, port, { host, path, plainIPv4 }) {
  let raw, secure, request
  const started = Date.now()
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1 })
  const deadline = setTimeout(() => {
    request?.destroy(new Error('Probe deadline exceeded'))
    secure?.destroy(new Error('Probe deadline exceeded'))
    raw?.destroy()
  }, c.timeoutMs)
  try {
    raw = await connectTunnel(c, `${host}:443`, port)
    const sourcePort = raw.localPort
    secure = tls.connect({ socket: raw, servername: host, rejectUnauthorized: true })
    agent.createConnection = () => secure
    const body = await new Promise((resolve, reject) => {
      request = https.request({ hostname: host, path, method: 'GET', agent,
        headers: { 'accept-encoding': 'identity', 'user-agent': 'Claude-Egress-Guard/1' } }, res => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('Trace unavailable')); return }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { data += chunk; if (data.length > 4096) request.destroy(new Error('Trace too large')) })
        res.on('error', reject)
        res.on('end', () => resolve(data))
      })
      request.once('error', reject)
      secure.once('error', reject)
      request.end()
    })
    const trace = plainIPv4 ? { ip: body.trim() }
      : Object.fromEntries(body.trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)))
    if (!isIP(trace.ip || '') || (plainIPv4 && isIP(trace.ip) !== 4)) throw new Error('Trace has no valid exit IP')
    const chains = validateProbeChain(await controller.request('/connections'), c, sourcePort, port, host)
    if (Date.now() - started >= c.timeoutMs) throw new Error('Probe deadline exceeded')
    return { ip: trace.ip, location: trace.loc || '', colo: trace.colo || '', chains }
  } finally {
    clearTimeout(deadline)
    agent.destroy()
    secure?.destroy()
    raw?.destroy()
  }
}
