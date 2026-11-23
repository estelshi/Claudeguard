'use strict'
// 基础层：IPC 调用、DOM 工具、共享状态。各视图只通过 GN.* 访问这些能力。
window.GN = window.GN || {}
;(() => {
  const GN = window.GN
  GN.api = window.guardnook
  GN.$ = id => document.getElementById(id)
  GN.node = (tag, text, className) => {
    const el = document.createElement(tag)
    if (text !== undefined) el.textContent = text
    if (className) el.className = className
    return el
  }
  GN.icon = paths => `<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`

  // 单一共享状态
  GN.store = { state: null, settings: null, tab: 'guard', nodes: [], wizardStep: 1, detected: null }
  GN.render = {}

  // 每秒都会收到新状态。只在内容真的变了时改 DOM：
  // 文字相同不重写，列表签名相同不重建，正在操作的表单控件不被覆盖。
  GN.text = (id, value) => { const el = GN.$(id), text = String(value ?? ''); if (el.textContent !== text) el.textContent = text }
  GN.setValue = (el, value) => {
    if (document.activeElement === el) return
    if (el.type === 'checkbox') { if (el.checked !== !!value) el.checked = !!value }
    else if (el.value !== String(value ?? '')) el.value = String(value ?? '')
  }
  GN.patch = (container, signature, build) => {
    const key = JSON.stringify(signature)
    if (container.dataset.sig === key) return false
    container.dataset.sig = key
    container.replaceChildren(...build())
    return true
  }

  let toastTimer
  GN.toast = message => {
    const t = GN.$('toast')
    t.textContent = message; t.hidden = false
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true }, 6000)
  }
  GN.call = async (name, input) => {
    const result = await GN.api[name](input)
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  GN.busy = async (button, operation) => {
    button.disabled = true; button.classList.add('is-busy')
    try { return await operation() } catch (error) { GN.toast(error.message) }
    finally { button.disabled = false; button.classList.remove('is-busy') }
  }
  GN.on = (id, event, handler) => {
    GN.$(id).addEventListener(event, async e => { try { await handler(e) } catch (error) { GN.toast(error.message) } })
  }
  // 「刚刚 / 12 秒前」，用于检测时间
  GN.ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 5 ? '刚刚' : s < 60 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前` }
})()
