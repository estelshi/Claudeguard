'use strict'
// 日志：Clash 内核当前可见的 Claude 连接
;(() => {
  const GN = window.GN, { $, node, store } = GN

  function render() {
    const log = store.state.status?.connectionLog
    const fresh = log?.available === true && Date.now() - log.checkedAt < 5000
    GN.text('log-state', fresh ? (store.settings?.backendKind === 'singbox' ? '来自 sing-box 内核 · 当前可见连接' : '来自 Clash 内核 · 当前可见连接') : store.settings ? '记录不可用或已过期' : '配置并启动守护后显示')
    const rows = (log?.events || []).slice(0, 25)
    const signature = rows.map(item => [item.at, item.host, item.process])
    GN.patch($('connection-list'), signature, () => {
      if (!rows.length) return [node('p', '暂无 Claude 连接记录。', 'empty')]
      return rows.map(item => {
        const row = node('div', undefined, 'log-row')
        row.title = [item.host, item.process, item.processPath, item.sourceIP, item.sourcePort].filter(Boolean).join('\n')
        row.append(node('time', new Date(item.at).toLocaleTimeString('zh-CN', { hour12: false })), node('span', item.host || '未提供主机名'), node('span', item.process || '进程未知', 'muted'))
        return row
      })
    })
  }

  GN.render.logs = { render }
})()
