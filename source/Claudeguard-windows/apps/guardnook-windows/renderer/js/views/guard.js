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
    const chargeLimit = 960 // 8T 蓄满
    let charge
    let frame
    let reaction

    function resetGaze() {
      badge.removeAttribute('data-tracking')
      buddy.style.removeProperty('--gaze-x')
      buddy.style.removeProperty('--gaze-y')
    }

    // 节拍 T：所有互动时长都是它的整数倍（与 style.css 的 Clawd 动效系统一致）
    const T = 120
    const unit = () => buddy.getBoundingClientRect().width / 18 // 一个精灵像素的 CSS 宽度

    function clearCharge() {
      cancelAnimationFrame(frame)
      const input = charge?.input
      charge = null
      buddy.style.removeProperty('transform')
      delete badge.dataset.clawdCrouch
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

    // 停顿：不动 buddy，只占住互动通道 n 拍（蹲着落地、晕眩），结束后清理
    function hold(ticks, onFinish) {
      play([{ transform: 'none' }, { transform: 'none' }], ticks * T, onFinish)
    }

    // 起跳 / 落地扬尘：地面层上的两粒像素，3T
    let dustTimer
    function puff() {
      if (reducedMotion.matches) return
      clearTimeout(dustTimer)
      delete badge.dataset.clawdDust
      void badge.offsetWidth
      badge.dataset.clawdDust = ''
      dustTimer = setTimeout(() => delete badge.dataset.clawdDust, 3 * T)
    }

    // 整格弧线：按 T/2 采样抛物线，高度取整到精灵像素，逐帧（steps）播放
    function arc(height, ticks) {
      const u = unit(), steps = ticks * 2
      return Array.from({ length: steps + 1 }, (_, i) => {
        const p = i / steps
        return { transform: `translateY(${-Math.round(height * 4 * p * (1 - p)) * u}px)`, offset: p, easing: 'steps(1, end)' }
      })
    }

    function land(crouch, ticks, then) {
      badge.dataset.clawdCrouch = String(crouch)
      puff()
      hold(ticks, () => {
        delete badge.dataset.clawdCrouch
        if (then) then()
        else delete badge.dataset.clawdMotion
      })
    }

    function dizzy() {
      badge.dataset.clawdMotion = 'dizzy'
      hold(6)
    }

    // 普通跳：力度决定高度 2–5 格、时长 3–5T；落地蹲 1 格 1T。蓄满：7 格高、6T，重落地蹲 2 格 1T，再晕 6T
    function launch(force = 0, overcharged = false) {
      clearCharge()
      badge.dataset.clawdMotion = 'jumping'
      if (reducedMotion.matches) {
        play([{ opacity: 1 }, { opacity: .75 }, { opacity: 1 }], 160)
        return
      }
      puff()
      if (overcharged) play(arc(7, 6), 6 * T, () => land(2, 1, dizzy))
      else {
        const ticks = 3 + Math.round(force * 2)
        play(arc(2 + Math.round(force * 3), ticks), ticks * T, () => land(1, 1))
      }
    }

    // 蓄力：每 1/3 多蹲 1 格（腿缩短 → 趴地），最后 1/4 左右颤 1 格（每 T/2 换一次）
    function chargeFrame() {
      if (!charge) return
      const elapsed = performance.now() - charge.startedAt
      const force = Math.max(0, Math.min(1, elapsed / chargeLimit))
      if (!reducedMotion.matches) {
        const crouch = force < 1 / 3 ? 0 : force < 2 / 3 ? 1 : 2
        if (crouch) badge.dataset.clawdCrouch = String(crouch)
        const shake = force > .75 ? (Math.floor(elapsed / (T / 2)) % 2 ? 1 : -1) * charge.unit : 0
        buddy.style.transform = shake ? `translateX(${shake}px)` : ''
      }
      if (force === 1) launch(force, true)
      else frame = requestAnimationFrame(chargeFrame)
    }

    function startCharge(input) {
      if (charge || reaction) return false
      resetGaze()
      stopReact()
      charge = { input, startedAt: performance.now(), unit: unit() }
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
      badge.focus({ preventScroll: true, focusVisible: false })
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
      stopReact()
      syncBusy()
    })

    // ---- 状态反应：只读页面已有信号（徽章 data-tone、「连续确认」计数、检测按钮忙碌），不碰守护逻辑 ----
    // 写在 data-clawd-react（一次性，到时自动清除）和 data-clawd-busy（检测期间）上，与 data-clawd-motion 分开；
    // 用户蓄力 / 起跳时不开始反应，开始蓄力会立即打断反应。减少动态效果时只留一次透明度提示。
    const summary = $('guard-summary'), samples = $('samples')
    const REACT = { wake: 840, startle: 720, cheer: 840, nod: 360, wave: 720, yawn: 960 } // 7T 6T 7T 3T 6T 8T
    const RANK = { wake: 2, startle: 2, cheer: 2, nod: 1, wave: 0, yawn: 0 }
    const CUE = 360, IDLE = 45000, WAVE_GAP = 4000
    const BUSY = '#guard .check-action.is-busy, #env-refresh.is-busy'
    let tone = summary.dataset.tone, passes = count(), reactTimer, idleTimer, armedAt = 0, yawned = false, lastWave = -Infinity

    function stopReact() {
      clearTimeout(reactTimer)
      delete badge.dataset.clawdReact
    }

    function react(name) {
      if (charge || reaction || badge.dataset.clawdMotion) return
      if (reducedMotion.matches && RANK[name] === 0) return
      const current = badge.dataset.clawdReact
      if (current && RANK[current] > RANK[name]) return
      stopReact()
      void badge.offsetWidth // 同名反应也从第一帧重播
      badge.dataset.clawdReact = name
      reactTimer = setTimeout(stopReact, reducedMotion.matches ? CUE : REACT[name])
    }

    function count() {
      const match = /^(\d+)\/(\d+)$/.exec(samples.textContent.trim())
      return match ? [Number(match[1]), Number(match[2])] : null
    }

    new MutationObserver(() => {
      const next = summary.dataset.tone
      if (next === tone) return
      const prev = tone
      tone = next
      if (prev === 'bad' && (next === 'good' || next === 'warn')) react('wake')
      else if (prev === 'good' && next === 'bad') react('startle')
      else if (prev === 'warn' && next === 'good') react('cheer')
      else stopReact()
      armYawn(true)
    }).observe(summary, { attributes: true, attributeFilter: ['data-tone'] })

    new MutationObserver(() => {
      const prev = passes
      passes = count()
      if (tone === 'warn' && passes && passes[0] > (prev?.[0] ?? 0) && passes[0] < passes[1]) react('nod')
    }).observe(samples, { childList: true, characterData: true, subtree: true })

    function syncBusy() {
      badge.toggleAttribute('data-clawd-busy', !reducedMotion.matches && !!document.querySelector(BUSY))
    }
    const busyWatch = new MutationObserver(syncBusy)
    busyWatch.observe($('guard'), { subtree: true, attributes: true, attributeFilter: ['class'] })
    const envRefresh = $('env-refresh')
    if (envRefresh) busyWatch.observe(envRefresh, { attributes: true, attributeFilter: ['class'] })

    badge.addEventListener('pointerenter', event => {
      if (event.pointerType === 'touch' || tone === 'bad' || performance.now() - lastWave < WAVE_GAP) return
      lastWave = performance.now()
      react('wave')
    })

    // 空闲哈欠：放行状态、守护页可见、45 秒没有指针 / 键盘活动时打一次；有活动后才重新计时
    function armYawn(force) {
      const now = performance.now()
      if (!force && now - armedAt < 1000) return
      armedAt = now
      yawned = false
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (yawned || tone !== 'good' || document.hidden || store.tab !== 'guard' || badge.dataset.clawdReact) return
        yawned = true
        react('yawn')
      }, IDLE)
    }
    for (const type of ['pointermove', 'pointerdown', 'keydown']) window.addEventListener(type, () => armYawn(false), { passive: true })
    armYawn(true)

    // 未配置时的眨眼：间隔随机 3–6s，约四分之一连眨两下（data-clawd-blink = 1 / 2）
    function blink() {
      setTimeout(() => {
        if (tone === 'idle' && !reducedMotion.matches && !document.hidden && !charge && !reaction) {
          const times = Math.random() < .25 ? '2' : '1'
          delete badge.dataset.clawdBlink
          void badge.offsetWidth
          badge.dataset.clawdBlink = times
          setTimeout(() => { if (badge.dataset.clawdBlink === times) delete badge.dataset.clawdBlink }, times === '2' ? 360 : 120)
        }
        blink()
      }, 3000 + Math.random() * 3000)
    }
    blink()
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
