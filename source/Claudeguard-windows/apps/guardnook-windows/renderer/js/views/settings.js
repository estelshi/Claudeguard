'use strict'
// 设置：外观（浅色 / 深色）、开机自启。
;(() => {
  const GN = window.GN, { $ } = GN

  // 只切换 <html data-theme>；颜色全部由 style.css 的深色变量覆盖
  function apply(theme) {
    document.documentElement.dataset.theme = theme
    document.querySelectorAll('#theme-choice [data-theme-value]').forEach(button => {
      const on = button.dataset.themeValue === theme
      button.classList.toggle('active', on)
      button.setAttribute('aria-checked', String(on))
    })
  }

  function bind(boot) {
    apply(boot?.theme === 'dark' ? 'dark' : 'light')
    document.querySelectorAll('#theme-choice [data-theme-value]').forEach(button => button.addEventListener('click', async () => {
      const wanted = button.dataset.themeValue, before = document.documentElement.dataset.theme
      if (wanted === before) return
      apply(wanted) // 先在界面上切换，保存失败再退回
      try { apply(await GN.call('setTheme', wanted)) }
      catch (error) { apply(before); GN.toast(error.message) }
    }))
    GN.on('login', 'change', async () => {
      const box = $('login'), wanted = box.checked
      box.disabled = true
      try { box.checked = await GN.call('login', wanted) }
      catch (error) { box.checked = !wanted; throw error }
      finally { box.disabled = false }
    })
  }

  GN.render.settings = { bind, apply }
})()
