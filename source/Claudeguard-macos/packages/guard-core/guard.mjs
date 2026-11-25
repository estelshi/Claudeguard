import { CLAUDE_DOMAINS, GOOGLE_AUTH_HOSTS, hasPersonalRoute, SHARE_IDENTITY } from './config.mjs'
import { verifyDeviceExit } from './device-exit.mjs'
import { coverageRules } from './coverage.mjs'
import { tunRequiredRules } from './tun-connections.mjs'
import { globalIPv6Present, reasonActions, relayEntry, relayExitGroup, relayRules, verifyRelayMembers } from './relay.mjs'
import { isIP } from 'node:net'
import { isSingbox, readSingboxPolicy, singboxTunState, verifySingboxPolicy } from './singbox.mjs'

export function verifyPolicy(snapshot, c) {
  const { configs, proxies, rules, entryProvider } = snapshot
  if (c.policyGroup === SHARE_IDENTITY.policyGroup && hasPersonalRoute(proxies.proxies))
    throw new Error('personal-guard-conflict')
  const group = proxies.proxies?.[c.policyGroup]
  const gateway = proxies.proxies?.[c.gatewayProxy]
  if (configs.mode !== 'rule') throw new Error('rule-mode-required')
  if (c.selectedProxy) {
    const pinned = proxies.proxies?.[c.pinnedProxy]
    const pinnedMember = c.relay ? relayExitGroup : (c.frozenExitProxy || c.selectedProxy)
    if (pinned?.type !== 'Selector' || pinned.udp !== false || pinned.all?.length !== 1
      || pinned.all[0] !== pinnedMember || pinned.now !== pinnedMember)
      throw new Error('guard-route-not-installed')
  }
  if (c.frozenExitProxy) {
    const aliases = [c.frozenExitProxy, ...(c.upstreamChain || [])]
    for (const [index, name] of aliases.entries()) {
      const node = proxies.proxies?.[name]
      if (!node || ['Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Direct', 'Reject', 'Pass'].includes(node.type)
        || (node['dialer-proxy'] || '') !== (aliases[index + 1] || '')) throw new Error('frozen-chain-changed')
    }
  }
  if (!c.proxyPassword || group?.type !== 'Selector'
    || group.all?.length !== 2 || !group.all.includes('REJECT') || !group.all.includes(c.gatewayProxy)
    || !['REJECT', c.gatewayProxy].includes(group.now)
    || gateway?.type !== 'Http' || gateway.udp !== false) throw new Error('guard-route-not-installed')
  const relayPrefix = relayRules(c)
  if (c.relay) {
    const marker = rules.rules?.[relayPrefix.length - 1]
    if (marker?.type !== 'Domain' || marker.payload !== `gn-${c.relay.id}.invalid` || marker.proxy !== 'REJECT')
      throw new Error('guard-route-not-installed')
    for (const [index, raw] of relayPrefix.slice(0, -1).entries()) {
      const actual = rules.rules[index]
      const normalized = String(actual?.payload).replace(/DomainSuffix/g, 'DOMAIN-SUFFIX').replace(/Network/g, 'NETWORK')
        .replace(/DstPort/g, 'DST-PORT').replace(/\(NETWORK,udp\)/gi, '(NETWORK,UDP)').replace(/\s*&&\s*/g, ',')
      if (actual?.type !== 'AND' || actual.proxy !== 'REJECT' || normalized !== raw.slice(4, -7))
        throw new Error('coverage-rules-changed')
    }
    verifyRelayMembers(c.relay, proxies.proxies, c.deviceWide ? entryProvider : undefined)
  }
  const expected = CLAUDE_DOMAINS.map(payload => ({ type: 'DomainSuffix', payload }))
    .concat((c.guardGoogleAuth === false ? [] : GOOGLE_AUTH_HOSTS).map(payload => ({ type: 'Domain', payload })))
  for (const [i, rule] of expected.entries()) {
    const actual = rules.rules?.[relayPrefix.length + i]
    if (actual?.type !== rule.type || actual.payload !== rule.payload || actual.proxy !== c.policyGroup)
      throw new Error('protected-rules-changed')
  }
  if (c.coverageVersion === 1) {
    const extra = coverageRules(c)
    for (const [offset, value] of extra.entries()) {
      const parts = value.split(',')
      const type = { 'DOMAIN-SUFFIX': 'DomainSuffix', DOMAIN: 'Domain', 'IP-CIDR': 'IPCIDR', 'IP-CIDR6': 'IPCIDR6', 'PROCESS-NAME': 'ProcessName', 'PROCESS-PATH-REGEX': 'ProcessPathRegex', 'IN-PORT': 'InPort', AND: 'AND' }[parts[0]]
      const policy = parts.at(-1) === 'no-resolve' ? parts.at(-2) : parts.at(-1)
      const actual = rules.rules?.[relayPrefix.length + expected.length + offset]
      // Normalize only the kernel's type names and logical separators. Compare
      // the full structure so a NOT predicate or altered subnet cannot pass.
      const payload = parts.slice(1, parts.at(-1) === 'no-resolve' ? -2 : -1).join(',')
      const normalized = String(actual?.payload)
        .replace(/DomainSuffix/g, 'DOMAIN-SUFFIX').replace(/ProcessPathRegex/g, 'PROCESS-PATH-REGEX')
        .replace(/ProcessName/g, 'PROCESS-NAME').replace(/Network/g, 'NETWORK')
        .replace(/\(NETWORK,(udp|tcp)\)/g, (_, protocol) => `(NETWORK,${protocol.toUpperCase()})`)
        .replace(/\s*(?:&&|\|\|)\s*/g, ',')
      const matchingType = actual?.type === type || type === 'IPCIDR6' && actual?.type === 'IPCIDR'
      if (!matchingType || actual.proxy !== policy || normalized !== payload) throw new Error('coverage-rules-changed')
    }
  }
  if (c.requireTun) {
    for (const [offset, value] of tunRequiredRules(c).entries()) {
      const [type, payload, proxy] = value.split(',')
      const actual = rules.rules?.[relayPrefix.length + expected.length + coverageRules(c).length + offset]
      if (actual?.type !== (type === 'DOMAIN' ? 'Domain' : 'DomainSuffix') || actual.payload !== payload || actual.proxy !== proxy)
        throw new Error('coverage-rules-changed')
    }
  }
  verifyDeviceExit(configs, rules, c, relayPrefix.length + expected.length + coverageRules(c).length + tunRequiredRules(c).length)
  return true
}

async function readPolicy(controller, c, options) {
  const [configs, proxies, rules] = await Promise.all(['/configs', '/proxies', '/rules']
    .map(path => controller.request(path, 'GET', undefined, options)))
  const members = proxies.proxies?.[relayEntry]?.all
  const providerNeeded = c.deviceWide && c.relay && Array.isArray(members)
    && members.some(name => !Object.hasOwn(proxies.proxies, name))
  const providers = providerNeeded ? await controller.request('/providers/proxies/gn-entry', 'GET', undefined, options)
    .catch(() => undefined) : undefined
  return { configs, proxies, rules, entryProvider: providers }
}

export function createGuard(c, controller, gateway, probe, { contain, drain, relayPath, ipv6 = globalIPv6Present, readFile } = {}) {
  // Backend adapter. Mihomo keeps the original calls; sing-box reads its own
  // rule strings and takes TUN evidence from its generated config file.
  const singbox = isSingbox(c)
  const readBackend = options => singbox ? readSingboxPolicy(controller, c, options, readFile) : readPolicy(controller, c, options)
  const verifyBackend = policy => singbox ? verifySingboxPolicy(policy, c) : verifyPolicy(policy, c)
  // true = TUN on; otherwise the blocking reason. Unknown TUN state never passes.
  const tunGate = policy => {
    if (singbox) { tunEnabled = policy.tun === true ? true : policy.tun === false ? false : null; return tunEnabled === true || (tunEnabled === false ? 'tun-required' : 'tun-status-unavailable') }
    tunEnabled = policy.configs.tun?.enable === true
    return tunEnabled || 'tun-required'
  }
  let enabled = false, manual = false, disposed = false, generation = 0
  let attached = false
  let pending, admissionPending, timer, tunTimer, tunPending, tunEnabled = null, successes = 0, prepared = false, last, reason = 'observation-only', state = 'observe'
  const events = []
  const samples = []
  let relayStages = {}, currentEntry
  const sample = value => { samples.unshift(value); if (samples.length > 60) samples.pop() }
  const record = event => { events.unshift(event); if (events.length > 40) events.pop() }
  const snapshot = () => {
    const gate = gateway.status()
    const expired = enabled && state === 'protected' && (!gate.open || gate.expiresAt <= Date.now())
    const effectiveState = expired ? 'blocked' : state
    const effectiveReason = expired ? 'verification-expired' : reason
    const phase = effectiveState === 'protected' ? 'protected'
      : !attached && ['observation-only', 'guard-route-not-installed'].includes(effectiveReason) ? 'awaiting-rules'
        : !manual && ['confirming-exit', 'ready-not-enabled', 'relay-awaiting-confirmation'].includes(effectiveReason) ? 'verifying'
          : 'blocked'
    return { state: effectiveState, reason: effectiveReason, phase,
      enabled, manual, prepared, requireTun: c.requireTun, ...(singbox ? { backendKind: 'singbox' } : {}), deviceWide: c.deviceWide, tunEnabled, expectedIP: c.expectedIP, pinnedProxy: c.pinnedProxy, policyGroup: c.policyGroup, last: last || null,
      successes, recoverySamples: c.recoverySamples, leaseMs: c.leaseMs,
      intervalMs: c.intervalMs, timeoutMs: c.timeoutMs, gateway: gate, events: [...events], samples: [...samples],
      ...(c.relay ? { relay: { id: c.relay.id, confirmed: c.relay.confirmed, stages: relayStages, entry: currentEntry }, remedy: reasonActions[effectiveReason] } : {}) }
  }
  const rejectPolicy = async () => { try { await controller.select('REJECT') } catch { /* Gate is already closed. */ } }
  const fail = async why => {
    generation++
    gateway.closeAll(); successes = 0; state = 'blocked'; reason = why
    if (enabled) await rejectPolicy()
    if (enabled && contain && ['guard-route-not-installed', 'protected-rules-changed', 'coverage-rules-changed', 'frozen-chain-changed', 'rule-mode-required'].includes(why)) {
      try { await contain() } catch { /* The managed gate remains closed. */ }
    }
  }
  const blockForTun = async why => {
    const changed = reason !== why || gateway.status().open
    if (changed) generation++ // invalidate any older probe/selector completion
    gateway.closeAll(); successes = 0; state = 'blocked'; reason = why
    if (enabled) await rejectPolicy()
    if (changed && drain) { try { await drain() } catch { /* local gate stays closed */ } }
  }
  const checkTun = () => {
    if (!c.requireTun || disposed) return Promise.resolve(true)
    if (tunPending) return tunPending
    tunPending = (async () => {
      try {
        if (singbox) {
          const tun = await singboxTunState(c, { readFile, controllerURL: controller.url?.() || c.controllerURL })
          if (disposed) return false
          const gate = tunGate({ tun })
          if (gate !== true) { await blockForTun(gate); return false }
          return true
        }
        const config = await controller.request('/configs', 'GET', undefined, { timeoutMs: 700 })
        if (disposed) return false
        tunEnabled = config.tun?.enable === true
        if (!tunEnabled) { await blockForTun('tun-required'); return false }
        return true
      } catch {
        if (!disposed) { tunEnabled = null; await blockForTun('tun-status-unavailable') }
        return false
      }
    })().finally(() => { tunPending = undefined })
    return tunPending
  }
  const admissible = () => !disposed && enabled && !manual && prepared && state === 'protected'
    && last?.ip === c.expectedIP && gateway.status().open
  const admit = () => {
    if (!admissible()) return Promise.resolve(false)
    if (admissionPending) return admissionPending
    const epoch = generation
    admissionPending = (async () => {
      // A request may use only the existing short lease. This check never
      // renews it, counts recovery samples or waits for another Internet probe.
      try {
        const policy = await readBackend({ timeoutMs: 700 })
        if (generation !== epoch || !admissible()) return false
        if (c.requireTun) {
          const gate = tunGate(policy)
          if (gate !== true) { await blockForTun(gate); return false }
        }
        try {
          verifyBackend(policy)
        }
        catch (error) { await fail(error.message); return false }
        return generation === epoch && admissible()
      } catch {
        if (generation === epoch && !disposed) await fail('probe-or-controller-unavailable')
        return false
      }
    })().finally(() => { admissionPending = undefined })
    return admissionPending
  }
  const inspect = () => {
    if (disposed) return Promise.resolve(snapshot())
    if (pending) return pending
    const epoch = generation
    pending = (async () => {
      const started = Date.now()
      try {
        const policy = await readBackend()
        const { configs } = policy
        if (generation !== epoch || disposed) return snapshot()
        if (c.relay && c.requireTun) tunEnabled = configs.tun?.enable === true
        if (c.requireTun && !c.relay) {
          const gate = tunGate(policy)
          if (gate !== true) { await blockForTun(gate); return snapshot() }
        }
        prepared = false
        try { verifyBackend(policy); prepared = true; attached = true }
        catch (error) {
          if (c.relay) {
            if (error.message === 'tun-required') { tunEnabled = false; await blockForTun('tun-required'); return snapshot() }
            relayStages = error.message === 'entry_unavailable' ? { entry: { ok: false } } : {}
            if (error.message === 'entry_unavailable') attached = true
            if (!attached && ['guard-route-not-installed', 'device-rules-required'].includes(error.message)) { gateway.closeAll(); state = 'observe'; reason = error.message; return snapshot() }
            await fail(error.message); return snapshot()
          }
          if (enabled) { sample({ at: Date.now(), ok: false, reason: error.message, durationMs: Date.now() - started }); await fail(error.message); return snapshot() }
          if (c.selectedProxy) { gateway.closeAll(); state = 'observe'; reason = error.message; return snapshot() }
        }
        if (c.relay) {
          const name = policy.proxies.proxies[relayEntry]?.now
          const node = policy.proxies.proxies[name] ?? policy.entryProvider?.proxies?.find(p => p.name === name)
          const delay = node?.history?.at(-1)?.delay
          currentEntry = typeof name === 'string' ? { name, ...(delay > 0 ? { delay } : {}) } : undefined
          if (c.requireTun && !tunEnabled) { relayStages = {}; await blockForTun('tun-required'); return snapshot() }
          const tunnelInterface = configs.tun?.enable === true && typeof configs.tun.device === 'string' ? configs.tun.device : undefined
          if (await ipv6({ tunnelInterface })) throw new Error('global_ipv6_present')
          if (generation !== epoch || disposed) return snapshot()
        }
        const sampledAt = Date.now()
        let result
        try {
          result = await probe(c, controller, prepared ? c.probePort : c.clientPort)
        } catch (error) {
          if (!c.relay) throw error
          if (generation !== epoch || disposed) return snapshot()
          const at = Date.now()
          const stages = { egress: { ok: false, durationMs: at - sampledAt } }
          relayStages = stages
          // Close the gate before attempting any secondary diagnosis.
          await fail('exit_unreachable')
          const failureEpoch = epoch + 1
          if (generation !== failureEpoch || disposed) return snapshot()
          let failure = 'exit_unreachable'
          try {
            await relayPath?.((stage, value) => { stages[stage] = value })
            if (stages.exit?.ok) failure = 'egress_probe_failed'
          } catch (diagnosticError) {
            if (Object.hasOwn(reasonActions, diagnosticError.message)) failure = diagnosticError.message
          }
          if (generation !== failureEpoch || disposed) return snapshot()
          reason = failure
          sample({ at, ok: false, reason: failure, durationMs: at - sampledAt })
          return snapshot()
        }
        if (generation !== epoch || disposed) return snapshot()
        const verifiedAt = Date.now()
        if (c.relay && isIP(result.ip) !== 4) throw new Error(c.relay.confirmed ? 'egress_mismatch' : 'exit_unreachable')
        last = { ...result, sampledAt, verifiedAt }
        if (c.relay) {
          relayStages = {
            entry: { ok: true }, exit: { ok: true },
            egress: { ok: !c.relay.confirmed || result.ip === c.expectedIP, durationMs: verifiedAt - sampledAt },
          }
          if (!c.relay.confirmed) {
            gateway.closeAll(); state = 'observe'; reason = 'relay-awaiting-confirmation'
            return snapshot()
          }
        }
        sample({ at: verifiedAt, ok: result.ip === c.expectedIP, reason: result.ip === c.expectedIP ? 'verified' : 'exit-ip-mismatch',
          durationMs: verifiedAt - sampledAt, ip: result.ip })
        if (result.ip !== c.expectedIP) {
          if (c.relay) await fail('egress_mismatch')
          else if (enabled) await fail('exit-ip-mismatch')
          else { reason = 'exit-ip-mismatch'; state = 'observe' }
          return snapshot()
        }
        if (!enabled) { state = 'observe'; reason = prepared ? 'ready-not-enabled' : 'guard-route-not-installed'; return snapshot() }
        if (manual) { state = 'blocked'; reason = 'manual-block'; return snapshot() }
        if (Date.now() >= verifiedAt + c.leaseMs) { await fail('verification-expired'); return snapshot() }
        successes++
        if (successes < c.recoverySamples) { state = 'blocked'; reason = 'confirming-exit'; return snapshot() }
        if (!await checkTun() || generation !== epoch || disposed || manual) return snapshot()
        // Only this one selector is writable. Gate remains closed during recovery.
        await controller.select(c.gatewayProxy)
        if (generation !== epoch || disposed || manual) return snapshot()
        if (!await checkTun() || generation !== epoch || disposed || manual) return snapshot()
        // The attested TLS response confirms the exit at completion. Slow SOCKS
        // authentication before that response must not consume its fresh lease.
        const expiresAt = verifiedAt + c.leaseMs
        if (Date.now() >= expiresAt) { await fail('verification-expired'); return snapshot() }
        gateway.grant(expiresAt)
        state = 'protected'; reason = 'verified-pinned-exit'
      } catch (error) {
        if (generation !== epoch || disposed) return snapshot()
        const failure = c.relay && Object.hasOwn(reasonActions, error.message) ? error.message : 'probe-or-controller-unavailable'
        if (c.relay) relayStages = {}
        sample({ at: Date.now(), ok: false, reason: failure, durationMs: Date.now() - started })
        if (enabled || c.relay) await fail(failure)
        else { gateway.closeAll(); state = 'observe'; reason = 'probe-or-controller-unavailable'; prepared = false }
      }
      return snapshot()
    })().finally(() => { pending = undefined })
    return pending
  }
  return {
    status: snapshot, record, inspect, checkTun, admit,
    start() {
      if (!timer) { void inspect(); timer = setInterval(() => void inspect(), c.intervalMs) }
      if (c.requireTun && !tunTimer) {
        const check = () => { if (!c.relay || attached) void checkTun() }
        check(); tunTimer = setInterval(check, 250)
      }
    },
    async enable() {
      if (c.relay && !c.relay.confirmed) return inspect()
      generation++; gateway.closeAll(); enabled = true; manual = false; successes = 0; state = 'blocked'; reason = 'confirming-exit'
      if (pending) await pending
      await rejectPolicy()
      return inspect()
    },
    async block() {
      generation++; gateway.closeAll(); enabled = true; manual = true; successes = 0; state = 'blocked'; reason = 'manual-block'
      // Wait out a previous select so a late success cannot undo this block.
      if (pending) await pending
      await rejectPolicy()
      return snapshot()
    },
    async dispose() {
      disposed = true; generation++; clearInterval(timer); clearInterval(tunTimer); gateway.closeAll()
      if (pending) await pending
      if (tunPending) await tunPending
      if (admissionPending) await admissionPending
      if (enabled) await rejectPolicy()
    },
  }
}
