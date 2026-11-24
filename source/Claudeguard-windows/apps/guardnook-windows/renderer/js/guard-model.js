'use strict'
// 守护状态模型：把内核状态翻译成「一个状态、一个原因、一个下一步」。
// 纯函数，不碰 DOM。守护页、连接检查、配置第 3 步都只读这里的结果。
// 放行与否以主进程算出的 indicator 为准（与任务栏、托盘的 Clawd 同一判断）。
;(() => {
  const GN = window.GN

  const reasons = {
    'relay-awaiting-confirmation': '已经实测到中转出口。核对下面的实测 IPv4，确认后开始连续验证。',
    entry_unavailable: '没有可用的入口节点。在 Clash 的「入口选择」里切到另一个候选入口，再重新验证；订阅更新后原节点名也可能失效。',
    exit_unreachable: '已选入口无法连到 SOCKS5 出口。检查配置第 2 步的出口地址和端口，也可以在 Clash 的「入口选择」切换候选入口。',
    exit_auth_failed: 'SOCKS5 出口拒绝了账号或密码。请回到配置第 2 步重新填写。',
    egress_mismatch: 'Claude 通道实测出口与已确认的 IPv4 不同，已阻断。',
    global_ipv6_present: '守护通道外的网卡可以用 IPv6 出网，Claude 未放行。到「环境」页关闭网卡 IPv6 后重新验证。',
    relay_credentials_unavailable: '无法读取保存的 SOCKS5 凭据，Claude 未放行。请回到配置第 2 步重新填写。',
    'observation-only': '当前仅观测，尚未启用保护。',
    'personal-guard-conflict': 'Clash 已载入个人版或旧版守护规则。请检查全局扩展脚本和当前订阅，清除旧规则后重新导入 ClaudeGuard 规则。',
    'guard-route-not-installed': '还没检测到守护规则。把生成的脚本导入 Clash 并重载配置。',
    'protected-rules-changed': 'Clash 当前的 Claude 分流规则与这份守护配置不一致。请重新导入规则并重载 Clash。',
    'coverage-rules-changed': 'Clash 当前的覆盖规则已改变。请重新导入规则并重载 Clash。',
    'device-rules-required': 'Clash 尚未载入整机固定出口规则。请重新导入规则并重载 Clash。',
    'device-tun-coverage': 'TUN 已开启，但整机固定出口还需要自动路由、严格路由和 DNS 劫持。请检查 Clash 的 TUN 配置，并确认没有排除公网路由，再重新验证。',
    'frozen-chain-changed': '固定节点链已改变。请回到配置第 2 步重新核对入口节点和固定出口。',
    'rule-mode-required': '请把 Clash 切换到「规则」模式。',
    'tun-required': '请在 Clash Verge 首页打开「虚拟网卡模式（TUN）」，然后回到这里重新验证。',
    'tun-status-unavailable': '无法确认 TUN 状态。请在代理客户端确认 TUN 已开启，然后重新验证。',
    'probe-or-controller-unavailable': '无法读取控制接口或完成出口探测。请确认代理客户端正在运行，再到配置第 1 步核对控制接口和接口密钥。',
    'manual-block': '已手动阻断。点「启用保护」后重新验证。',
    'confirming-exit': '正在连续确认固定出口，验证完成前保持阻断。',
    'exit-ip-mismatch': '实测出口与允许的 IPv4 不一致，已阻断。',
    'verified-pinned-exit': '固定出口、守护规则与实测 IPv4 已连续验证；只在当前有效租约内放行。',
    'verification-expired': '验证已过期，网关保持阻断。',
    'ready-not-enabled': '规则与出口已检查，尚未启用保护。',
  }
  // v2rayN（sing-box 内核）下，同一原因换成 v2rayN / sing-box 的说法
  const singboxReasons = {
    'guard-route-not-installed': '还没检测到守护规则。在 v2rayN 添加守护网关节点、导入路由规则并放到最前面。',
    'protected-rules-changed': 'Claude 路由规则已改变，或有别的规则排在 ClaudeGuard 规则前面，网关保持阻断。',
    'frozen-chain-changed': '固定出口不再是一个具体节点，请回到配置第 2 步核对别名。',
    'rule-mode-required': '请让 sing-box 保持「规则」模式（v2rayN 不要切到全局或直连）。',
    'tun-required': 'TUN 未开启，网关保持阻断。请在 v2rayN 打开 TUN。',
    'tun-status-unavailable': '无法从 v2rayN 生成的 sing-box 配置确认 TUN，网关保持阻断。可在配置第 1 步重新识别。',
    'probe-or-controller-unavailable': '探测或 sing-box 控制接口不可用，网关保持阻断。检查 v2rayN 是否在运行、第二本地端口是否开启。',
  }
  const fixImport = { step: 1, row: 'rules', label: '查看导入步骤', action: 'import' }
  const fixExit = { step: 3, row: 'exit', label: '打开出口配置', action: 'setup-exit' }
  const recheckTun = { step: 2, row: 'tun', label: '重新验证', action: 'inspect' }
  const remedies = {
    'personal-guard-conflict': fixImport,
    'protected-rules-changed': fixImport,
    'coverage-rules-changed': fixImport,
    'device-rules-required': fixImport,
    'device-tun-coverage': { ...recheckTun, row: 'rules' },
    'guard-route-not-installed': fixImport,
    'frozen-chain-changed': { ...fixExit, row: 'rules', step: 1, label: '打开节点配置' },
    'rule-mode-required': { ...recheckTun, row: 'rules' },
    'tun-required': recheckTun,
    'tun-status-unavailable': recheckTun,
    'probe-or-controller-unavailable': { step: 0, row: 'controller', label: '打开接口配置', action: 'setup' },
    global_ipv6_present: { step: 2, row: 'ipv6', label: '打开环境检查', action: 'env' },
    entry_unavailable: { ...fixExit, row: 'entry', label: '打开节点配置' },
    exit_unreachable: fixExit,
    exit_auth_failed: fixExit,
    relay_credentials_unavailable: fixExit,
    egress_mismatch: { ...fixExit, row: 'egress' },
    'exit-ip-mismatch': { ...fixExit, row: 'egress' },
    'verification-expired': { step: 3, row: 'egress', label: '重新验证', action: 'inspect' },
    'relay-awaiting-confirmation': { step: 3, row: 'egress' },
  }
  const issueLabels = {
    'personal-guard-conflict': '规则冲突', 'protected-rules-changed': '规则已改变', 'coverage-rules-changed': '覆盖已改变',
    'device-rules-required': '缺少整机规则', 'guard-route-not-installed': '待导入', 'frozen-chain-changed': '节点链已改变',
    'device-tun-coverage': '整机路由覆盖未通过',
    'rule-mode-required': '需切换规则模式', 'tun-required': '需开启', 'tun-status-unavailable': '无法确认',
    'probe-or-controller-unavailable': '待重新检查', global_ipv6_present: '检测到可用出口', entry_unavailable: '入口不可用',
    exit_unreachable: '连接失败', exit_auth_failed: '认证失败', relay_credentials_unavailable: '凭据不可用',
    egress_mismatch: '出口不一致', 'exit-ip-mismatch': '出口不一致', 'verification-expired': '验证已过期',
  }

  function stepsFor(at, status, relay, singbox = false) {
    const names = singbox ? ['识别 v2rayN 并保存', '导入路由规则', 'sing-box 与本机环境', '连续确认出口', '网关放行']
      : ['识别 Clash 并保存', '导入守护规则', 'Clash 与本机环境', relay ? '确认实测出口' : '连续确认出口', '网关放行']
    return names.map((name, i) => ({ name, status: i < at ? 'done' : i === at ? status : status === 'error' ? 'blocked' : 'todo' }))
  }

  function derive(state, settings) {
    const s = state.status || {}, configured = !!settings, relay = !!settings?.relay, singbox = settings?.backendKind === 'singbox'
    const key = state.indicator?.key || 'unconfigured'
    const why = s.reason
    const conflict = why === 'personal-guard-conflict'
    const good = key === 'protected' && !conflict
    const reasonKey = why === 'observation-only' && s.phase === 'awaiting-rules' ? 'guard-route-not-installed' : why
    const reason = s.startError || (singbox && singboxReasons[reasonKey]) || reasons[reasonKey] || s.remedy?.text
      || (configured ? '守护状态尚未确认。请重新验证，并查看下面的连接检查。' : '先识别 Clash，再选择入口节点和固定出口。')
    const steps = (at, status, relay) => stepsFor(at, status, relay, singbox)
    const awaitingConfirm = why === 'relay-awaiting-confirmation' && s.last?.ip
    const running = configured && s.state !== 'unconfigured'
    const remedy = running && Object.hasOwn(remedies, why) ? remedies[why] : null

    let title, tone, primary, progress
    if (!configured) {
      title = '尚未配置保护'; tone = 'idle'; primary = { label: '开始配置', action: 'setup' }; progress = steps(0, 'waiting', relay)
    } else if (!running) {
      title = '守护未启动'; tone = 'bad'; primary = { label: '修改配置', action: 'setup-exit' }; progress = steps(0, 'error', relay)
    } else if (conflict) {
      title = '守护规则冲突'; tone = 'bad'; primary = { label: fixImport.label, action: fixImport.action }; progress = steps(fixImport.step, 'error', relay)
    } else if (good) {
      title = '固定出口已放行'; tone = 'good'; primary = { label: '重新验证', action: 'inspect' }; progress = steps(5, 'done', relay)
    } else if (awaitingConfirm) {
      title = '请确认实测出口'; tone = 'warn'; primary = { label: `确认出口 ${s.last.ip}`, action: 'confirm-relay' }; progress = steps(3, 'waiting', relay)
    } else if (s.phase === 'awaiting-rules' || why === 'guard-route-not-installed') {
      title = '待导入守护规则'; tone = 'idle'; primary = { label: singbox ? '导入 v2rayN 规则' : '导入 Clash 规则', action: 'import' }; progress = steps(1, 'waiting', relay)
    } else if (key === 'verifying') {
      title = '正在验证固定出口'; tone = 'warn'; primary = { label: '正在确认出口…', action: null }; progress = steps(3, 'active', relay)
    } else if (why === 'manual-block') {
      title = '已手动阻断'; tone = 'bad'; primary = { label: '启用保护', action: 'enable' }; progress = steps(4, 'paused', relay)
    } else if (remedy?.action) {
      title = 'Claude 尚未放行'; tone = 'bad'; primary = { label: remedy.label, action: remedy.action }; progress = steps(remedy.step, 'error', relay)
    } else if (!s.enabled) {
      title = '尚未启用保护'; tone = 'idle'; primary = { label: '启用保护', action: 'enable' }; progress = steps(4, 'waiting', relay)
    } else {
      title = 'Claude 尚未放行'; tone = 'bad'; primary = { label: '重新验证', action: 'inspect' }; progress = steps(4, 'error', relay)
    }
    return { good, configured, running, relay, singbox, key, why, conflict, reason, tone, title, primary, steps: progress,
      help: { ...primary, detail: reason }, affectedRow: remedy?.row || (progress[1].status === 'waiting' ? 'rules' : null),
      canBlock: running && s.manual !== true && (s.enabled === true || good) }
  }

  // 连接检查：每项 [名称, 结果文字, 色调, 可选的处理说明]
  function checklist(state, settings, model = derive(state, settings)) {
    const s = state.status || {}, gate = state.indicator?.key === 'protected', relay = !!settings?.relay
    const running = !!settings && s.state !== 'unconfigured'
    const controller = running && !['observation-only', 'probe-or-controller-unavailable'].includes(s.reason)
    const rows = [
      ['controller', settings?.backendKind === 'singbox' ? 'sing-box 控制接口' : 'Clash 控制接口', controller ? '可连接' : '待检查', controller ? 'good' : 'pending'],
      ['tun', 'TUN 虚拟网卡', s.tunEnabled === true ? '已开启' : s.tunEnabled === false ? '需开启' : s.requireTun === false ? '未要求' : '待确认',
        s.tunEnabled === true ? 'good' : s.tunEnabled === false ? 'warn' : 'pending'],
      ['rules', '守护规则', s.prepared ? '已载入' : s.phase === 'awaiting-rules' ? '待导入' : '待验证', s.prepared ? 'good' : 'pending'],
    ]
    if (relay) for (const [stage, title] of [['entry', '入口节点'], ['exit', 'SOCKS5 出口']]) {
      const result = s.relay?.stages?.[stage]
      rows.push([stage, title, result ? result.ok ? '通过' : '未通过' : '待检测', result ? result.ok ? 'good' : 'bad' : 'pending'])
    }
    rows.push(['egress', '守护链路出口 IPv4', gate ? s.last?.ip || '待实测'
      : s.reason === 'relay-awaiting-confirmation' && s.last?.ip ? `${s.last.ip} · 待确认` : model.steps[3].status === 'active' ? '验证中' : '尚未放行',
      gate ? 'good' : 'pending'])
    rows.push(['ipv6', 'IPv6 出口', s.reason === 'global_ipv6_present' ? '检测到可用出口' : gate && relay ? '未检测到' : '待确认',
      s.reason === 'global_ipv6_present' ? 'bad' : gate && relay ? 'good' : 'pending'])
    const dns = state.diagnostics?.expiresAt > Date.now() ? state.diagnostics?.dns?.state : null
    rows.push(['dns', 'Claude DNS', dns === 'configured' ? '配置已核对' : '待核对', dns === 'configured' ? 'good' : 'pending'])

    return rows.map(([key, title, detail, tone]) => {
      if (!model.good && key === model.affectedRow) {
        const waiting = model.steps.some(step => step.status === 'waiting')
        return [title, issueLabels[model.why] || detail, waiting ? 'warn' : 'bad', model.help]
      }
      if (key === 'tun' && tone === 'warn')
        return [title, detail, tone, { label: '重新验证', action: 'inspect', detail: (model.singbox ? singboxReasons : reasons)['tun-required'] }]
      if (tone === 'pending' && (
        ['entry', 'exit', 'egress'].includes(key) && model.steps[2].status === 'blocked'
        || key === 'exit' && s.relay?.stages?.entry?.ok === false
        || key === 'egress' && (s.relay?.stages?.entry?.ok === false || s.relay?.stages?.exit?.ok === false)
      )) return [title, '待前置', 'pending']
      return [title, detail, tone]
    })
  }

  GN.guard = { reasons, singboxReasons, derive, checklist }
})()
