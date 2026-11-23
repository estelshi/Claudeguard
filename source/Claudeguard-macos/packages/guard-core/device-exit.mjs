import { isIP } from 'node:net'

// After the existing guard prefix, all other TCP traffic goes through the pinned
// exit directly. Only the protected domains use the lease-gated group, so a
// failed probe closes Claude without cutting the rest of the machine.
export function deviceExitRules(c) {
  if (!c.deviceWide) return []
  return [
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

export function verifyDeviceExit(configs, rules, c, start) {
  if (!c.deviceWide) return
  const expected = deviceExitRules(c)
  const tail = rules.rules?.slice(start) ?? []
  if (tail.length !== expected.length ||
    tail[0]?.type !== 'Network' || String(tail[0].payload).toLowerCase() !== 'udp' || tail[0].proxy !== 'REJECT' ||
    !['IPCIDR', 'IPCIDR6'].includes(tail[1]?.type) || tail[1].payload !== '::/0' || tail[1].proxy !== 'REJECT' ||
    tail[2]?.type !== 'Match' || tail[2].proxy !== c.pinnedProxy) throw new Error('device-rules-required')
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
  config.tun = { enable: true, stack: config.tun?.stack || 'mixed',
    'strict-route': true, 'auto-route': true, 'auto-detect-interface': true,
    'dns-hijack': ['any:53', 'tcp://any:53'] }
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
