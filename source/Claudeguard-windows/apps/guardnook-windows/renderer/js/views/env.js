'use strict'
// 环境：检查、修复（预览 → 确认 → 结果）、更改记录与恢复
;(() => {
  const GN = window.GN, { $, node, store } = GN
  const ICON = {
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    restore: '<path d="M4 12a8 8 0 1 0 2.34-5.66"/><path d="M4 4v5h5"/>',
    sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  }
  const icon = name => `<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`
  const STATE = { ok: '正常', fail: '需修复', warn: '建议调整', info: '仅供参考', unknown: '未知' }
  const RECORD = { applied: '已修改', partial: '部分修改', applying: '未完成', restoring: '恢复未完成', 'restore-partial': '部分恢复', restored: '已恢复' }
  const RECORD_TONE = { applied: 'ok', partial: 'warn', applying: 'warn', restoring: 'warn', 'restore-partial': 'warn', restored: 'info' }
  const env = store.env = store.env || { audit: null, history: [], loaded: false }
  const time = at => { const d = new Date(at); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

  function render() {
    const audit = env.audit, rows = $('env-rows')
    rows.replaceChildren()
    if (!audit) {
      rows.append(node('p', env.error || '正在读取 Windows 设置…', 'empty'))
      if (env.error) { $('env-verdict').textContent = '没有完成检查'; $('env-summary').dataset.tone = 'warn'; $('env-checked').textContent = '可以稍后点「重新检查」' }
      return
    }
    const blocking = audit.rows.filter(r => r.state === 'fail').length, warn = audit.rows.filter(r => r.state === 'warn').length
    $('env-verdict').textContent = blocking ? `${blocking} 项会阻止 Claude 放行` : warn ? `可以放行 · ${warn} 项建议调整` : '环境与目标一致'
    $('env-summary').dataset.tone = blocking ? 'bad' : warn ? 'warn' : 'good'
    $('env-checked').textContent = `${time(audit.checkedAt)} 检查 · ${audit.policy.template === 'strict' ? '严格模板：国家、时区、语言、IPv6 和 Fake-IP 都要求一致' : '通用模板：只把守护要求的项目当作放行条件'}`
    for (const button of document.querySelectorAll('[data-template]')) button.classList.toggle('active', button.dataset.template === audit.policy.template)
    for (const row of audit.rows) {
      const el = node('div', undefined, `env-row ${row.state}`)
      const name = node('div', undefined, 'env-name')
      name.append(node('strong', row.title), node('small', row.detail || ''))
      const badge = node('span', undefined, 'env-badges')
      if (row.blocking && ['fail', 'unknown'].includes(row.state)) badge.append(node('span', '放行条件', 'env-tag'))
      if (row.admin && row.fixable) badge.append(node('span', '需管理员', 'env-tag'))
      name.firstChild.append(badge)
      const status = node('span', undefined, 'env-status')
      status.append(node('span', STATE[row.state] || row.state, `env-state ${row.state}`))
      el.append(name, node('span', row.current, 'env-value'), node('span', row.expected, 'env-value expected'), status)
      rows.append(el)
    }
    const fixable = audit.repairKeys.length, manual = audit.rows.some(r => r.manual)
    $('env-repair').disabled = !fixable && !manual
    $('env-repair').querySelector('span').textContent = fixable ? `修复 ${fixable} 项…` : manual ? '查看手动项…' : '无需修复'
  }

  function renderHistory() {
    const list = $('env-history-list'); list.replaceChildren()
    if (!env.history.length) { list.append(node('p', '还没有更改记录。每次修复前都会自动保存一个恢复点。', 'empty')); return }
    env.history.forEach((item, index) => {
      const newer = env.history.slice(0, index).some(other => other.status !== 'restored')
      const row = node('div', undefined, 'env-record')
      const what = node('div', undefined, 'env-name')
      what.append(node('strong', item.detail), node('small', item.changes.map(c => `${item.changes.length > 1 ? c.title + ' ' : ''}${c.before} → ${c.after}`).join('；')))
      const status = node('span', undefined, 'env-status')
      status.append(node('span', RECORD[item.status] || item.status, `env-state ${RECORD_TONE[item.status] || 'info'}`))
      const button = node('button', undefined, 'pill-button small')
      button.type = 'button'
      button.insertAdjacentHTML('afterbegin', icon('restore')); button.append(node('span', '恢复'))
      button.disabled = item.status === 'restored' || newer
      button.title = item.status === 'restored' ? '已经恢复过' : newer ? '请先恢复更新的记录' : '恢复到这次修改之前'
      button.addEventListener('click', () => openRestore(item))
      row.append(node('time', time(item.at)), what, status, button)
      list.append(row)
    })
  }

  async function load(force = false) {
    if (env.loading) return env.loading
    if (env.loaded && !force) return
    env.loading = (async () => {
      try {
        const [audit, history] = await Promise.all([GN.call('envCheck'), GN.call('envHistory')])
        env.audit = audit; env.history = history.history; env.loaded = true; env.error = null
      } catch (error) { env.error = error.message }
      render(); renderHistory()
    })().finally(() => { env.loading = null })
    return env.loading
  }

  // ---------- 修复：预览 → 确认 → 结果 ----------
  const dialog = () => $('env-dialog')
  function setDialog({ title, lead, confirm, admin = '' }) {
    $('env-dialog-note').classList.remove('error')
    $('env-dialog-title').textContent = title
    $('env-dialog-lead').textContent = lead
    $('env-dialog-note').textContent = admin
    $('env-confirm').hidden = !confirm
    if (confirm) $('env-confirm').querySelector('span').textContent = confirm
    $('env-cancel').textContent = confirm ? '取消' : '完成'
  }
  function countSelected() {
    const n = document.querySelectorAll('#env-plan input:checked').length
    $('env-confirm').disabled = !n
    $('env-confirm').querySelector('span').textContent = n ? `确认修改 ${n} 项` : '请勾选要修改的项目'
    const admin = [...document.querySelectorAll('#env-plan input:checked')].some(box => box.dataset.admin === '1')
    $('env-dialog-note').textContent = admin ? '含 IPv6：Windows 会弹出管理员确认，点「否」则 IPv6 不改。' : ''
  }
  async function openRepair(button) {
    const preview = await GN.busy(button, () => GN.call('envRepairPreview'))
    if (!preview) return
    const plan = $('env-plan'); plan.replaceChildren()
    env.preview = preview
    for (const item of preview.plan) {
      const row = node('label', undefined, 'env-plan-row')
      const box = node('input'); box.type = 'checkbox'; box.checked = item.selected; box.value = item.key; box.dataset.admin = item.admin ? '1' : ''
      box.addEventListener('change', countSelected)
      const name = node('span', undefined, 'env-name')
      const strong = node('strong', item.title)
      if (item.blocking) strong.append(node('span', '放行条件', 'env-tag'))
      if (item.admin) strong.append(node('span', '需管理员', 'env-tag'))
      name.append(strong)
      const change = node('span', undefined, 'env-change')
      change.append(node('span', item.before, 'old'))
      change.insertAdjacentHTML('beforeend', icon('arrow'))
      change.append(node('span', item.after, 'new'))
      row.append(box, name, change)
      plan.append(row)
    }
    for (const item of preview.manual || []) {
      const row = node('div', undefined, 'env-plan-row manual')
      const name = node('span', undefined, 'env-name')
      name.append(node('strong', `${item.title} · 需手动`), node('small', item.detail))
      const open = node('button', '打开语言设置', 'pill-button small'); open.type = 'button'
      open.addEventListener('click', () => GN.call('envOpenSettings', 'language').catch(error => GN.toast(error.message)))
      row.append(node('span', '', 'env-plan-spacer'), name, open)
      plan.append(row)
    }
    setDialog({ title: '确认要修改的设置', lead: '默认只勾选阻止放行的项目。确认后会先保存恢复点，再逐项修改并重新读取核对；可在「更改记录与恢复」里撤销。', confirm: '确认修改' })
    env.mode = 'repair'
    if (preview.plan.length) countSelected(); else { $('env-confirm').hidden = true; $('env-cancel').textContent = '关闭' }
    dialog().showModal()
  }
  function openRestore(item) {
    const plan = $('env-plan'); plan.replaceChildren()
    for (const c of item.changes) {
      const row = node('div', undefined, 'env-plan-row')
      const name = node('span', undefined, 'env-name'); name.append(node('strong', c.title))
      const change = node('span', undefined, 'env-change')
      change.append(node('span', c.after, 'old')); change.insertAdjacentHTML('beforeend', icon('arrow')); change.append(node('span', c.before, 'new'))
      row.append(node('span', '', 'env-plan-spacer'), name, change); plan.append(row)
    }
    env.mode = 'restore'; env.restoreId = item.id
    setDialog({ title: '恢复这次修改之前的设置？', lead: `${time(item.at)} 的修改。若这些设置之后被其他程序改过，ClaudeGuard 会停下来，不覆盖。`, confirm: '恢复',
      admin: item.keys.some(k => k.startsWith('ipv6:')) ? '含 IPv6：Windows 会弹出管理员确认。' : '' })
    $('env-confirm').disabled = false
    dialog().showModal()
  }
  function showResult(result) {
    const plan = $('env-plan'); plan.replaceChildren()
    for (const line of result.outcomes || []) {
      const ok = /已修改并核对|已恢复原设置/.test(line)
      const row = node('div', undefined, 'env-plan-row result')
      row.append(node('span', undefined, `status-dot ${ok ? 'good' : 'bad'}`), node('span', line, 'env-outcome'))
      plan.append(row)
    }
    setDialog({ title: result.status === 'applied' ? '已修改' : result.status === 'restored' ? '已恢复' : '部分没有完成', lead: result.note })
    env.history = result.history || env.history; renderHistory()
  }
  async function confirm() {
    const button = $('env-confirm')
    // 弹窗打开时 toast 会被遮住，错误直接写在弹窗里
    let result
    button.disabled = true; button.classList.add('is-busy')
    try {
      result = await (env.mode === 'restore'
        ? GN.call('envRestore', env.restoreId)
        : GN.call('envRepairApply', { plan: env.preview.plan.map(p => p.key), keys: [...document.querySelectorAll('#env-plan input:checked')].map(box => box.value), planToken: env.preview.planToken }))
    } catch (error) { $('env-dialog-note').textContent = error.message; $('env-dialog-note').classList.add('error'); return }
    finally { button.disabled = false; button.classList.remove('is-busy') }
    showResult(result)
    load(true)
  }

  // ---------- 目标与模板 ----------
  const FIELDS = ['country', 'region', 'timezone', 'culture', 'language']
  async function saveBaseline(patch) {
    const current = env.audit?.policy || await GN.call('envBaseline')
    await GN.call('envBaseline', { ...current, ...patch })
    await load(true)
  }
  function openTarget() {
    const policy = env.audit?.policy
    if (!policy) return
    for (const key of FIELDS) $(`env-t-${key}`).value = policy[key]
    $('env-target-error').textContent = ''
    $('env-target-dialog').showModal()
  }

  function bind() {
    $('env-refresh').insertAdjacentHTML('afterbegin', icon('refresh'))
    $('env-repair').insertAdjacentHTML('afterbegin', icon('wrench'))
    $('env-target').insertAdjacentHTML('afterbegin', icon('sliders'))
    GN.on('env-refresh', 'click', () => GN.busy($('env-refresh'), () => load(true)))
    GN.on('env-repair', 'click', () => openRepair($('env-repair')))
    GN.on('env-confirm', 'click', confirm)
    GN.on('env-cancel', 'click', () => dialog().close())
    GN.on('env-target', 'click', openTarget)
    for (const button of document.querySelectorAll('[data-template]'))
      button.addEventListener('click', () => { if (!button.classList.contains('active')) GN.busy(button, () => saveBaseline({ template: button.dataset.template })) })
    GN.on('env-target-form', 'submit', async event => {
      event.preventDefault()
      const value = Object.fromEntries(FIELDS.map(key => { const v = $(`env-t-${key}`).value.trim(); return [key, ['country', 'region'].includes(key) ? v.toUpperCase() : v] }))
      $('env-target-error').textContent = ''
      const button = $('env-target-save'); button.disabled = true
      try { await saveBaseline(value); $('env-target-dialog').close() }
      catch (error) { $('env-target-error').textContent = error.message }
      finally { button.disabled = false }
    })
    GN.on('env-target-cancel', 'click', () => $('env-target-dialog').close())
  }

  GN.render.env = { load, render, bind }
})()
