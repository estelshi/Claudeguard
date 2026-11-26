'use strict'
// 设置：外观（浅色 / 深色）、UU 远程直连、开机自启。
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
    const uu = $('uu-remote')
    uu.checked = boot?.settings?.allowUURemote === true
    uu.disabled = !boot?.settings?.relay
    GN.on('uu-remote', 'change', async () => {
      const wanted = uu.checked
      uu.disabled = true
      try {
        const result = await GN.call('setUuRemote', wanted)
        uu.checked = result.allowUURemote === true
        if (result.settings) GN.store.settings = result.settings
        if (result.needsReapply) GN.toast('已保存。请重新保存节点配置并一键导入，修改才会生效。')
      } catch (error) { uu.checked = !wanted; throw error }
      finally { uu.disabled = !GN.store.settings?.relay }
    })
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
