'use strict'
// Claude 守护：状态标题 + Clawd 徽章、主操作、保护进度、关键数字、连接检查、诊断
;(() => {
  const GN = window.GN, { $, node, store } = GN

  const ICONS = {
    setup: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    'setup-exit': '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    inspect: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
    import: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    enable: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    'confirm-relay': '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>',
    wait: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  }
  const STEP_STATE = { done: '完成', active: '进行中', error: '需处理', todo: '' }

  function render(model) {
    const s = store.state.status || {}, settings = store.settings
    const summary = $('guard-summary')
    if (summary.dataset.tone !== model.tone) summary.dataset.tone = model.tone
    GN.text('guard-title', model.title)
    // v2rayN（sing-box 内核）时，页面里的「Clash」换成对应的客户端 / 内核名
    document.querySelectorAll('.client-name').forEach(el => { const t = model.singbox ? 'v2rayN' : 'Clash'; if (el.textContent !== t) el.textContent = t })
    document.querySelectorAll('.client-core').forEach(el => { const t = model.singbox ? 'sing-box' : 'Clash'; if (el.textContent !== t) el.textContent = t })
    GN.text('guard-reason', model.reason)

    const primary = $('guard-primary'), action = model.primary.action || 'wait'
    if (primary.dataset.sig !== action + model.primary.label) {
      primary.dataset.sig = action + model.primary.label
      primary.innerHTML = GN.icon(ICONS[action] || ICONS.inspect)
      primary.append(node('span', model.primary.label))
    }
    if (!primary.classList.contains('is-busy')) primary.disabled = !model.primary.action
    primary.classList.toggle('quiet', model.good)
    $('guard-block').hidden = !model.canBlock

    GN.patch($('guard-steps'), model.steps, () => model.steps.map(step => {
      const li = node('li', undefined, `step ${step.status}`)
      li.append(node('span', step.name, 'step-name'))
      if (STEP_STATE[step.status]) li.append(node('span', STEP_STATE[step.status], 'step-state'))
      return li
    }))

    GN.text('expected-ip', settings?.relay?.confirmed === false ? '待确认' : settings?.expectedIP || '—')
    GN.text('observed-ip', s.last?.verifiedAt && Date.now() - s.last.verifiedAt < 45000 ? s.last.ip || '未知' : '未知')
    GN.text('samples', model.running ? `${s.successes || 0}/${s.recoverySamples || 3}` : '—')
    GN.text('connections', String(s.gateway?.connections || 0))
    for (const id of ['guard-enable', 'guard-inspect', 'guard-audit', 'guard-route']) {
      const button = $(id)
      if (!button.classList.contains('is-busy')) button.disabled = !model.running
    }
    checklist()
  }

  function checklist() {
    const rows = GN.guard.checklist(store.state, store.settings)
    GN.patch($('connection-checks'), rows, () => rows.map(([title, detail, tone]) => {
      const li = node('li', undefined, `check ${tone}`)
      li.append(node('span', title, 'check-name'), node('span', detail, 'check-state'))
      return li
    }))
  }

  function diagnostics(result, route = false) {
    const box = $('diagnostics'); box.replaceChildren(); box.hidden = false
    if (route) {
      const rows = result.rows || []
      if (!rows.length) box.append(node('p', '没有可实测的客户端路径。'))
      for (const row of rows) box.append(node('p', `${row.host}：${row.state === 'verified' ? '客户端路径已验证' : '尚未验证 / 不符合'}${row.ip ? ` · ${row.ip}` : ''}`))
    } else {
      box.append(node('p', `域名规则：${result.domains?.filter(row => row.coverage === 'covered').length || 0} 项有覆盖证据；其他项需检查。`),
        node('p', 'DNS / 浏览器泄漏：未实测，保持未知。'),
        node('p', `可见旁路连接：${result.observations?.rows?.length ?? '未知'}。没有发现异常不代表不存在旁路。`))
    }
  }

  // 主按钮：按状态分派
  async function runPrimary(button) {
    const model = GN.guard.derive(store.state, store.settings), action = model.primary.action
    if (!action) return
    if (action === 'setup') return GN.go('setup', { step: 1 })
    if (action === 'setup-exit') return GN.go('setup', { step: 2 })
    if (action === 'import') return GN.go('setup', { step: 3 })
    if (action === 'confirm-relay') return GN.busy(button, async () => {
      store.settings = await GN.call('confirmRelay')
      GN.toast('已确认固定出口，正在连续验证。')
      GN.renderState()
    })
    await GN.busy(button, () => GN.call('guard', action))
  }

  function bind() {
    GN.on('guard-primary', 'click', () => runPrimary($('guard-primary')))
    GN.on('guard-block', 'click', () => GN.busy($('guard-block'), async () => { await GN.call('guard', 'block'); GN.toast('已阻断 Claude。点「启用保护」后重新验证。') }))
    GN.on('configure', 'click', () => GN.go('setup', { step: 1 }))
    for (const [id, action] of [['guard-enable', 'enable'], ['guard-inspect', 'inspect'], ['guard-audit', 'audit'], ['guard-route', 'route-check']]) {
      GN.on(id, 'click', () => GN.busy($(id), async () => {
        const result = await GN.call('guard', action)
        if (action === 'audit' || action === 'route-check') diagnostics(result, action === 'route-check')
      }))
    }
    GN.on('checklist-refresh', 'click', () => GN.busy($('checklist-refresh'), async () => {
      if (store.settings && store.state.status?.state !== 'unconfigured') { await GN.call('guard', 'inspect'); await GN.call('guard', 'audit') }
      store.state.probes = await GN.call('probes')
      GN.renderState()
    }))
  }

  GN.render.guard = { render, bind, runPrimary }
})()
