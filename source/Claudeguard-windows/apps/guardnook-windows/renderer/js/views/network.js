'use strict'
// 专线检测：Claude 守护通道 + 系统网络三项实测，渐变卡片
;(() => {
  const GN = window.GN, { $, node, store } = GN
  const CARDS = [['claude', 'Claude 守护通道', 'tile-teal'], ['codex', 'Codex', 'tile-violet'], ['ipv4', 'IPv4', 'tile-sunset'], ['cloudflare', 'Cloudflare', 'tile-blue']]

  function view(key) {
    const waiting = key === 'claude' && store.state.indicator?.key !== 'protected'
    const p = store.state.probes?.[key], fresh = !waiting && p && Date.now() - p.at < 120000
    if (waiting) return { label: '未放行', ip: '—', detail: '守护放行后可检测', dot: '' }
    if (!p) return { label: '未检测', ip: '—', detail: '点「重新检测」开始', dot: '' }
    if (!fresh) return { label: '已过期', ip: '—', detail: '结果已过期，请重新检测', dot: '' }
    return p.ok ? { label: '可达', ip: p.ip, detail: [p.location, p.source].filter(Boolean).join(' · '), dot: 'good' }
      : { label: '失败', ip: '检测失败', detail: p.reason || '连接失败或超时', dot: 'bad' }
  }

  // 守护页打开时自动测一次；结果 2 分钟过期后再测，不和手动「重新检测」并发
  let lastAuto = 0
  async function refresh() {
    const button = $('probe-refresh')
    if (button.disabled) return
    lastAuto = Date.now()
    GN.setBusy(button, true)
    try {
      store.state.probes = await GN.call('probes')
      render()
    } finally { GN.setBusy(button, false) }
  }
  function autoProbe() {
    if (Date.now() - lastAuto >= 120000) refresh().catch(() => {})
  }

  function render() {
    autoProbe()
    const views = CARDS.map(([key]) => view(key))
    GN.patch($('network-cards'), views, () => CARDS.map(([, name, tone], i) => {
      const v = views[i], card = node('article', undefined, `tile network-card ${tone}`)
      const heading = node('div', undefined, 'tile-heading'), label = node('div')
      label.append(node('h2', name), node('span', v.label))
      heading.append(label, node('span', undefined, `status-dot on-tile ${v.dot}`))
      card.append(heading, node('p', v.ip, 'network-ip'), node('p', v.detail, 'network-detail'))
      return card
    }))
  }

  function bind() {
    GN.on('probe-refresh', 'click', refresh)
  }

  GN.render.network = { render, bind }
})()
