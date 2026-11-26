import { isIP } from 'node:net'

// After the existing guard prefix, leftover TCP goes through the pinned exit.
// When the user opts in (allowUURemote), UU Remote is excepted to DIRECT (TCP
// and UDP) so it can stay online while other UDP and IPv6 remain rejected. Process names were confirmed on macOS
// (UURemoteDaemon, UURemoteService running; UURemote, UURemoteServer,
// UURemoteUpdater, and uuyc-cli present in UURemote.app). Windows .exe
// counterparts are included as a best-effort match.
export function uuRemoteExceptionRules() {
  const names = [
    'UURemote', 'UURemoteDaemon', 'UURemoteService', 'UURemoteServer', 'UURemoteUpdater', 'uuyc-cli',
    'UURemote.exe', 'UURemoteDaemon.exe', 'UURemoteService.exe', 'UURemoteServer.exe', 'UURemoteUpdater.exe', 'uuyc-cli.exe',
  ]
  const paths = [
    '(?i).*/UURemote\\.app/Contents/.*',
    '(?i).*[\\\\/]UURemote[\\\\/].*',
  ]
  return names.map(name => `PROCESS-NAME,${name},DIRECT`)
    .concat(paths.map(pattern => `PROCESS-PATH-REGEX,${pattern},DIRECT`))
}

export function deviceExitRules(c) {
  if (!c.deviceWide) return []
  return [
    ...(c.allowUURemote === true ? uuRemoteExceptionRules() : []),
    'NETWORK,UDP,REJECT',
    'IP-CIDR6,::/0,REJECT,no-resolve',
    `MATCH,${c.pinnedProxy}`,
  ]
}

function localRouteExclusion(value) {
  if (typeof value !== 'string') return false
  const [address, bits, ...rest] = value.split('/')
  if (rest.length || !/^\d+$/.test(bits)) return false
  const prefix = Number(bits)
  const family = isIP(address)
  if (family === 6) return prefix >= 10 && prefix <= 128 && /^fe[89ab][0-9a-f]:/i.test(address)
  if (family !== 4 || prefix > 32) return false
  const [a, b] = address.split('.').map(Number)
  return prefix >= 8 && (a === 10 || a === 127)
    || prefix >= 10 && a === 100 && b >= 64 && b <= 127
    || prefix >= 12 && a === 172 && b >= 16 && b <= 31
    || prefix >= 16 && (a === 192 && b === 168 || a === 169 && b === 254)
}

function typesMatch(want, got) {
  if (want === got) return true
  // Mihomo reports IPv6 CIDR rules as IPCIDR rather than IPCIDR6.
  if (want === 'IPCIDR6' && got === 'IPCIDR') return true
  return typeof want === 'string' && typeof got === 'string'
    && want.toLowerCase() === got.toLowerCase()
}

function payloadsMatch(want, got) {
  if (want == null) return true
  const expected = String(want)
  const actual = String(got ?? '')
  if (expected === actual || expected.toLowerCase() === actual.toLowerCase()) return true
  // Some kernel payloads double-escape backslashes in PROCESS-PATH-REGEX.
  const norm = value => value.replaceAll('\\\\', '\\')
  return norm(expected).toLowerCase() === norm(actual).toLowerCase()
}

function parsedDeviceExitRule(text) {
  if (text.startsWith('PROCESS-NAME,')) {
    const rest = text.slice('PROCESS-NAME,'.length)
    const index = rest.lastIndexOf(',')
    return { type: 'ProcessName', payload: rest.slice(0, index), proxy: rest.slice(index + 1) }
  }
  if (text.startsWith('PROCESS-PATH-REGEX,')) {
    const rest = text.slice('PROCESS-PATH-REGEX,'.length)
    const index = rest.lastIndexOf(',')
    return { type: 'ProcessPathRegex', payload: rest.slice(0, index), proxy: rest.slice(index + 1) }
  }
  if (text === 'NETWORK,UDP,REJECT') return { type: 'Network', payload: 'udp', proxy: 'REJECT' }
  if (text.startsWith('IP-CIDR6,::/0,REJECT')) return { type: 'IPCIDR6', payload: '::/0', proxy: 'REJECT' }
  if (text.startsWith('MATCH,')) return { type: 'Match', proxy: text.slice('MATCH,'.length) }
  return null
}

export function verifyDeviceExit(configs, rules, c, start) {
  if (!c.deviceWide) return
  const expected = deviceExitRules(c)
  const tail = rules.rules?.slice(start) ?? []
  if (tail.length !== expected.length) throw new Error('device-rules-required')
  const cutoff = expected.length - 3
  if (cutoff < 0) throw new Error('device-rules-required')
  for (let i = 0; i < expected.length; i++) {
    const want = parsedDeviceExitRule(expected[i])
    const got = tail[i]
    if (!want || !typesMatch(want.type, got?.type) || got.proxy !== want.proxy
      || !payloadsMatch(want.payload, got?.payload))
      throw new Error('device-rules-required')
    if (i < cutoff && got.proxy !== 'DIRECT') throw new Error('device-rules-required')
  }
  if (tail[cutoff]?.type !== 'Network' || String(tail[cutoff].payload).toLowerCase() !== 'udp' || tail[cutoff].proxy !== 'REJECT' ||
    !['IPCIDR', 'IPCIDR6'].includes(tail[cutoff + 1]?.type) || tail[cutoff + 1].payload !== '::/0' || tail[cutoff + 1].proxy !== 'REJECT' ||
    tail[cutoff + 2]?.type !== 'Match' || tail[cutoff + 2].proxy !== c.pinnedProxy) throw new Error('device-rules-required')
  if (c.allowUURemote === true && !['strict', 'always'].includes(configs['find-process-mode'])) throw new Error('device-process-mode')
  const tun = configs.tun
  if (tun?.enable !== true) throw new Error('tun-required')
  if (tun['auto-route'] !== true || tun['strict-route'] !== true ||
    !tun['dns-hijack']?.some(x => ['any:53', 'udp://any:53'].includes(x)) ||
    tun['route-exclude-address']?.some(value => !localRouteExclusion(value)))
    throw new Error('device-tun-coverage')
}

export function applyDeviceExit(config, c) {
  if (!c.deviceWide) return config
  // Resolve the upstream itself independently. Application DNS uses encrypted
  // resolvers over the pinned route, including before the public gate opens.
  const bootstrap = config.dns?.['proxy-server-nameserver']
  const dns = ['1.1.1.1', '8.8.8.8'].map(ip => `https://${ip}/dns-query#${c.pinnedProxy}`)
  config.dns = { enable: true, ipv6: false, 'enhanced-mode': 'fake-ip',
    'nameserver': dns, 'proxy-server-nameserver': bootstrap?.length ? bootstrap : ['https://1.1.1.1/dns-query'] }
  // Keep local IPC local. Application IPv6 is rejected by the route rules.
  config.ipv6 = false
  // mixed/gvisor keep process identity for PROCESS-* rules; system stack may not.
  // Only the UU Remote exception needs that, so the subscription's own stack is
  // otherwise kept as before.
  const uu = c.allowUURemote === true
  const stack = uu ? (config.tun?.stack && config.tun.stack !== 'system' ? config.tun.stack : 'mixed') : (config.tun?.stack || 'mixed')
  config.tun = { enable: true, stack,
    'strict-route': true, 'auto-route': true, 'auto-detect-interface': true,
    'dns-hijack': ['any:53', 'tcp://any:53'] }
  // Process matching is required for the UU Remote DIRECT exception.
  if (uu) config['find-process-mode'] = 'strict'
  // A subscription-level listener may bind directly to a different exit.
  config.listeners = config.listeners.filter(l => ['GuardNook-client', 'Claude-guard-probe', 'GN-entry-check'].includes(l.name))
  if (c.relay) {
    // The device rules only reference these; keeping the subscription's own
    // groups would just add unreachable selectors to the Verge list.
    const keep = new Set([c.policyGroup, c.pinnedProxy, '入口选择', '出口选择'])
    config['proxy-groups'] = (config['proxy-groups'] || []).filter(group => keep.has(group.name))
  }
  return config
}
