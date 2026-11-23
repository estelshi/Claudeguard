'use strict'
// 入口：路由、全局渲染、事件接线
;(() => {
  const GN = window.GN, { $, store } = GN
  const R = GN.render

  GN.go = (name, options = {}) => {
    store.tab = name
    document.querySelectorAll('.tab').forEach(el => { el.hidden = el.id !== name })
    document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el.dataset.tab === name || name === 'setup' && el.dataset.tab === 'guard'))
    document.querySelector('main').scrollTop = 0
    if (name === 'env') R.env.load()
    if (name === 'setup') {
      R.setup.fill()
      const model = GN.guard.derive(store.state, store.settings)
      R.setup.step(options.step || (model.primary.action === 'import' ? 3 : 1))
    }
    GN.renderState()
  }

  // 每秒一次：只渲染当前可见的页面，且只改变化了的内容（见 core.js 的 GN.text / GN.patch）
  GN.renderState = () => {
    const model = GN.guard.derive(store.state, store.settings)
    document.body.dataset.protection = store.state.indicator?.key || 'unconfigured'
    if (store.tab === 'guard') { R.guard.render(model); R.network.render() }
    if (store.tab === 'logs') R.logs.render()
    if (store.tab === 'setup' && store.wizardStep === 3) R.setup.checks()
  }

  async function init() {
    const boot = await GN.call('boot'); store.state = boot; store.settings = boot.settings
    $('login').checked = boot.login
    document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => GN.go(button.dataset.tab)))
    R.guard.bind(); R.network.bind(); R.setup.bind(); R.settings.bind(boot); R.env.bind()
    if (!store.settings) GN.go('setup', { step: 1 }); else GN.go('guard')
    window.guardnookEvents.onState(next => { store.state = { ...store.state, ...next }; GN.renderState() })
  }

  window.guardnookReady = init().catch(error => { GN.toast(error.message); throw error })
})()
