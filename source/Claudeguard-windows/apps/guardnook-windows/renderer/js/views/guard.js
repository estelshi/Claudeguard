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
  const STEP_STATE = { done: '完成', active: '进行中', waiting: '待操作', error: '需处理', blocked: '待前置', paused: '已阻断', todo: '未开始' }
  const ROUTE_STATE = {
    verified: '守护路径和出口已验证', ordinary: '普通网络对照', 'needs-review': '未确认经过守护入口',
    mismatch: '出口与预期不一致', 'exit-unavailable': '未能读到出口 IP', unavailable: '请求失败或超时',
  }
  let helpAction

  function statusBadge(title, label, className, help) {
    if (!help) return node('span', label, className)
    const button = node('button', label, className + ' status-help')
    button.type = 'button'
    button.setAttribute('aria-haspopup', 'dialog')
    button.setAttribute('aria-label', `${title}：${label}，查看处理方法`)
    button.addEventListener('click', () => {
      helpAction = help.action
      GN.text('guard-help-title', `${title} · ${label}`)
      GN.text('guard-help-detail', help.detail)
      GN.text('guard-help-action', help.label)
      $('guard-help-action').hidden = !helpAction
      $('guard-help').showModal()
    })
    return button
  }

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

    GN.patch($('guard-steps'), [model.steps, model.help], () => model.steps.map(step => {
      const li = node('li', undefined, `step ${step.status}`)
      li.append(node('span', step.name, 'step-name'))
      const help = ['error', 'waiting', 'paused'].includes(step.status) ? model.help : null
      li.append(statusBadge(step.name, STEP_STATE[step.status], 'step-state', help))
      return li
    }))

    GN.text('expected-ip', settings?.relay?.confirmed === false ? '待确认' : settings?.expectedIP || '—')
    GN.text('observed-ip', s.last?.verifiedAt && Date.now() - s.last.verifiedAt < 45000 ? s.last.ip || '未知' : '未知')
    GN.text('samples', model.running ? `${s.successes || 0}/${s.recoverySamples || 3}` : '—')
    GN.text('connections', String(s.gateway?.connections || 0))
    for (const id of ['guard-enable', 'guard-inspect', 'guard-audit', 'guard-route']) {
      const button = $(id)
      if (!button.classList.contains('is-busy')) button.disabled = !model.running || (id === 'guard-enable' && model.conflict)
    }
    checklist(model)
  }

  function checklist(model) {
    const rows = GN.guard.checklist(store.state, store.settings, model)
    GN.patch($('connection-checks'), rows, () => rows.map(([title, detail, tone, help]) => {
      const li = node('li', undefined, `check ${tone}`)
      li.append(node('span', title, 'check-name'), statusBadge(title, detail, 'check-state', help))
      return li
    }))
  }

  function diagnostics(result, route = false) {
    const box = $('diagnostics')
    box.hidden = false
    box.replaceChildren(node('h2', route ? '客户端路径实测结果' : '规则覆盖检查结果'))
    if (route) {
      const rows = result.rows || []
      if (!rows.length) box.append(node('p', result.state === 'gate-closed'
        ? '守护网关尚未放行。等保护验证通过后，再实测客户端路径。' : '暂无客户端路径实测结果。'))
      for (const row of rows) box.append(node('p', `${row.host}：${ROUTE_STATE[row.state] || '尚未验证'}${row.ip ? ` · ${row.ip}` : ''}`))
    } else {
      box.append(node('p', `域名规则：${result.domains?.filter(row => row.coverage === 'covered').length || 0} 项有覆盖证据；其他项需检查。`),
        node('p', 'DNS / 浏览器泄漏：未实测，保持未知。'),
        node('p', `可见旁路连接：${result.observations?.rows?.length ?? '未知'}。没有发现异常不代表不存在旁路。`))
    }
    if (store.tab === 'guard') box.scrollIntoView({ block: 'nearest' })
  }

  // 主按钮：按状态分派
  async function runPrimary(button) {
    return runAction(button, GN.guard.derive(store.state, store.settings).primary.action)
  }

  async function runAction(button, action) {
    if (!action) return
    if (action === 'env') return GN.go('env')
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

  function bindClawd() {
    const badge = $('clawd')
    const buddy = badge.querySelector('.pixel-buddy')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const chargeLimit = 900
    let charge
    let frame
    let reaction

    function resetGaze() {
      badge.removeAttribute('data-tracking')
      buddy.style.removeProperty('--gaze-x')
      buddy.style.removeProperty('--gaze-y')
    }

    function clearCharge() {
      cancelAnimationFrame(frame)
      const input = charge?.input
      charge = null
      buddy.style.removeProperty('transform')
      if (typeof input === 'number' && badge.hasPointerCapture(input)) badge.releasePointerCapture(input)
    }

    function cancelReaction() {
      clearCharge()
      reaction?.cancel()
      reaction = null
      delete badge.dataset.clawdMotion
    }

    function play(frames, duration, onFinish) {
      const animation = buddy.animate(frames, duration)
      reaction = animation
      animation.onfinish = () => {
        if (reaction !== animation) return
        reaction = null
        if (onFinish) onFinish()
        else delete badge.dataset.clawdMotion
      }
    }

    function landDizzy() {
      badge.dataset.clawdMotion = 'dizzy'
      play([
        { transform: 'rotate(-12deg) scaleY(.76)', easing: 'ease-out' },
        { transform: 'rotate(9deg) scaleY(.9)', offset: .2, easing: 'ease-in-out' },
        { transform: 'rotate(-6deg) scaleY(.92)', offset: .43, easing: 'ease-out' },
        { transform: 'rotate(-6deg) scaleY(.92)', offset: .76, easing: 'ease-out' },
        { transform: 'none' },
      ], 520)
    }

    function launch(force = 0, overcharged = false) {
      const takeoff = buddy.style.transform || 'none'
      clearCharge()
      badge.dataset.clawdMotion = 'jumping'
      if (reducedMotion.matches) {
        play([{ opacity: 1 }, { opacity: .75 }, { opacity: 1 }], 160)
        return
      }
      const peak = overcharged ? 'translate(9px,-64px) rotate(32deg)' : `translateY(-${8 + force * 28}px)`
      play([
        { transform: takeoff, easing: 'cubic-bezier(.23,1,.32,1)' },
        { transform: peak, offset: .44, easing: 'cubic-bezier(.55,.02,.86,.5)' },
        { transform: overcharged ? 'rotate(-12deg) scaleY(.76)' : 'none' },
      ], overcharged ? 570 : 240 + force * 150, overcharged ? landDizzy : undefined)
    }

    function chargeFrame(now) {
      if (!charge) return
      const elapsed = now - charge.startedAt
      const force = Math.max(0, Math.min(1, elapsed / chargeLimit))
      if (!reducedMotion.matches) {
        const shake = Math.sin(elapsed * (.048 + force * .025)) * force ** 2 * 2.2
        buddy.style.transform = `translateX(${shake}px) scaleY(${1 - force * .28})`
      }
      if (force === 1) launch(force, true)
      else frame = requestAnimationFrame(chargeFrame)
    }

    function startCharge(input) {
      if (charge || reaction) return false
      resetGaze()
      charge = { input, startedAt: performance.now() }
      badge.dataset.clawdMotion = 'charging'
      frame = requestAnimationFrame(chargeFrame)
      return true
    }

    function releaseCharge(input) {
      if (charge?.input !== input) return
      const force = Math.min(1, (performance.now() - charge.startedAt) / chargeLimit)
      launch(force, force === 1)
    }

    badge.addEventListener('pointermove', event => {
      if (charge || reaction || event.pointerType === 'touch' || reducedMotion.matches) return
      const bounds = badge.getBoundingClientRect()
      const facing = position => Math.max(-1, Math.min(1, position * 2 - 1))
      buddy.style.setProperty('--gaze-x', `${facing((event.clientX - bounds.left) / bounds.width)}px`)
      buddy.style.setProperty('--gaze-y', `${facing((event.clientY - bounds.top) / bounds.height) * 0.7}px`)
      badge.setAttribute('data-tracking', '')
    })
    badge.addEventListener('pointerleave', resetGaze)
    badge.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0 || !startCharge(event.pointerId)) return
      event.preventDefault()
      badge.focus({ preventScroll: true })
      badge.setPointerCapture(event.pointerId)
    })
    badge.addEventListener('pointerup', event => releaseCharge(event.pointerId))
    for (const event of ['pointercancel', 'lostpointercapture']) {
      badge.addEventListener(event, e => {
        if (charge?.input === e.pointerId) cancelReaction()
      })
    }
    badge.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      if (!event.repeat) startCharge(event.key)
    })
    badge.addEventListener('keyup', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      releaseCharge(event.key)
    })
    badge.addEventListener('click', event => {
      if (event.detail === 0 && !charge && !reaction) launch()
    })
    badge.addEventListener('blur', () => {
      if (charge) cancelReaction()
    })
    window.addEventListener('blur', cancelReaction)
    reducedMotion.addEventListener('change', () => {
      resetGaze()
      cancelReaction()
    })
  }

  function bind() {
    bindClawd()
    GN.on('guard-primary', 'click', () => runPrimary($('guard-primary')))
    GN.on('guard-help-close', 'click', () => $('guard-help').close())
    GN.on('guard-help-action', 'click', () => {
      $('guard-help').close()
      return runAction($(helpAction === 'inspect' ? 'guard-inspect' : 'guard-primary'), helpAction)
    })
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
