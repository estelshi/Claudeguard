'use strict'
// 首次绘制前设好外观，避免深色模式启动时先闪一下浅色。
// 主进程把保存的外观写在 URL hash 里（#theme=dark）；没有或无效时用浅色（默认）。
;(() => {
  const theme = /(?:^|[#&])theme=dark(?:&|$)/.test(location.hash) ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
})()
