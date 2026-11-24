'use strict'
// 纯视觉动效：不调用 IPC、不改文字、不改状态，只加 / 去样式类和 CSS 变量。
// 1) 分段控件 / 导航胶囊 / 步骤条：量出当前项位置，写进 --thumb-*，滑块在选项之间平移。
// 2) 守护标题、说明、徽章：状态变化时交叉淡入（gn-swap）。
// 3) 关键数字：值变化时轻轻落定（gn-settle）。
// prefers-reduced-motion 时 CSS 不播放动画、过渡时长为 0，这里的逻辑照常运行也不会产生动效。
;(() => {
  const GROUPS = '.pills, .seg-mini, .stepper'

  function place(group, still) {
    const active = group.querySelector(':scope > .active')
    if (!active || !group.offsetParent || !active.offsetWidth) { group.classList.remove('has-thumb'); return }
    if (still || !group.classList.contains('has-thumb')) group.classList.add('thumb-still')
    const set = (k, v) => group.style.setProperty(k, `${v}px`)
    set('--thumb-x', active.offsetLeft); set('--thumb-y', active.offsetTop)
    set('--thumb-w', active.offsetWidth); set('--thumb-h', active.offsetHeight)
    group.classList.add('has-thumb')
    if (group.classList.contains('thumb-still')) requestAnimationFrame(() => requestAnimationFrame(() => group.classList.remove('thumb-still')))
  }

  function restart(el, cls) {
    el.classList.remove(cls)
    void el.offsetWidth
    el.classList.add(cls)
  }

  function init() {
    const groups = [...document.querySelectorAll(GROUPS)]
    const resize = new ResizeObserver(entries => entries.forEach(e => place(e.target, true)))
    const moved = new MutationObserver(records => {
      // 只看选项自身的 class 变化；容器上的 has-thumb / thumb-still 是这里加的，忽略以免循环
      const touched = new Set(records.filter(r => !r.target.matches(GROUPS)).map(r => r.target.closest(GROUPS)).filter(Boolean))
      touched.forEach(group => place(group, false))
    })
    for (const group of groups) {
      resize.observe(group)
      moved.observe(group, { subtree: true, attributes: true, attributeFilter: ['class'] })
      place(group, true)
    }
    document.fonts?.ready.then(() => groups.forEach(g => place(g, true)))

    const watchText = (ids, cls, also) => {
      const observer = new MutationObserver(records => {
        const els = new Set(records.map(r => (r.target.nodeType === 1 ? r.target : r.target.parentElement)?.closest(ids.map(i => '#' + i).join(','))).filter(Boolean))
        els.forEach(el => { restart(el, cls); also?.(el) })
      })
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el) observer.observe(el, { childList: true, characterData: true, subtree: true })
      }
    }
    watchText(['guard-title', 'guard-reason'], 'gn-swap')
    watchText(['expected-ip', 'observed-ip', 'samples', 'connections'], 'gn-settle')

    const summary = document.getElementById('guard-summary'), badge = document.getElementById('clawd')
    if (summary && badge) new MutationObserver(() => { if (!badge.hasAttribute('data-clawd-motion')) restart(badge, 'gn-swap') })
      .observe(summary, { attributes: true, attributeFilter: ['data-tone'] })
    for (const el of document.querySelectorAll('#guard-title, #guard-reason, #clawd, .kpi strong'))
      el.addEventListener('animationend', e => { if (e.target === el) el.classList.remove('gn-swap', 'gn-settle') })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
