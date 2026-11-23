import { ipv6NetworkServices } from './clients.mjs'
import { run } from './desktop-common.mjs'
import { createEnvironmentRepair, ipv6State } from './environment-repair.mjs'
import { inspectGlobalIPv6 } from './relay.mjs'

const preferencePreset = Object.freeze({ timezone: 'America/New_York', locale: 'en_US', language: 'en-US' })

export async function readSetupEnvironment(controller, { execute = run, ipv6 = inspectGlobalIPv6, allowOffline = false } = {}) {
  const configRequest = controller.request('/configs', 'GET', undefined, { timeoutMs: 2800 })
    .catch(error => { if (allowOffline) return null; throw error })
  const [config, services, ipv6Evidence, locale, languages] = await Promise.all([
    configRequest,
    ipv6NetworkServices(execute),
    configRequest.then(config => ipv6({ tunnelInterface: config?.tun?.enable === true && typeof config.tun.device === 'string'
      ? config.tun.device : undefined })).catch(() => null),
    execute('/usr/bin/defaults', ['read', '-g', 'AppleLocale']),
    execute('/usr/bin/defaults', ['read', 'com.anthropic.claudefordesktop', 'AppleLanguages']),
  ])
  return {
    controllerOnline: config !== null,
    tunEnabled: typeof config?.tun?.enable === 'boolean' ? config.tun.enable : null,
    globalIPv6: ipv6Evidence?.present ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: /^[a-z]{2,3}[_-][A-Za-z0-9_+-]{2,20}(?:@[^\r\n]{1,60})?$/.test(locale.text) ? locale.text : null,
    language: languages.ok ? languages.text.match(/\b[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\b/)?.[0] ?? null : null,
    services: services.map(service => {
      let mode
      try { if (service.available) mode = ipv6State(service.info).mode } catch {}
      return { name: service.name, active: service.active, mode: mode ?? null }
    }),
  }
}

export async function disableSetupIPv6(input, { manager = createEnvironmentRepair() } = {}) {
  if (input.confirmed !== true) throw new Error('请先点击「一键关闭 IPv6」。')
  const ids = ['ipv6-batch']
  const { plan, planToken } = await manager.preview(ids, {})
  if (!plan.length) return { note: '没有需要关闭 IPv6 的网络服务。' }
  const result = await manager.repair(ids, {}, planToken)
  return { note: result.history?.[0]?.status === 'applied'
    ? `已关闭并复查 ${plan.length} 个网络服务的 IPv6。原设置可在「维护与恢复」中找回。`
    : result.note }
}

export async function changeSetupPreferences(input, { manager = createEnvironmentRepair() } = {}) {
  if (input.preset !== 'us-east' || !Array.isArray(input.preferenceIDs) || input.preferenceIDs.length === 0
    || input.preferenceIDs.length > 3 || input.preferenceIDs.some(id => !Object.hasOwn(preferencePreset, id))
    || new Set(input.preferenceIDs).size !== input.preferenceIDs.length) throw new Error('请选择要更改的偏好。')
  const ids = Object.keys(preferencePreset).filter(id => input.preferenceIDs.includes(id))
  if (input.operation === 'wizard-preferences-preview') return manager.preview(ids, preferencePreset)
  if (input.operation !== 'wizard-preferences-apply' || input.confirmed !== true ||
    typeof input.planToken !== 'string' || !/^[a-f0-9]{64}$/.test(input.planToken)) throw new Error('请先预览并确认系统偏好更改。')
  const result = await manager.repair(ids, preferencePreset, input.planToken)
  return { note: result.note }
}
