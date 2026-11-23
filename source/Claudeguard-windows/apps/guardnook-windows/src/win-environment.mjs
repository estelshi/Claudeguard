// Windows 环境检查、修复与恢复（对应 macOS 版 desktop-environment / environment-repair）。移植自早先的 Windows 版本。
// 只读检查：时区、系统国家或地区、区域格式、显示语言、物理网卡 IPv6、系统 DNS 是否 Fake-IP、Clash TUN、公网出口国家。
// 可修复（用户可自行还原）：时区（tzutil /s）、国家或地区（Set-WinHomeLocation）、区域格式（Set-Culture）、
//   各物理网卡的 IPv6 绑定（Disable/Enable-NetAdapterBinding，需要管理员，经 UAC 提权）。
// 显示语言只给出操作指引，不自动修改。TUN / Fake-IP / 出口国家属于 Clash 与守护配置，这里只检查不改动。
// 修复流程：预览旧值 → 目标值（planToken 绑定预览时的系统值）→ 先保存恢复点 → 逐项执行 → 重新读取核对。
// 部分失败保留恢复点；恢复按新到旧；发现设置被其他程序改过时停止覆盖。
// 所有系统命令都经可注入的 powershell / elevated 执行器，测试在 Linux 上用假系统运行。
import { execFile } from 'node:child_process'
import { readFile, readdir, mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { atomicJSON } from './storage.mjs'

// ---------- 格式校验 ----------
const TZ = /^[A-Za-z0-9 ()+.\-_]{1,64}$/
const TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/
const ISO2 = /^[A-Z]{2}$/
const ADAPTER = name => typeof name === 'string' && name.length > 0 && name.length <= 256 && !/[\0-\x1f]/.test(name)
const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'"

// 常用国家/地区的 Windows GeoId（Set-WinHomeLocation 只接受 GeoId）。表外的国家只检查、提示手动设置。
export const GEO_IDS = { US: 244, GB: 242, CA: 39, AU: 12, NZ: 183, JP: 122, KR: 134, SG: 215, HK: 104, TW: 237, CN: 45, MO: 151,
  DE: 94, FR: 84, NL: 176, IE: 68, CH: 223, SE: 221, NO: 177, DK: 61, FI: 77, ES: 217, IT: 118, PT: 193, BE: 21, AT: 14,
  PL: 191, IN: 113, MY: 167, TH: 227, VN: 251, PH: 201, ID: 111, AE: 224, IL: 117, BR: 32, MX: 166, AR: 11, ZA: 209, TR: 235 }

export const TEMPLATES = ['standard', 'strict']
export function validateBaseline(input) {
  const v = input || {}
  if (!TEMPLATES.includes(v.template)) throw new Error('环境模板无效。')
  if (typeof v.country !== 'string' || v.country !== '' && !ISO2.test(v.country)) throw new Error('出口国家需为两位大写字母，例如 US；不限制请留空。')
  if (typeof v.region !== 'string' || v.region !== '' && !ISO2.test(v.region)) throw new Error('系统国家或地区需为两位大写字母，例如 US；不检查请留空。')
  if (typeof v.timezone !== 'string' || !TZ.test(v.timezone)) throw new Error('时区需为 Windows 时区名，例如 Pacific Standard Time。')
  if (typeof v.culture !== 'string' || !TAG.test(v.culture)) throw new Error('区域格式无效，例如 en-US。')
  if (typeof v.language !== 'string' || !TAG.test(v.language)) throw new Error('显示语言无效，例如 en-US。')
  return { template: v.template, country: v.country, region: v.region, timezone: v.timezone, culture: v.culture, language: v.language }
}

// ---------- 读取系统 ----------
export const READ_SCRIPT = `$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$geo = Get-ItemProperty 'HKCU:\\Control Panel\\International\\Geo'
$hl = Get-WinHomeLocation
$langs = @(Get-WinUserLanguageList | ForEach-Object { $_.LanguageTag })
$ad = @(Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $b = Get-NetAdapterBinding -Name $_.Name -ComponentID ms_tcpip6
  [pscustomobject]@{ name = $_.Name; description = $_.InterfaceDescription; ipv6 = $(if ($b) { [bool]$b.Enabled } else { $null }) } })
[pscustomobject]@{ timezone = [string](tzutil.exe /g); geoId = $hl.GeoId; region = [string]$geo.Name; regionName = [string]$hl.HomeLocation;
  culture = (Get-Culture).Name; languages = $langs; adapters = $ad } | ConvertTo-Json -Depth 4 -Compress`

export function parseSystem(stdout) {
  let raw
  try { raw = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim()) } catch { throw new Error('无法读取 Windows 设置，请稍后重新检查。') }
  const list = value => value == null ? [] : [value].flat()
  return {
    timezone: typeof raw.timezone === 'string' ? raw.timezone.trim() : '',
    geoId: Number.isInteger(raw.geoId) ? raw.geoId : null,
    region: typeof raw.region === 'string' && ISO2.test(raw.region.trim()) ? raw.region.trim() : '',
    regionName: typeof raw.regionName === 'string' ? raw.regionName : '',
    culture: typeof raw.culture === 'string' ? raw.culture : '',
    languages: list(raw.languages).filter(x => typeof x === 'string'),
    adapters: list(raw.adapters).filter(a => a && ADAPTER(a.name)).map(a => ({ name: a.name, description: String(a.description || ''), ipv6: typeof a.ipv6 === 'boolean' ? a.ipv6 : null })),
  }
}

const isFakeIP = ip => /^198\.(18|19)\.\d+\.\d+$/.test(ip)

// ---------- 默认执行器（仅 Windows） ----------
const encode = script => Buffer.from(script, 'utf16le').toString('base64')
export function defaultPowershell(script, { timeout = 20000 } = {}) {
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)],
    { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '' })))
}
// 以管理员身份运行一段脚本：外层普通 PowerShell 调 Start-Process -Verb RunAs，用户在 UAC 点「否」时返回 1223。
export const ELEVATE_CANCELLED = 1223
export function elevationWrapper(script) {
  const inner = `$ErrorActionPreference='Stop'\ntry {\n${script}\nexit 0 } catch { exit 2 }`
  return `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encode(inner)}'; exit $p.ExitCode } catch { exit ${ELEVATE_CANCELLED} }`
}
export async function defaultElevated(script) {
  const result = await defaultPowershell(elevationWrapper(script), { timeout: 180000 })
  return { ok: result.code === 0, code: result.code, cancelled: result.code === ELEVATE_CANCELLED }
}
async function defaultResolve(host) {
  try { return (await lookup(host, { all: true })).map(r => r.address) } catch { return [] }
}

// ---------- 修复项 ----------
// 键：timezone | region | culture | ipv6:<网卡名>
const KEY = /^(timezone|region|culture|ipv6:.+)$/
export const keyTitle = key => key.startsWith('ipv6:') ? `IPv6 · ${key.slice(5)}` : { timezone: '时区', region: '系统国家或地区', culture: '区域格式' }[key]
const needsAdmin = key => key.startsWith('ipv6:')

export function applyScript(key, value) {
  if (key === 'timezone') {
    if (!TZ.test(value)) throw new Error('时区值无效，已停止。')
    return `tzutil.exe /s ${psQuote(value)}\nif ($LASTEXITCODE -ne 0) { exit 3 }`
  }
  if (key === 'region') {
    if (!Number.isInteger(value?.geoId) || value.geoId <= 0) throw new Error('国家或地区值无效，已停止。')
    return `Set-WinHomeLocation -GeoId ${value.geoId}`
  }
  if (key === 'culture') {
    if (!TAG.test(value)) throw new Error('区域格式值无效，已停止。')
    return `Set-Culture -CultureInfo ${psQuote(value)}`
  }
  if (key.startsWith('ipv6:')) {
    const name = key.slice(5)
    if (!ADAPTER(name) || typeof value !== 'boolean') throw new Error('网卡或 IPv6 值无效，已停止。')
    return `${value ? 'Enable' : 'Disable'}-NetAdapterBinding -Name ${psQuote(name)} -ComponentID ms_tcpip6 -Confirm:$false -ErrorAction Stop`
  }
  throw new Error('不支持的修复项。')
}

export function createEnvironment({ dataDir, powershell = defaultPowershell, elevated = defaultElevated, resolve = defaultResolve,
  guardStatus = () => null, clashConfigs = async () => null, exitProbe = () => null, now = () => Date.now() } = {}) {
  if (!dataDir) throw new Error('缺少数据目录')
  const baselinePath = join(dataDir, 'environment-baseline.json')
  const root = join(dataDir, 'environment-backups')
  let chain = Promise.resolve()
  const locked = task => { const run = chain.then(task); chain = run.catch(() => {}); return run }

  async function privateDir(path) {
    await mkdir(path, { recursive: true, mode: 0o700 })
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('环境备份目录必须为真实文件夹，已停止。')
  }
  async function readSystem() {
    const result = await powershell(READ_SCRIPT)
    if (!result.ok) throw new Error('无法读取 Windows 设置，请稍后重新检查。')
    return parseSystem(result.stdout)
  }
  async function readJSONFile(path) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('环境目标文件无法读取，原文件已保留。') }
  }
  // 通用模板首次记录本机实际值作为目标；国家默认不限
  async function baseline(system) {
    const saved = await readJSONFile(baselinePath)
    if (saved) return validateBaseline(saved)
    const sys = system || await readSystem()
    const initial = validateBaseline({ template: 'standard', country: '', region: sys.region || '', timezone: TZ.test(sys.timezone) ? sys.timezone : 'UTC',
      culture: TAG.test(sys.culture) ? sys.culture : 'en-US', language: TAG.test(sys.languages[0] || '') ? sys.languages[0] : 'en-US' })
    await privateDir(dataDir); await atomicJSON(baselinePath, initial)
    return initial
  }
  async function saveBaseline(input) {
    const value = validateBaseline(input)
    await privateDir(dataDir); await atomicJSON(baselinePath, value)
    return value
  }

  // ---------- 检查 ----------
  async function inspect() {
    const sys = await readSystem()
    const policy = await baseline(sys)
    const strict = policy.template === 'strict'
    const [addresses, configs] = await Promise.all([resolve('claude.ai'), clashConfigs().catch(() => null)])
    const status = guardStatus() || null
    const configured = !!status && status.state !== 'unconfigured'
    const requireTun = status?.requireTun === true
    const rows = []
    const row = r => rows.push({ fixable: false, blocking: false, keys: [], manual: null, ...r })
    const state = (ok, blocking, unknown = false) => unknown ? 'unknown' : ok ? 'ok' : blocking ? 'fail' : 'warn'

    // Clash TUN：读守护配置的 requireTun
    const tun = status?.tunEnabled ?? (typeof configs?.tun?.enable === 'boolean' ? configs.tun.enable : null)
    const singbox = status?.backendKind === 'singbox' // v2rayN（sing-box 内核）：TUN 状态来自它生成的配置文件
    row({ id: 'tun', title: singbox ? 'sing-box 虚拟网卡（TUN）' : 'Clash 虚拟网卡（TUN）', current: tun === null ? '未知' : tun ? '开启' : '关闭', expected: requireTun ? '开启' : '不要求',
      state: !configured ? 'info' : tun === null ? 'unknown' : requireTun ? state(tun, true) : 'info', blocking: requireTun,
      detail: !configured ? '守护尚未配置，未检查 TUN' : requireTun ? (tun ? '守护要求的 TUN 已开启' : singbox ? '在 v2rayN 主界面打开 TUN' : '在 Clash Verge 首页打开「虚拟网卡模式」')
        : singbox ? '当前守护未要求 TUN；没走 v2rayN 的流量不在保护范围内' : '当前守护未要求 TUN；没走 Clash 的流量不在保护范围内' })

    // 系统 DNS 是否返回 Fake-IP
    const fake = addresses.length > 0 && addresses.every(isFakeIP)
    row({ id: 'dns', title: '系统 DNS（Fake-IP）', current: addresses.length ? (fake ? `${addresses[0]}（Fake-IP）` : addresses[0]) : '未解析', expected: strict ? 'Fake-IP' : '建议 Fake-IP',
      state: addresses.length ? state(fake, strict) : 'unknown', blocking: strict,
      detail: fake ? 'claude.ai 由 Clash 接管解析' : '在 Clash Verge 设置 → DNS 中把增强模式设为 fake-ip；真实地址本身不代表泄漏' })

    // 物理网卡 IPv6：严格模板要求关闭；守护要求 TUN 而 Clash 没接管 IPv6 时也视为阻塞（IPv6 可能绕过 TUN）
    const clashNoV6 = configs?.ipv6 === false
    const v6Blocking = strict || requireTun && clashNoV6
    if (!sys.adapters.length) row({ id: 'ipv6', title: 'IPv6', current: '没有已连接的物理网卡', expected: '关闭', state: 'unknown', detail: '未找到已连接的有线或无线网卡' })
    for (const adapter of sys.adapters) {
      const key = `ipv6:${adapter.name}`
      row({ id: key, keys: [key], title: `IPv6 · ${adapter.name}`, current: adapter.ipv6 === null ? '未知' : adapter.ipv6 ? '开启' : '关闭', expected: v6Blocking ? '关闭' : '建议关闭',
        state: state(adapter.ipv6 === false, v6Blocking, adapter.ipv6 === null), blocking: v6Blocking, fixable: adapter.ipv6 === true, admin: true,
        detail: adapter.ipv6 === false ? adapter.description : v6Blocking ? (strict ? '严格模板要求关闭' : 'Clash 没有接管 IPv6，开着可能绕过 TUN') + '；修复需要管理员授权' : '未强制；如发现旁路可关闭' })
    }

    // 公网出口国家：取「专线检测」里 Cloudflare trace 的 loc（系统网络实测，只做比较，不参与守护判定）
    const probe = exitProbe() || null
    const exitCountry = probe?.ok && ISO2.test(probe.location || '') ? probe.location : ''
    row({ id: 'country', title: '公网出口国家', current: exitCountry || '未取得', expected: policy.country || '不限',
      state: !policy.country ? 'info' : !exitCountry ? 'unknown' : state(exitCountry === policy.country, strict), blocking: strict && !!policy.country,
      detail: !exitCountry ? '先在「专线检测」里点「重新检测」' : policy.country ? '整机走固定出口时即 Claude 出口所在国；不一致时请换出口或改目标' : '未限制国家' })

    const regionFixable = !!policy.region && sys.region !== policy.region && !!GEO_IDS[policy.region]
    row({ id: 'region', keys: ['region'], title: '系统国家或地区', current: sys.region ? `${sys.region}${sys.regionName ? ' · ' + sys.regionName : ''}` : '未知', expected: policy.region || '不检查',
      state: !policy.region ? 'info' : state(sys.region === policy.region, strict, !sys.region), blocking: strict && !!policy.region, fixable: regionFixable,
      detail: policy.region && sys.region !== policy.region && !GEO_IDS[policy.region] ? '请在 设置 → 时间和语言 → 语言和区域 → 国家或地区 手动选择' : '设置 → 时间和语言 → 语言和区域' })
    row({ id: 'timezone', keys: ['timezone'], title: '时区', current: sys.timezone || '未知', expected: policy.timezone,
      state: state(sys.timezone === policy.timezone, strict, !sys.timezone), blocking: strict, fixable: !!sys.timezone && sys.timezone !== policy.timezone,
      detail: '对应 设置 → 时间和语言 → 日期和时间' })
    row({ id: 'culture', keys: ['culture'], title: '区域格式', current: sys.culture || '未知', expected: policy.culture,
      state: state(sys.culture === policy.culture, strict, !sys.culture), blocking: strict, fixable: !!sys.culture && sys.culture !== policy.culture,
      detail: '日期、数字和货币的显示格式；新打开的程序生效' })
    const lang = sys.languages[0] || ''
    row({ id: 'language', title: 'Windows 显示语言', current: lang || '未知', expected: policy.language,
      state: state(lang === policy.language, strict, !lang), blocking: strict, manual: lang && lang !== policy.language ? 'language' : null,
      detail: lang === policy.language ? '首选语言一致' : `需手动：设置 → 时间和语言 → 语言和区域，把 ${policy.language} 移到首位，注销后生效` })

    const blocking = rows.filter(r => r.blocking && r.state !== 'info')
    return { checkedAt: now(), policy, configured, rows,
      ready: blocking.every(r => r.state === 'ok'),
      repairKeys: rows.filter(r => r.fixable).flatMap(r => r.keys),
      blockingKeys: rows.filter(r => r.fixable && r.blocking && r.state === 'fail').flatMap(r => r.keys) }
  }

  // ---------- 捕获当前值（用于预览、恢复点、核对） ----------
  async function capture(keys, policy, sys) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 32 || keys.some(k => typeof k !== 'string' || !KEY.test(k)) || new Set(keys).size !== keys.length) throw new Error('请选择支持的修复项。')
    const system = sys || await readSystem()
    const before = {}, after = {}
    for (const key of keys) {
      if (key === 'timezone') {
        if (!TZ.test(system.timezone)) throw new Error('无法读取当前时区，已停止修复。')
        before[key] = system.timezone; after[key] = policy?.timezone
      } else if (key === 'culture') {
        if (!TAG.test(system.culture)) throw new Error('无法读取当前区域格式，已停止修复。')
        before[key] = system.culture; after[key] = policy?.culture
      } else if (key === 'region') {
        if (!system.geoId) throw new Error('无法读取当前国家或地区，已停止修复。')
        before[key] = { geoId: system.geoId, code: system.region }
        if (policy) { const id = GEO_IDS[policy.region]; if (!id) throw new Error('目标国家或地区不在自动修复范围内，请手动设置。'); after[key] = { geoId: id, code: policy.region } }
      } else {
        const name = key.slice(5), adapter = system.adapters.find(a => a.name === name)
        if (!adapter || adapter.ipv6 === null) throw new Error(`找不到网卡「${name}」或无法读取它的 IPv6 状态，未修改网络。`)
        before[key] = adapter.ipv6; after[key] = false
      }
    }
    return { before, after }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const label = (key, value) => value === undefined ? '—' : key.startsWith('ipv6:') ? (value ? '开启' : '关闭') : key === 'region' ? value.code || `GeoId ${value.geoId}` : value
  const planToken = state => createHash('sha256').update(JSON.stringify(Object.keys(state.before).sort().map(k => [k, state.before[k], state.after[k]]))).digest('hex')

  async function preview(keys) {
    const sys = await readSystem(), policy = await baseline(sys)
    const audit = await inspect()
    const valid = keys ?? audit.repairKeys
    if (valid.some(k => !audit.repairKeys.includes(k))) throw new Error('所选项目当前不需要或不能自动修复，请重新检查。')
    if (!valid.length) return { planToken: null, plan: [], manual: audit.rows.filter(r => r.manual).map(r => ({ id: r.id, title: r.title, detail: r.detail })) }
    const state = await capture(valid, policy, sys)
    const blocking = new Set(audit.blockingKeys)
    return { planToken: planToken(state),
      plan: valid.map(key => ({ key, title: keyTitle(key), before: label(key, state.before[key]), after: label(key, state.after[key]), blocking: blocking.has(key), admin: needsAdmin(key), selected: blocking.has(key) })),
      manual: audit.rows.filter(r => r.manual).map(r => ({ id: r.id, title: r.title, current: r.current, expected: r.expected, detail: r.detail })) }
  }

  // ---------- 执行 ----------
  async function run(keys, values) {
    // 普通项逐个执行；IPv6 项合并成一次管理员授权
    const outcome = {}
    for (const key of keys.filter(k => !needsAdmin(k))) {
      const result = await powershell(applyScript(key, values[key]))
      outcome[key] = result.ok ? null : '系统没有接受这项更改'
    }
    const admin = keys.filter(needsAdmin)
    if (admin.length) {
      const result = await elevated(admin.map(k => applyScript(k, values[k])).join('\n'))
      for (const key of admin) outcome[key] = result.ok ? null : result.cancelled ? '你取消了管理员授权（UAC），没有修改' : '管理员命令未完成'
    }
    return outcome
  }

  async function history() {
    await privateDir(root)
    const records = []
    for (const name of (await readdir(root)).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
      try {
        const item = JSON.parse(await readFile(join(root, name), 'utf8'))
        if (item.version === 1) records.push({ id: item.id, at: item.at, status: item.status, keys: item.keys,
          detail: item.keys.map(keyTitle).join('、'), changes: item.keys.map(k => ({ key: k, title: keyTitle(k), before: label(k, item.before[k]), after: label(k, item.after[k]) })), outcomes: item.outcomes })
      } catch { /* 损坏的记录跳过，原文件保留 */ }
    }
    return { history: records.sort((a, b) => b.at - a.at) }
  }

  // input: { plan: 预览时的全部键, keys: 用户勾选的键, planToken }
  async function apply(input) {
    return locked(async () => {
      const { plan, keys, planToken: token } = input || {}
      if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !Array.isArray(plan)) throw new Error('请先预览并确认要修改的设置。')
      if (!Array.isArray(keys) || !keys.length) throw new Error('请至少勾选一项。')
      if (keys.some(k => !plan.includes(k))) throw new Error('勾选的项目不在预览里，请重新预览。')
      const sys = await readSystem(), policy = await baseline(sys)
      const planned = await capture(plan, policy, sys)
      if (planToken(planned) !== token) throw new Error('系统设置或目标在预览后变了，请重新预览再确认。')
      const state = { before: {}, after: {} }
      for (const k of keys) { state.before[k] = planned.before[k]; state.after[k] = planned.after[k] }
      const id = randomUUID(), latest = (await history()).history[0]?.at || 0
      const record = { version: 1, id, at: Math.max(now(), latest + 1), keys, ...state, status: 'applying', outcomes: [] }
      const file = join(root, id + '.json')
      await privateDir(root); await atomicJSON(file, record) // 先存恢复点
      const pending = keys.filter(k => !same(state.before[k], state.after[k]))
      const failed = await run(pending, state.after)
      const check = await readSystem()
      const current = (await capture(keys, null, check)).before
      let ok = true
      for (const key of keys) {
        const done = same(current[key], state.after[key])
        if (!done) ok = false
        record.outcomes.push(`${keyTitle(key)}：${done ? '已修改并核对' : failed[key] || '更改后核对未通过'}`)
      }
      record.status = ok ? 'applied' : 'partial'
      await atomicJSON(file, record)
      return { status: record.status, note: ok ? `已修改并保存恢复点。${keys.includes('culture') ? '区域格式对新打开的程序生效；' : ''}需要时可在「更改记录与恢复」中撤销。`
        : '部分设置没有改成功，原设置已保存，可在「更改记录与恢复」中恢复。', outcomes: record.outcomes, ...(await history()) }
    })
  }

  async function restore(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('恢复记录无效。')
    return locked(async () => {
      const file = join(root, id + '.json')
      let record
      try { record = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('恢复记录不存在或已损坏。') }
      if (record.version !== 1 || !Array.isArray(record.keys) || record.keys.some(k => !KEY.test(k))) throw new Error('恢复记录格式无效。')
      if (record.status === 'restored') return { status: 'restored', note: '这次更改已经恢复过。', outcomes: [], ...(await history()) }
      // 按新到旧恢复，避免覆盖之后的更改
      if ((await history()).history.some(item => item.at > record.at && item.status !== 'restored')) throw new Error('请先恢复更新的那次更改，再恢复这一次。')
      const sys = await readSystem()
      const current = (await capture(record.keys, null, sys)).before
      // 发现被其他程序改过：既不是修改前也不是修改后的值，就停止，不覆盖
      const changed = record.keys.filter(k => !same(current[k], record.before[k]) && !same(current[k], record.after[k]))
      if (changed.length) {
        record.outcomes = changed.map(k => `${keyTitle(k)}：已被其他程序或你手动改过，未覆盖`)
        record.status = 'restore-partial'; await atomicJSON(file, record)
        return { status: record.status, note: `${changed.map(keyTitle).join('、')} 在这之后被改过，已停止恢复，记录保留。`, outcomes: record.outcomes, ...(await history()) }
      }
      record.status = 'restoring'; record.outcomes = []; await atomicJSON(file, record)
      const pending = [...record.keys].reverse().filter(k => !same(current[k], record.before[k]))
      const failed = await run(pending, record.before)
      const after = (await capture(record.keys, null, await readSystem())).before
      let ok = true
      for (const key of [...record.keys].reverse()) {
        const done = same(after[key], record.before[key])
        if (!done) ok = false
        record.outcomes.push(`${keyTitle(key)}：${done ? '已恢复原设置' : failed[key] || '恢复后核对未通过'}`)
      }
      record.status = ok ? 'restored' : 'restore-partial'
      await atomicJSON(file, record)
      return { status: record.status, note: ok ? '已恢复到这次修改之前的设置。' : '部分设置没有恢复，记录已保留，可稍后重试。', outcomes: record.outcomes, ...(await history()) }
    })
  }

  return { inspect, baseline: () => baseline(), saveBaseline, preview, apply, restore, history }
}
