'use strict'
// 配置三步：1 识别 Clash → 2 选入口节点（可多选）并填固定出口 → 3 生成脚本并导入（实时验收）
// 第 1 步可改选 v2rayN（sing-box 内核）：1 识别 v2rayN → 2 固定出口节点 → 3 生成规则并导入
;(() => {
  const GN = window.GN, { $, node, store } = GN

  const mode = () => kind() === 'singbox' ? 'existing' : document.querySelector('input[name="exit-mode"]:checked').value
  const kind = () => document.querySelector('input[name="client-kind"]:checked')?.value || 'mihomo'
  const sb = () => kind() === 'singbox'
  let entryBy = 'nodes'
  let secretHelpPinned = false
  let detectionRequest = 0
  let maxRelayEntries = Infinity

  function showSecretTip(open) {
    const tip = $('secret-help-tip'), trigger = $('secret-help-trigger')
    if (open && tip.hidden) {
      const bounds = trigger.getBoundingClientRect()
      const viewport = document.querySelector('main').getBoundingClientRect()
      tip.dataset.placement = bounds.top - viewport.top > viewport.bottom - bounds.bottom ? 'above' : 'below'
    }
    tip.hidden = !open
    trigger.setAttribute('aria-expanded', String(open))
    if (!open) secretHelpPinned = false
  }

  function bindSecretHelp() {
    const help = $('secret-help'), trigger = $('secret-help-trigger')
    help.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'touch') showSecretTip(true)
    })
    help.addEventListener('pointerleave', () => {
      if (!secretHelpPinned && !trigger.matches(':focus-visible')) showSecretTip(false)
    })
    trigger.addEventListener('focus', () => {
      if (trigger.matches(':focus-visible')) showSecretTip(true)
    })
    trigger.addEventListener('blur', () => showSecretTip(false))
    trigger.addEventListener('click', () => {
      secretHelpPinned = !secretHelpPinned
      showSecretTip(secretHelpPinned)
    })
    document.addEventListener('pointerdown', event => {
      if (!help.contains(event.target)) showSecretTip(false)
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('secret-help-tip').hidden) showSecretTip(false)
    })
  }

  // ---------- 客户端：Clash Verge / Mihomo 或 v2rayN（sing-box 内核） ----------
  const KIND_COPY = {
    mihomo: { stepper: ['识别 Clash', '入口与固定出口', '生成脚本并导入'], step1: '识别本机 Clash',
      lead: 'ClaudeGuard 只读取 Clash 的节点列表，不会改动你的订阅、全局节点或 Clash 设置。',
      controller: 'Clash 控制接口', controllerHint: 'Clash 设置里的 external-controller，不是代理端口。', idle: '读取 Clash Verge 的配置，并探测 127.0.0.1:9097 和 9090。',
      count: '先启动 Clash Verge / Mihomo', save: '保存并生成脚本', advanced: '高级：端口与原始扩展脚本', step3: '把生成的脚本导入 Clash',
      tun: '要求 Clash 开启 TUN 才放行', result: '可以一键导入独立订阅，也可以按以上步骤手动导入。', placeholder: 'http://127.0.0.1:9097' },
    singbox: { stepper: ['识别 v2rayN', '固定出口节点', '生成规则并导入'], step1: '识别本机 v2rayN',
      lead: 'ClaudeGuard 只读取 v2rayN 生成的 sing-box 配置和控制接口，不会改动 v2rayN 的节点、路由或设置。',
      controller: 'sing-box 控制接口', controllerHint: 'sing-box 的 clash_api 地址，不是代理端口；v2rayN 开启 TUN 时会改用下一个端口。', idle: '读取 v2rayN 生成的 sing-box 配置，并探测 127.0.0.1:10813 和 10814。',
      count: '先启动 v2rayN，内核选 sing-box', save: '保存并生成规则', advanced: '高级：端口', step3: '把规则导入 v2rayN',
      tun: '要求 v2rayN 开启 TUN 才放行', result: 'ClaudeGuard 不会改写或重启 v2rayN，节点和规则由你在 v2rayN 里添加。', placeholder: 'http://127.0.0.1:10813' },
  }
  function syncKind() {
    const copy = KIND_COPY[kind()]
    copy.stepper.forEach((text, i) => GN.text(`stepper-${i + 1}`, text))
    for (const [id, key] of [['step1-title', 'step1'], ['step1-lead', 'lead'], ['controller-label', 'controller'], ['controller-hint', 'controllerHint'],
      ['save-setup-label', 'save'], ['advanced-title', 'advanced'], ['step3-title', 'step3'], ['tun-title', 'tun'], ['setup-result', 'result']]) GN.text(id, copy[key])
    document.querySelectorAll('.clash-only').forEach(el => { el.hidden = sb() })
    $('setup-form').dataset.kind = kind()
    $('howto-clash').hidden = sb(); $('howto-singbox').hidden = !sb()
    $('verge-import').hidden = sb()
    $('secret-help-clash').hidden = sb(); $('secret-help-singbox').hidden = !sb()
    syncExitMode()
  }
  function setKind(value) {
    const radio = document.querySelector(`input[name="client-kind"][value="${value}"]`)
    if (radio) radio.checked = true
    syncKind()
  }
  function resetDetection() {
    store.detected = null
    const copy = KIND_COPY[kind()]
    $('detect-box').dataset.status = 'idle'
    GN.text('detect-title', '还没有识别'); GN.text('detect-detail', copy.idle); GN.text('node-count', copy.count)
    GN.text('secret-hint', '未设置密钥可留空。')
    $('controller-url').value = copy.placeholder
  }

  // ---------- 步骤切换 ----------
  function step(n) {
    if (n === 3 && !store.settings) n = 2
    store.wizardStep = n
    showSecretTip(false)
    document.querySelectorAll('.wizard-step').forEach(el => { el.hidden = Number(el.dataset.step) !== n })
    document.querySelectorAll('#stepper li').forEach(li => {
      const at = Number(li.dataset.step)
      li.classList.toggle('active', at === n); li.classList.toggle('done', at < n)
    })
    document.querySelector('main').scrollTop = 0
    if (n === 1 && !store.detected) detect()
    if (n === 3) { howto(); checks() }
  }

  // ---------- 第 1 步：自动识别 ----------
  const DETECT_COPY = {
    found: r => ['已找到本机 Clash', `${r.source === 'verge' ? '已从 Clash Verge 读取控制接口' : '在默认端口找到控制接口'}${r.hasSecret ? '和密钥' : ''} · ${r.controllerURL}${r.version ? ' · Mihomo ' + r.version : ''}`],
    'needs-secret': r => ['找到控制接口，但需要密钥', `${r.controllerURL} 拒绝了访问。请在下面填写 Clash 设置里的接口密钥。`],
    disabled: () => ['Clash Verge 没有开启外部控制器', '打开 Clash Verge → 设置 → Clash 设置 → 外部控制器，开启后再点「自动识别」。'],
    'not-found': () => ['没有找到正在运行的 Clash', '先启动 Clash Verge / Mihomo 再点「自动识别」；用其他客户端可以直接填写下面的地址。'],
  }
  const DETECT_V2RAYN = {
    found: r => ['已找到本机 v2rayN（sing-box 内核）', `${r.source === 'v2rayn-config' ? '已从 v2rayN 生成的配置读取控制接口' : '在默认端口找到控制接口'} · ${r.controllerURL}${r.version ? ' · ' + r.version : ''}${r.tun === true ? ' · TUN 已开启' : r.tun === false ? ' · TUN 未开启' : ''}`],
    'needs-secret': r => ['找到控制接口，但需要密钥', `${r.controllerURL} 拒绝了访问。请在下面填写 sing-box 配置里 clash_api 的 secret。`],
    xray: () => ['v2rayN 正在使用 Xray 内核', '目前只支持 sing-box 内核。在 v2rayN 把内核切换为 sing-box，再点「自动识别」。'],
    'wrong-kind': r => ['这里运行的是 Clash / Mihomo', `${r.controllerURL} 不是 sing-box。请在上面选「Clash Verge / Mihomo」，或启动 v2rayN 后重新识别。`],
    'not-found': () => ['没有找到正在运行的 v2rayN（sing-box）', '先启动 v2rayN 并把内核选为 sing-box；也可以手动填写下面的控制接口。'],
  }
  async function detect() {
    const box = $('detect-box'), button = $('detect-clash'), singbox = sb(), copy = KIND_COPY[kind()]
    const request = ++detectionRequest
    box.dataset.status = 'checking'
    GN.text('detect-title', singbox ? '正在识别本机 v2rayN…' : '正在识别本机 Clash…'); GN.text('detect-detail', copy.idle)
    GN.setBusy(button, true)
    try {
      const result = await GN.call(singbox ? 'detectV2rayn' : 'detectClash')
      if (request !== detectionRequest) return // 识别途中换了客户端
      store.detected = { ...result, kind: kind() }
      box.dataset.status = ['xray', 'wrong-kind'].includes(result.status) ? 'disabled' : result.status
      const table = singbox ? DETECT_V2RAYN : DETECT_COPY
      const [title, detail] = (table[result.status] || table['not-found'])(result)
      GN.text('detect-title', title); GN.text('detect-detail', detail)
      if (result.controllerURL) GN.setValue($('controller-url'), result.controllerURL)
      if (result.hasSecret) GN.text('secret-hint', singbox ? '已从 v2rayN 的配置读取密钥，留空即可；填写可替换。' : '已从 Clash Verge 读取密钥，留空即可；填写可替换。')
      if (singbox) {
        if (result.localPort) GN.setValue($('sb-local-port'), result.localPort)
        if (result.secondPort || result.localPort) GN.setValue($('sb-second-port'), result.secondPort || result.localPort + 1)
        secondPortHint()
      }
      if (result.status === 'found') GN.text('node-count', '已识别，可以读取节点')
    } catch (error) {
      if (request !== detectionRequest) return
      box.dataset.status = 'not-found'
      GN.text('detect-title', '识别没有完成'); GN.text('detect-detail', error.message)
    } finally {
      if (request === detectionRequest) GN.setBusy(button, false)
    }
  }

  // ---------- 第 2 步 ----------
  function syncExitMode() {
    const singbox = sb(), relay = mode() === 'relay'
    $('exit-mode-choice').hidden = singbox
    $('singbox-fields').hidden = !singbox
    $('relay-fields').hidden = !relay
    $('existing-fields').hidden = relay || singbox
    $('device-wide-row').hidden = !relay
    $('start-protected-row').hidden = relay
    const tun = $('require-tun')
    tun.disabled = relay
    if (relay) tun.checked = true
    GN.text('step2-title', singbox ? '填写 Claude 的固定出口节点' : relay ? '选择入口节点并填写固定出口' : '选择 Claude 的固定出口节点')
    GN.text('tun-hint', singbox ? '推荐。TUN 状态读自 v2rayN 生成的 sing-box 配置，读不到时保持阻断。' : relay ? 'SOCKS5 中转始终要求 TUN，关闭时保持阻断。' : '推荐。TUN 关闭时保持阻断。')
  }
  function secondPortHint() {
    const port = Number($('sb-second-port').value) || 10809
    const off = store.detected?.kind === 'singbox' && store.detected.status === 'found' && store.detected.secondPortEnabled === false
    GN.text('sb-second-hint', off ? `v2rayN 还没开第二个本地端口。请在参数设置里开启，通常为本地端口 + 1。` : '需在 v2rayN 开启第二个本地端口，通常为本地端口 + 1。守护网关经它连到固定出口。')
    GN.text('sb-second-step', `v2rayN 参数设置里开启第二个本地监听端口，端口为 ${port}（本地端口 + 1）。`)
  }
  function setMode(value) {
    document.querySelector(`input[name="exit-mode"][value="${value}"]`).checked = true
    syncExitMode()
  }
  function setEntryBy(value) {
    entryBy = value
    document.querySelectorAll('[data-entry]').forEach(b => b.classList.toggle('active', b.dataset.entry === value))
    $('relay-node-picker').hidden = value !== 'nodes'
    $('relay-keyword').hidden = value !== 'keyword'
    entryCount()
  }
  const entryOptions = () => [...$('relay-node-list').querySelectorAll('input[type=checkbox]')]
  const selectedEntries = () => entryOptions().filter(box => box.checked).map(box => box.value)
  function renderEntryNodes(chosen) {
    const list = $('relay-node-list'), usable = store.nodes.filter(n => n.relayEligible)
    const selected = new Set(chosen)
    list.replaceChildren()
    if (!usable.length) list.append(node('p', store.nodes.length ? '没有可做入口的具体节点。' : '请先在第 1 步读取节点。', 'empty'))
    for (const n of usable) {
      const row = node('label', undefined, 'node-option'), box = node('input')
      box.type = 'checkbox'; box.value = n.name; box.checked = selected.has(n.name)
      box.addEventListener('change', entryCount)
      row.append(box, node('span', n.name, 'node-name'), node('span', n.type || '', 'node-type'))
      list.append(row)
    }
    entryCount()
  }
  function entryCount() {
    const options = entryOptions(), n = options.filter(box => box.checked).length
    const selectAll = $('relay-select-all')
    selectAll.disabled = options.length === 0
    selectAll.checked = n > 0 && n === options.length
    selectAll.indeterminate = n > 0 && n < options.length
    const limitHint = n > maxRelayEntries ? `最多可手动保存 ${maxRelayEntries} 个，更多节点可改用关键词。` : ''
    const lead = entryBy === 'keyword' ? '名称包含这个关键词的节点都会成为候选入口。' : n ? `已选 ${n} 个候选入口。${limitHint}` : ''
    GN.text('relay-entry-hint', lead + '多选的节点只是候选，都放进 Clash 的「入口选择」手动组，ClaudeGuard 不会自动切换：当前入口失效时 Claude 会被阻断，需要你在 Clash 里把「入口选择」切到另一个候选。')
  }

  function setupInput() {
    if (sb()) return { backendKind: 'singbox', controllerURL: $('controller-url').value.trim(), controllerSecret: $('controller-secret').value,
      exitRemark: $('sb-exit').value.trim(), expectedIP: $('sb-expected').value.trim(),
      clientPort: Number($('sb-local-port').value), probePort: Number($('sb-second-port').value),
      serverPort: Number($('server-port').value), gatewayPort: Number($('gateway-port').value),
      requireTun: $('require-tun').checked, startProtected: $('start-protected').checked }
    const keyword = entryBy === 'keyword' ? $('relay-keyword').value.trim() : ''
    return { controllerURL: $('controller-url').value.trim(), controllerSecret: $('controller-secret').value,
      exitMode: mode(), confirmChanges: true,
      relayLink: $('relay-link').value.trim(),
      exit: { host: $('relay-host').value.trim(), port: Number($('relay-port').value), username: $('relay-user').value, password: $('relay-password').value },
      entry: keyword ? { keyword } : { nodes: selectedEntries() },
      deviceWide: $('device-wide').checked, selectedProxy: $('selected-proxy').value, expectedIP: $('expected-input').value.trim(),
      serverPort: Number($('server-port').value), clientPort: Number($('client-port').value), probePort: Number($('probe-port').value), gatewayPort: Number($('gateway-port').value),
      requireTun: $('require-tun').checked, startProtected: $('start-protected').checked }
  }
  function validate(input) {
    if (input.backendKind === 'singbox') {
      if (!input.exitRemark) return '请填写固定出口节点在 v2rayN 里的别名。'
      if (/[,\r\n]/.test(input.exitRemark)) return '节点别名不能包含逗号或换行，请在 v2rayN 里改一个别名。'
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(input.expectedIP)) return '请填写唯一允许的出口 IPv4。'
      if (input.clientPort === input.probePort) return '本地端口和第二本地端口不能相同。'
      return null
    }
    if (input.exitMode === 'relay') {
      if (entryBy === 'keyword' ? !input.entry.keyword : !input.entry.nodes?.length) return '请至少勾选一个入口节点，或填写名称关键词。'
      if (input.entry.nodes?.length > maxRelayEntries) return `最多可手动保存 ${maxRelayEntries} 个入口节点。请取消部分勾选，或改用关键词。`
      if (!input.relayLink && (!input.exit.host || !input.exit.port)) return '请粘贴 SOCKS5 链接，或填写出口地址和端口。'
    } else {
      if (!input.selectedProxy) return '请选择 Claude 使用的固定节点。'
      if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(input.expectedIP)) return '请填写唯一允许的出口 IPv4。'
    }
    return null
  }

  // 进入配置时用已保存的值填表（每次进入一次，不随每秒刷新覆盖）
  function fill() {
    const settings = store.settings
    if (!settings) { syncKind(); renderEntryNodes([]); return }
    setKind(settings.backendKind === 'singbox' ? 'singbox' : 'mihomo')
    if (settings.backendKind === 'singbox') {
      $('sb-exit').value = settings.singbox?.exitRemark || settings.selectedProxy || ''
      $('sb-expected').value = settings.expectedIP || ''
      $('sb-local-port').value = settings.clientPort || 10808; $('sb-second-port').value = settings.probePort || 10809
      $('controller-url').value = settings.controllerURL || KIND_COPY.singbox.placeholder
      $('controller-secret').value = ''
      GN.text('secret-hint', settings.hasSecret ? '已保存密钥，留空保留；填写可替换。' : '未设置密钥可留空。')
      for (const [id, key] of [['server-port', 'serverPort'], ['gateway-port', 'gatewayPort']]) if (settings[key]) $(id).value = settings[key]
      $('require-tun').checked = settings.requireTun !== false; $('start-protected').checked = !!settings.startProtected
      secondPortHint(); syncKind(); return
    }
    setMode(settings.relay ? 'relay' : 'existing')
    $('relay-link').value = ''; $('relay-user').value = ''; $('relay-password').value = ''
    $('relay-host').value = settings.relay?.host || ''
    $('relay-port').value = settings.relay?.port || ''
    $('relay-password').placeholder = settings.relay?.auth ? '已保存，留空保留' : '可留空'
    $('relay-user').placeholder = settings.relay?.auth ? '已保存，留空保留' : '可留空'
    $('relay-keyword').value = settings.relay?.keyword || ''
    setEntryBy(settings.relay?.keyword ? 'keyword' : 'nodes')
    $('device-wide').checked = settings.deviceWide !== false
    $('controller-url').value = settings.controllerURL || 'http://127.0.0.1:9097'
    $('controller-secret').value = ''
    GN.text('secret-hint', settings.hasSecret ? '已保存密钥，留空保留；填写可替换。' : '未设置密钥可留空。')
    $('expected-input').value = settings.relay ? '' : settings.expectedIP || ''
    for (const [id, key] of [['server-port', 'serverPort'], ['client-port', 'clientPort'], ['probe-port', 'probePort'], ['gateway-port', 'gatewayPort']]) if (settings[key]) $(id).value = settings[key]
    $('require-tun').checked = settings.requireTun !== false; $('start-protected').checked = !!settings.startProtected
    syncExitMode()
    if (!store.nodes.length) {
      const chosen = settings.relay?.nodes || []
      if (chosen.length) store.nodes = chosen.map(name => ({ name, upstreamChain: [], relayEligible: true }))
      if (!settings.relay && settings.selectedProxy) { $('selected-proxy').replaceChildren(new Option(settings.selectedProxy, settings.selectedProxy)); $('selected-proxy').value = settings.selectedProxy }
    }
    renderEntryNodes(settings.relay?.nodes || [])
  }

  // ---------- 第 3 步：实时验收 ----------
  function howto() {
    if (store.settings?.backendKind === 'singbox') { GN.text('sb-gw-port', String(store.settings.gatewayPort || 19904)); secondPortHint(); return }
    const relay = !!store.settings?.relay
    GN.text('howto-confirm', relay ? '回到守护页确认实测 IPv4' : '回到守护页启用保护')
    GN.text('howto-confirm-detail', relay ? '右侧清单通过后，守护页会显示实测出口；确认后开始连续验证，通过才放行。'
      : '右侧清单通过后，在守护页点「启用保护」；固定出口连续验证通过才放行。')
  }
  function checks() {
    const s = store.state.status || {}, relay = !!store.settings?.relay
    const running = !!store.settings && s.state !== 'unconfigured'
    const gate = store.state.indicator?.key === 'protected'
    const singbox = store.settings?.backendKind === 'singbox'
    const conflict = s.reason === 'personal-guard-conflict'
    const rows = [
      ['守护服务已启动', running, running ? '运行中' : s.startError ? '未启动' : '等待'],
      [singbox ? 'v2rayN 已载入守护规则' : 'Clash 已载入守护规则', !conflict && !!s.prepared,
        conflict ? '规则冲突' : s.prepared ? '已载入' : s.phase === 'awaiting-rules' ? '等待导入' : '等待'],
      ['规则模式与 TUN', s.tunEnabled === true && s.reason !== 'rule-mode-required', s.tunEnabled === true ? '已开启' : s.tunEnabled === false ? '需开启 TUN'
        : singbox && s.reason === 'tun-status-unavailable' ? '无法确认' : '等待'],
    ]
    if (relay) for (const [key, title] of [['entry', '入口节点可用'], ['exit', 'SOCKS5 出口可连接']]) {
      const r = s.relay?.stages?.[key]
      rows.push([title, r?.ok === true, r ? r.ok ? '通过' : '未通过' : '等待'])
    }
    const ip = s.last?.ip
    rows.push([relay ? '实测出口 IPv4' : '固定出口验证', gate || (relay && !!ip), gate ? ip || '已放行' : ip ? `${ip}${relay ? ' · 待确认' : ''}` : '等待'])
    const bad = label => /未通过|需开启|未启动|规则冲突/.test(label)
    GN.patch($('setup-checks'), rows, () => rows.map(([title, done, label]) => {
      const li = node('li', undefined, `check ${done ? 'good' : bad(label) ? 'bad' : 'pending'}`)
      li.append(node('span', title, 'check-name'), node('span', label, 'check-state'))
      return li
    }))
  }

  function bind() {
    bindSecretHelp()
    document.querySelectorAll('input[name="exit-mode"]').forEach(radio => radio.addEventListener('change', syncExitMode))
    document.querySelectorAll('input[name="client-kind"]').forEach(radio => radio.addEventListener('change', () => { resetDetection(); syncKind(); detect() }))
    GN.on('sb-second-port', 'input', secondPortHint)
    document.querySelectorAll('[data-entry]').forEach(button => button.addEventListener('click', () => setEntryBy(button.dataset.entry)))
    GN.on('relay-select-all', 'change', event => {
      for (const option of entryOptions()) option.checked = event.target.checked
      entryCount()
    })
    GN.on('detect-clash', 'click', detect)
    GN.on('setup-back', 'click', () => GN.go('guard'))
    GN.on('wiz-back-1', 'click', () => step(1))
    GN.on('wiz-back-2', 'click', () => step(2))
    GN.on('wiz-finish', 'click', () => GN.go('guard'))
    GN.on('load-nodes', 'click', () => GN.busy($('load-nodes'), async () => {
      const previous = $('selected-proxy').value, chosen = entryOptions().length ? selectedEntries() : store.settings?.relay?.nodes || []
      const result = await GN.call('catalogue', setupInput())
      if (sb()) {
        const list = $('sb-nodes'); list.replaceChildren()
        for (const n of result.nodes) list.append(new Option(n.name))
        if (!$('sb-exit').value && result.nodes.length === 1) $('sb-exit').value = result.nodes[0].name
        GN.text('node-count', result.nodes.length ? `${result.nodes.length} 个可识别节点 · ${result.version}` : `已连接 · ${result.version}`)
        GN.text('sb-exit-hint', result.nodes.length ? '可从列表选择，或直接填写 v2rayN 里的别名；路由规则按别名找到这个节点。'
          : 'v2rayN 只列出正在使用的节点，请直接填写固定出口节点的别名，要一字不差。')
        step(2); return
      }
      store.nodes = result.nodes
      maxRelayEntries = result.maxRelayEntries
      $('selected-proxy').replaceChildren(new Option('请选择具体节点', ''))
      for (const n of store.nodes) { const option = new Option(n.name + (n.chainError ? '（链路不可用）' : ''), n.name); option.disabled = !!n.chainError; $('selected-proxy').add(option) }
      $('selected-proxy').value = previous || store.settings?.selectedProxy || ''
      renderEntryNodes(chosen)
      GN.text('node-count', `${store.nodes.length} 个具体节点 · Mihomo ${result.version}`)
      step(2)
    }))
    GN.on('selected-proxy', 'change', () => {
      const selected = store.nodes.find(n => n.name === $('selected-proxy').value)
      GN.text('chain-hint', selected?.chainError || (selected?.upstreamChain?.length ? '上游固定链：' + selected.upstreamChain.join(' → ') : '已选择具体节点。保存时会再次确认链路。'))
    })
    GN.on('pick-script', 'click', async () => { GN.text('script-name', await GN.call('pickScript') || '没有原脚本时使用透传脚本') })
    GN.on('setup-form', 'submit', async event => {
      event.preventDefault()
      const input = setupInput(), problem = validate(input)
      if (problem) { GN.toast(problem); return }
      await GN.busy($('save-setup'), async () => {
        try {
          const result = await GN.call('saveSetup', input)
          store.settings = result.settings
          if (input.backendKind === 'singbox') {
            GN.text('setup-result', '已保存并生成规则。按左侧步骤在 v2rayN 导入网关节点和路由规则，并开启 TUN。')
            GN.toast('配置已保存。下一步：在 v2rayN 导入网关节点和路由规则。')
          } else {
            GN.text('setup-result', '已保存并生成脚本。可以一键导入独立订阅，也可以手动导入。')
            GN.toast('配置已保存。下一步：把生成的脚本导入 Clash。')
          }
        } catch (error) {
          // 配置已写入但守护没能启动：仍进入第 3 步，原因显示在清单和守护页
          if (!/^配置已保存/.test(error.message)) throw error
          store.settings = (await GN.call('boot')).settings
          GN.text('setup-result', error.message)
          GN.toast(error.message)
        }
        $('relay-link').value = ''; $('relay-user').value = ''; $('relay-password').value = ''; $('controller-secret').value = ''
        step(3); GN.renderState()
      })
    })
    GN.on('import-verge', 'click', () => GN.busy($('import-verge'), async () => {
      const { name } = await GN.call('importVergeSubscription')
      GN.text('setup-result', `已导入「${name}」。请重新打开 Clash Verge，选中该订阅并开启 TUN。`)
      GN.toast(`已导入「${name}」`)
    }))
    GN.on('copy-script', 'click', () => GN.busy($('copy-script'), async () => { await GN.call('copyScript'); GN.toast('已复制。粘贴到 Clash Verge → 订阅 → 全局扩展脚本；2 分钟后自动清空剪贴板。') }))
    GN.on('reveal-script', 'click', () => GN.call('revealScript'))
    GN.on('copy-gw-link', 'click', () => GN.busy($('copy-gw-link'), async () => { await GN.call('copyTemplate', 'gateway-link'); GN.toast('已复制网关节点链接。在 v2rayN 服务器列表按 Ctrl+V 导入；2 分钟后自动清空剪贴板。') }))
    GN.on('copy-gw-password', 'click', () => GN.busy($('copy-gw-password'), async () => { await GN.call('copyTemplate', 'gateway-password'); GN.toast('已复制网关密码。导入链接失败时，手动添加 HTTP 服务器（127.0.0.1、网关端口、用户名 claude-guard）再粘贴；2 分钟后自动清空剪贴板。') }))
    GN.on('copy-sb-rules', 'click', () => GN.busy($('copy-sb-rules'), async () => { await GN.call('copyTemplate', 'rules'); GN.toast('已复制路由规则。在 v2rayN 规则列表「从剪贴板中导入规则」，选「是」追加，再逐条上移至顶。') }))
    GN.on('copy-sb-snippet', 'click', () => GN.busy($('copy-sb-snippet'), async () => { await GN.call('copyTemplate', 'singbox-snippet'); GN.toast('已复制 sing-box 片段（含网关密码），供直接编辑 sing-box 配置时使用；2 分钟后自动清空剪贴板。') }))
  }

  GN.render.setup = { step, fill, checks, bind, detect, syncKind }
})()
