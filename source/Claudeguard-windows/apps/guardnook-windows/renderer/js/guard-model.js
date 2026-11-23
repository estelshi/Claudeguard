'use strict'
// 守护状态模型：把内核状态翻译成「一个状态、一个原因、一个下一步」。
// 纯函数，不碰 DOM。守护页、连接检查、配置第 3 步都只读这里的结果。
// 放行与否以主进程算出的 indicator 为准（与任务栏、托盘的 Clawd 同一判断）。
;(() => {
  const GN = window.GN

  const reasons = {
    'relay-awaiting-confirmation': '已经实测到中转出口。核对下面的实测 IPv4，确认后开始连续验证。',
    entry_unavailable: '没有可用的入口节点。在 Clash 的「入口选择」里切到另一个候选入口，再重新验证；订阅更新后原节点名也可能失效。',
    exit_unreachable: '已选入口无法连到 SOCKS5 出口。检查出口地址与端口，或在 Clash 切换入口。',
    exit_auth_failed: 'SOCKS5 出口拒绝了账号或密码。请回到配置第 2 步重新填写。',
    egress_mismatch: 'Claude 通道实测出口与已确认的 IPv4 不同，已阻断。',
    global_ipv6_present: '守护通道外的网卡可以用 IPv6 出网，Claude 未放行。到「环境」页关闭网卡 IPv6 后重新验证。',
    relay_credentials_unavailable: '无法读取保存的 SOCKS5 凭据，Claude 未放行。请回到配置第 2 步重新填写。',
    'observation-only': '当前仅观测，尚未启用保护。',
    'guard-route-not-installed': '还没检测到守护规则。把生成的脚本导入 Clash 并重载配置。',
    'protected-rules-changed': 'Claude 分流规则已改变，网关保持阻断。',
    'coverage-rules-changed': '保护覆盖规则已改变，网关保持阻断。',
    'frozen-chain-changed': '固定节点链已改变，请重新确认节点配置。',
    'rule-mode-required': '请把 Clash 切换到「规则」模式。',
    'tun-required': 'TUN 未开启，网关保持阻断。请在 Clash 开启虚拟网卡模式。',
    'tun-status-unavailable': '无法确认 TUN 状态，网关保持阻断。',
    'probe-or-controller-unavailable': '探测或 Clash 控制接口不可用，网关保持阻断。',
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
  // 需要回到 Clash 或系统处理的问题
  const environment = new Set(['protected-rules-changed', 'coverage-rules-changed', 'frozen-chain-changed', 'rule-mode-required', 'tun-required',
    'tun-status-unavailable', 'probe-or-controller-unavailable', 'global_ipv6_present'])
  // 中转链路（入口 → SOCKS5 出口）本身不通：算在「出口」这一步
  const relayPath = new Set(['entry_unavailable', 'exit_unreachable'])
  const reconfigure = new Set(['exit_auth_failed', 'relay_credentials_unavailable'])

  function stepsFor(at, status, relay, singbox = false) {
    const names = singbox ? ['识别 v2rayN 并保存', '导入路由规则', 'sing-box 与本机环境', '连续确认出口', '网关放行']
      : ['识别 Clash 并保存', '导入守护规则', 'Clash 与本机环境', relay ? '确认实测出口' : '连续确认出口', '网关放行']
    return names.map((name, i) => ({ name, status: i < at ? 'done' : i === at ? status : 'todo' }))
  }

  function derive(state, settings) {
    const s = state.status || {}, configured = !!settings, relay = !!settings?.relay, singbox = settings?.backendKind === 'singbox'
    const key = state.indicator?.key || 'unconfigured'
    const good = key === 'protected'
    const why = s.reason
    const reason = s.startError || (singbox && singboxReasons[why]) || reasons[why] || why || '先识别 Clash，再选择入口节点和固定出口。'
    const steps = (at, status, relay) => stepsFor(at, status, relay, singbox)
    const awaitingConfirm = why === 'relay-awaiting-confirmation' && s.last?.ip
    const running = configured && s.state !== 'unconfigured'

    let title, tone, primary, progress
    if (!configured) {
      title = '尚未配置保护'; tone = 'idle'; primary = { label: '开始配置', action: 'setup' }; progress = steps(0, 'active', relay)
    } else if (!running) {
      title = '守护未启动'; tone = 'bad'; primary = { label: '修改配置', action: 'setup-exit' }; progress = steps(0, 'error', relay)
    } else if (good) {
      title = '固定出口已放行'; tone = 'good'; primary = { label: '重新验证', action: 'inspect' }; progress = steps(5, 'done', relay)
    } else if (awaitingConfirm) {
      title = '请确认实测出口'; tone = 'warn'; primary = { label: `确认出口 ${s.last.ip}`, action: 'confirm-relay' }; progress = steps(3, 'active', relay)
    } else if (s.phase === 'awaiting-rules' || why === 'guard-route-not-installed') {
      title = '待导入守护规则'; tone = 'idle'; primary = { label: singbox ? '导入 v2rayN 规则' : '导入 Clash 规则', action: 'import' }; progress = steps(1, 'active', relay)
    } else if (key === 'verifying') {
      title = '正在验证固定出口'; tone = 'warn'; primary = { label: '正在确认出口…', action: null }; progress = steps(3, 'active', relay)
    } else if (why === 'manual-block') {
      title = '已手动阻断'; tone = 'bad'; primary = { label: '启用保护', action: 'enable' }; progress = steps(4, 'error', relay)
    } else if (reconfigure.has(why)) {
      title = 'Claude 尚未放行'; tone = 'bad'; primary = { label: '重新填写出口', action: 'setup-exit' }; progress = steps(0, 'error', relay)
    } else if (relayPath.has(why)) {
      title = 'Claude 尚未放行'; tone = 'bad'; primary = { label: '切换入口后重新验证', action: 'inspect' }; progress = steps(3, 'error', relay)
    } else if (environment.has(why)) {
      title = 'Claude 尚未放行'; tone = 'bad'; primary = { label: '处理后重新验证', action: 'inspect' }; progress = steps(2, 'error', relay)
    } else if (['exit-ip-mismatch', 'egress_mismatch', 'verification-expired'].includes(why)) {
      title = 'Claude 尚未放行'; tone = 'bad'; primary = { label: '重新验证', action: 'inspect' }; progress = steps(3, 'error', relay)
    } else if (!s.enabled) {
      title = '尚未启用保护'; tone = 'idle'; primary = { label: '启用保护', action: 'enable' }; progress = steps(4, 'active', relay)
    } else {
      title = 'Claude 尚未放行'; tone = 'bad'; primary = { label: '重新验证', action: 'inspect' }; progress = steps(4, 'error', relay)
    }
    return { good, configured, running, relay, singbox, key, why, reason, tone, title, primary, steps: progress,
      canBlock: running && s.manual !== true && (s.enabled === true || good) }
  }

  // 连接检查：每项 [名称, 结果文字, good|bad|pending]
  function checklist(state, settings) {
    const s = state.status || {}, gate = state.indicator?.key === 'protected', relay = !!settings?.relay
    const running = !!settings && s.state !== 'unconfigured'
    const controller = running && !['probe-or-controller-unavailable', 'tun-status-unavailable'].includes(s.reason)
    const rows = [
      [settings?.backendKind === 'singbox' ? 'sing-box 控制接口' : 'Clash 控制接口', !running ? '待确认' : controller ? '可连接' : '不可用', !running ? 'pending' : controller ? 'good' : 'bad'],
      ['TUN 虚拟网卡', s.tunEnabled === true ? '已开启' : s.tunEnabled === false ? '需开启' : s.requireTun === false ? '未要求' : '待确认',
        s.tunEnabled === true ? 'good' : s.tunEnabled === false ? 'bad' : 'pending'],
      ['守护规则', s.prepared ? '已载入' : s.phase === 'awaiting-rules' ? '待导入' : '等待验证', s.prepared ? 'good' : 'pending'],
    ]
    if (relay) for (const [stage, title] of [['entry', '入口节点'], ['exit', 'SOCKS5 出口']]) {
      const result = s.relay?.stages?.[stage]
      rows.push([title, result ? result.ok ? '通过' : '未通过' : '等待检测', result ? result.ok ? 'good' : 'bad' : 'pending'])
    }
    rows.push(['守护链路出口 IPv4', gate ? s.last?.ip || '待实测' : s.reason === 'relay-awaiting-confirmation' && s.last?.ip ? `${s.last.ip} · 待确认` : '尚未放行',
      gate ? 'good' : 'pending'])
    rows.push(['IPv6 出口', s.reason === 'global_ipv6_present' ? '检测到可用出口' : gate && relay ? '未检测到' : '待确认',
      s.reason === 'global_ipv6_present' ? 'bad' : gate && relay ? 'good' : 'pending'])
    const dns = state.diagnostics?.expiresAt > Date.now() ? state.diagnostics?.dns?.state : null
    rows.push(['Claude DNS', dns === 'configured' ? '配置已核对' : '待核对', dns === 'configured' ? 'good' : 'pending'])
    return rows
  }

  GN.guard = { reasons, singboxReasons, derive, checklist }
})()
