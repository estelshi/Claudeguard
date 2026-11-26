(async () => {
  await window.guardnookReady
  const checks = []
  const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label) }
  const $ = selector => document.querySelector(selector)
  assert(typeof require === 'undefined' && typeof process === 'undefined', 'renderer has no Node.js access')
  assert(!$('#setup').hidden && !$('.wizard-step[data-step="1"]').hidden, 'first launch opens step 1 (识别 Clash)')
  assert(['识别 Clash', '入口与固定出口', '生成脚本并导入'].every((name, i) => $(`#stepper li[data-step="${i + 1}"]`).textContent.includes(name)),
    'setup reads as three steps')
  assert(['#home', '#apps', '#open-workspace', '#open-apps', '#export-board', '#open-data', '#quit', '#beijing-clock', '#theme', '#pill', '#pin', '#clock', '#todos', '#notes', '#guard-tag', '#nav-status']
    .every(selector => !$(selector)), 'no removed features, old theme dropdown, status chip or floating pill')
  assert(['board', 'apps', 'launch', 'addApp', 'exportData', 'openData', 'theme', 'window', 'quit'].every(name => !(name in window.guardnook)),
    'removed features have no renderer APIs')
  assert(['detectClash', 'detectV2rayn', 'copyTemplate', 'copyScript', 'setTheme', 'envCheck', 'envBaseline', 'envRepairPreview', 'envRepairApply', 'envHistory', 'envRestore', 'envOpenSettings']
    .every(name => typeof window.guardnook[name] === 'function'), 'new IPC calls are exposed')
  // 外观：默认浅色；设置里的「浅色 / 深色」切换后立即生效并保存
  const root = document.documentElement
  assert(root.dataset.theme === 'light' && getComputedStyle(root).colorScheme === 'light' && (await window.guardnook.boot()).value.theme === 'light', 'default theme is light')
  const choices = [...document.querySelectorAll('#settings #theme-choice [data-theme-value]')]
  assert(choices.length === 2 && choices[0].textContent === '浅色' && choices[1].textContent === '深色' && !document.querySelector('#theme-choice [data-theme-value=system]'),
    '设置 has one 外观 control: 浅色 / 深色')
  choices[1].click()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert(root.dataset.theme === 'dark' && getComputedStyle(root).colorScheme === 'dark' && choices[1].getAttribute('aria-checked') === 'true', 'toggle switches to dark')
  assert((await window.guardnook.boot()).value.theme === 'dark', 'dark theme is persisted')
  assert(!(await window.guardnook.setTheme('system')).ok, 'unknown theme values are rejected')
  choices[0].click()
  await new Promise(resolve => setTimeout(resolve, 150))
  assert(root.dataset.theme === 'light' && (await window.guardnook.boot()).value.theme === 'light', 'toggle switches back to light')
  const controller = await window.guardnook.catalogue({ controllerURL: 'http://remote.invalid:9090' })
  assert(!controller.ok, 'remote controller input is rejected')
  const detected = await window.guardnook.detectClash()
  assert(detected.ok && !('secret' in detected.value), 'auto-detect never returns the secret to the renderer')
  const action = await window.guardnook.guard('enable')
  assert(!action.ok, 'unconfigured guard cannot be enabled')
  const tabs = [...document.querySelectorAll('nav.pills [data-tab]')].map(b => b.dataset.tab)
  assert(JSON.stringify(tabs) === JSON.stringify(['guard', 'env', 'logs', 'settings']), 'nav: 守护 / 环境 / 日志 / 设置')
  for (const tab of tabs) {
    $(`[data-tab=${tab}]`).click()
    assert(!$(`#${tab}`).hidden && document.querySelectorAll('.tab:not([hidden])').length === 1, `${tab} navigation opens`)
  }
  $('[data-tab=guard]').click()
  assert($('#connection-checks').children.length >= 5, 'connection checklist lives on the guard page')
  for (const [name, instruction] of [['tun', '严格路由'], ['rules', '一键导入']]) {
    const tip = $(`#check-tip-${name}`)
    const button = $(`button[aria-describedby="${tip.id}"]`)
    assert(tip.hidden && tip.getAttribute('role') === 'tooltip' && tip.textContent.includes(instruction), `${name} help contains instructions`)
    button.parentElement.dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'mouse' }))
    assert(!tip.hidden, `${name} help opens on hover`)
    button.parentElement.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }))
    assert(tip.hidden, `${name} help closes after hover`)
    button.focus()
    assert(!tip.hidden, `${name} help opens on focus`)
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    assert(tip.hidden, `${name} help closes with Escape`)
    button.blur()
  }
  assert($('#guard #network-cards') && $('#guard .net-block').nextElementSibling.classList.contains('kpis'), 'network tiles sit right under the hero')
  assert($('#guard-summary').dataset.tone === 'idle' && $('#guard-block').hidden, 'unconfigured: idle badge, no block button')
  assert((await window.guardnook.boot()).value.indicator.key === 'unconfigured', 'unconfigured status uses the neutral taskbar icon')
  $('#configure').click()
  assert(!$('#setup').hidden, 'configure opens setup')
  document.querySelector('input[name="exit-mode"][value="relay"]').click()
  assert(!$('#relay-fields').hidden && $('#existing-fields').hidden && $('#require-tun').disabled, 'SOCKS5 relay mode forces TUN')
  document.querySelector('input[name="exit-mode"][value="existing"]').click()
  assert($('#relay-fields').hidden && !$('#existing-fields').hidden && !$('#require-tun').disabled, 'existing fixed node mode is still available')
  // v2rayN（sing-box 内核）：第 1 步多一个客户端选择；切换后三步改名、只保留固定节点方式
  assert(document.querySelector('input[name="client-kind"][value="mihomo"]').checked, 'Clash Verge / Mihomo stays the default client')
  document.querySelector('input[name="client-kind"][value="singbox"]').click()
  assert(['识别 v2rayN', '固定出口节点', '生成规则并导入'].every((name, i) => $(`#stepper li[data-step="${i + 1}"]`).textContent.includes(name))
    && !$('#singbox-fields').hidden && $('#relay-fields').hidden && $('#existing-fields').hidden && $('#exit-mode-choice').hidden && $('#device-wide-row').hidden
    && !$('#howto-singbox').hidden && $('#howto-clash').hidden && /Xray/.test($('.segmented label:nth-child(2) small').textContent), 'v2rayN (sing-box) setup: own steps, fixed node only, Xray marked unsupported')
  const v2 = await window.guardnook.detectV2rayn()
  assert(v2.ok && !('secret' in v2.value) && !('kind' in v2.value), 'v2rayN auto-detect never returns a secret to the renderer')
  assert(!(await window.guardnook.copyTemplate('other')).ok, 'copy-template rejects unknown templates')
  // 第 3 步「两次粘贴」：先复制网关节点链接（Ctrl+V），再复制路由规则（从剪贴板中导入规则）
  const sbSteps = [...document.querySelectorAll('#howto-singbox > li > strong')].map(n => n.textContent)
  assert(sbSteps.length === 5 && /网关节点/.test(sbSteps[0]) && /第二个本地端口/.test(sbSteps[1]) && /路由规则/.test(sbSteps[2]) && /sing-box/.test(sbSteps[3]) && /启用保护/.test(sbSteps[4])
    && $('#copy-gw-link').classList.contains('primary') && $('#copy-sb-rules').classList.contains('primary') && !$('#copy-sb-snippet').classList.contains('primary')
    && await (async () => { const r = await window.guardnook.copyTemplate('gateway-link'); return r.ok ? r.value === true : /先保存/.test(r.error || '') })(), 'v2rayN step 3: copy node link → Ctrl+V, second port, import rules, sing-box + TUN, enable; link copy returns no secret')
  document.querySelector('input[name="client-kind"][value="mihomo"]').click()
  assert(['识别 Clash', '入口与固定出口', '生成脚本并导入'].every((name, i) => $(`#stepper li[data-step="${i + 1}"]`).textContent.includes(name))
    && $('#singbox-fields').hidden && !$('#exit-mode-choice').hidden, 'switching back restores the Clash setup')
  // 每秒刷新不覆盖正在操作的控件
  const login = $('#login'); login.focus()
  const before = login.checked
  await new Promise(resolve => setTimeout(resolve, 1300))
  assert(login.checked === before, 'state ticks leave form controls alone')
  $('[data-tab=guard]').click()
  return { passed: checks.length, checks, title: document.title, version: (await window.guardnook.boot()).value.version }
})()
