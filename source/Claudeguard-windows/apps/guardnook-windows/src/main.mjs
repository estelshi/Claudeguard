import { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, nativeImage, shell, dialog, net, nativeTheme, safeStorage, clipboard, powerMonitor } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { ensureDataDirectory, readJSON, readTheme, writeTheme, THEME_CHROME } from './storage.mjs'
import { privateDirectory } from './private-dir.mjs'
import { createRuntime, describeSetupError } from './runtime.mjs'
import { protectionIndicator, tintTaskbarBitmap, trayMenuKey, trayMenuItems } from './taskbar.mjs'
import { createRelayVault } from './relay-vault.mjs'
import { detectClash, detectV2rayN } from './clash-detect.mjs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createEnvironment } from './win-environment.mjs'
import { importVergeSubscription } from './verge-import.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const uiPath = join(here, '../renderer/index.html')
const uiURL = pathToFileURL(uiPath).href
const smoke = !app.isPackaged && process.argv.includes('--smoke-test')
const execute = promisify(execFile)
// Keep the existing Windows settings and safeStorage files across the rename.
app.setName('ClaudeGuard')
if (process.platform === 'win32') app.setAppUserModelId('local.guardnook.share.windows')
app.setPath('userData', join(app.getPath('appData'), 'GuardNook Share'))
if (!app.isPackaged && process.env.GUARDNOOK_TEST_DATA) app.setPath('userData', process.env.GUARDNOOK_TEST_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
else {
  let window, tray, runtime, timer, quitting = false, confirmingQuit = false, mutation = Promise.resolve(), originalScript, scriptName = '', probePending
  let probes = {}, lastTrayKey, lastIndicator, theme = 'light'
  let detected = null // 自动识别到的控制接口与密钥；密钥只留在主进程
  const images = new Map()
  const directory = app.getPath('userData')
  const serviceDirectory = app.isPackaged ? join(process.resourcesPath, 'GuardCore') : join(here, '../../../packages/guard-core')
  const iconPath = app.isPackaged ? join(process.resourcesPath, 'Clawd.png') : join(here, '../assets/taskbar-mask.png')
  const enqueue = operation => {
    const result = mutation.then(operation)
    mutation = result.catch(() => {})
    return result
  }
  const snapshot = () => {
    const status = runtime.status()
    return { status, indicator: protectionIndicator(status, Boolean(runtime.settings())),
      probes, diagnostics: runtime.diagnostics() }
  }
  const imageFor = (indicator, size) => {
    const key = `${indicator.key}:${size}`
    if (!images.has(key)) {
      const base = nativeImage.createFromPath(iconPath).resize({ width: size, height: size, quality: 'best' })
      if (base.isEmpty()) return base
      const bitmap = tintTaskbarBitmap(base.toBitmap(), indicator.color)
      images.set(key, nativeImage.createFromBitmap(bitmap, { width: size, height: size }))
    }
    return images.get(key)
  }
  const updateIcons = indicator => {
    const configured = Boolean(runtime.settings())
    const key = trayMenuKey(indicator, configured)
    if (key !== lastTrayKey && tray) {
      lastTrayKey = key
      tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems(indicator, configured, {
        open: showWindow, inspect: () => runTrayGuardAction('inspect'), block: () => runTrayGuardAction('block'), quit: quitWithConfirmation })))
    }
    if (indicator.key === lastIndicator) return
    lastIndicator = indicator.key
    const title = 'ClaudeGuard · ' + indicator.label
    tray?.setImage(imageFor(indicator, 24))
    tray?.setToolTip(title)
    if (process.platform === 'win32') {
      window.setIcon(imageFor(indicator, 48))
      // Windows can keep a pinned shortcut's icon. The overlay still shows the colored Clawd.
      window.setOverlayIcon(imageFor(indicator, 16), indicator.label)
    } else if (process.platform === 'linux') window.setIcon(imageFor(indicator, 48))
    window.setTitle(title)
  }
  const push = () => {
    if (!window || window.isDestroyed()) return
    const value = snapshot()
    updateIcons(value.indicator)
    window.webContents.send('guardnook:state', value)
  }
  function runTrayGuardAction(action) {
    void enqueue(() => runtime.action(action)).then(push).catch(() => showWindow())
  }
  function showWindow() {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
  function quitWithConfirmation() {
    if (confirmingQuit || quitting) return
    confirmingQuit = true
    showWindow()
    void dialog.showMessageBox(window, { type: 'warning', title: '退出 ClaudeGuard',
      message: '退出后，已接入守护通道的 Claude 将无法联网。',
      buttons: ['继续运行', '退出'], defaultId: 0, cancelId: 0,
    }).then(({ response }) => { if (response === 1) app.quit() })
      .finally(() => { confirmingQuit = false })
  }
  function safeHandle(name, handler, mutates = false) {
    ipcMain.handle(`guardnook:${name}`, async (event, input) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== uiURL) throw new Error('不允许的调用来源')
      if (JSON.stringify(input ?? null).length > 1024 * 1024) return { ok: false, error: '请求过大' }
      try { return { ok: true, value: await (mutates ? enqueue(() => handler(input)) : handler(input)) } }
      catch (error) {
        if (name === 'catalogue' || name === 'save-setup') return { ok: false, error: describeSetupError(error) }
        return { ok: false, error: /[\u3400-\u9fff]/.test(error.message) ? error.message : '操作未完成，请检查节点、接口、权限和端口设置。' }
      }
    })
  }
  async function networkProbes() {
    if (probePending) return probePending
    probePending = (async () => {
      const trace = async (name, url, availability) => {
        const at = Date.now()
        try {
          const response = await net.fetch(url, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const text = (await response.text()).slice(0, 65536)
          const ip = text.match(/^ip=(.+)$/m)?.[1]?.trim() || text.trim()
          if (!isIP(ip)) throw new Error('响应缺少有效出口 IP')
          if (availability) {
            const page = await net.fetch(availability, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(8000) })
            await page.body?.cancel()
            if (!page.ok) throw new Error(`网页访问 HTTP ${page.status}`)
          }
          return [name, { at, ok: true, ip, location: text.match(/^loc=(.+)$/m)?.[1] || '', source: new URL(url).hostname }]
        } catch (error) { return [name, { at, ok: false, ip: null, reason: /HTTP|有效/.test(error.message) ? error.message : '连接失败或超时', source: new URL(url).hostname }] }
      }
      probes = Object.fromEntries(await Promise.all([
        runtime.action('client-exit').then(result => ['claude', { at: Date.now(), ok: result.state === 'verified',
          ip: result.ip, source: 'Claude 守护入口', reason: result.state === 'gate-closed' ? 'Claude 尚未放行' : '等待验证' }])
          .catch(() => ['claude', { at: Date.now(), ok: false, reason: '等待守护通道' }]),
        trace('codex', 'https://chatgpt.com/cdn-cgi/trace', 'https://chatgpt.com/'),
        trace('ipv4', 'https://api4.ipify.org'), trace('cloudflare', 'https://1.1.1.1/cdn-cgi/trace'),
      ]))
      push(); return probes
    })().finally(() => { probePending = undefined })
    return probePending
  }
  function installHandlers() {
    safeHandle('boot', async () => ({ ...snapshot(), version: app.getVersion(), settings: runtime.settings(), login: app.getLoginItemSettings().openAtLogin, platform: process.platform, theme }))
    // 外观：浅色（默认）/ 深色。写入 appearance.json，同时给原生窗口换底色和标题栏按钮颜色
    safeHandle('set-theme', async value => {
      await writeTheme(directory, value)
      theme = value
      applyChrome()
      return theme
    }, true)
    // 留空密钥且地址与自动识别结果一致时，由主进程补上识别到的密钥
    const withDetected = input => {
      const value = { ...(input || {}) }
      delete value.singboxConfigPath // 配置文件路径只来自主进程的识别结果，不接受渲染层传入
      if (!value.controllerSecret && detected?.secret && value.controllerURL === detected.controllerURL) value.controllerSecret = detected.secret
      if (value.backendKind === 'singbox' && detected?.kind === 'singbox' && detected.configPath && value.controllerURL === detected.controllerURL)
        value.singboxConfigPath = detected.configPath
      return value
    }
    // 正在运行的 v2rayN.exe 所在文件夹（只读进程路径；失败时退回常见位置）
    const v2raynDirs = () => process.platform !== 'win32' ? Promise.resolve([]) : new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Name v2rayN -ErrorAction SilentlyContinue | Select-Object -First 1).Path'],
        { timeout: 2500, windowsHide: true }, (error, stdout) => {
          const path = String(stdout || '').trim()
          resolve(!error && /^[A-Za-z]:\\.+\.exe$/i.test(path) ? [dirname(path)] : [])
        })
    })
    safeHandle('detect-v2rayn', async () => {
      detected = { ...await detectV2rayN({ processDirs: v2raynDirs }), kind: 'singbox' }
      const { secret, kind, ...result } = detected
      return result
    })
    // 复制 sing-box 模板；含密码的内容 2 分钟后若剪贴板未变则清空
    safeHandle('copy-template', async kind => {
      const text = await runtime.template(kind)
      clipboard.writeText(text)
      if (kind !== 'rules') setTimeout(() => { if (clipboard.readText() === text) clipboard.clear() }, 120000)
      return true
    })
    safeHandle('detect-clash', async () => {
      detected = { ...await detectClash(), kind: 'mihomo' }
      const { secret, kind, ...result } = detected
      return result
    })
    safeHandle('catalogue', input => runtime.catalogue(withDetected(input)))
    safeHandle('pick-script', async () => {
      const result = await dialog.showOpenDialog(window, { title: '选择加入 ClaudeGuard 之前的原始 Clash 扩展脚本', properties: ['openFile'], filters: [{ name: 'JavaScript', extensions: ['js'] }] })
      if (result.canceled) return scriptName
      const info = await stat(result.filePaths[0])
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('脚本应为不超过 2 MB 的 JS 文件')
      originalScript = await readFile(result.filePaths[0], 'utf8')
      scriptName = result.filePaths[0].replaceAll('\\', '/').split('/').pop()
      return scriptName
    })
    safeHandle('save-setup', async input => {
      try {
        const result = await runtime.save(withDetected(input), originalScript)
        originalScript = undefined; scriptName = ''; return result
      } finally { push() }
    }, true)
    safeHandle('confirm-relay', async () => { const settings = await runtime.confirmRelay(); push(); return settings }, true)
    safeHandle('set-uu-remote', async value => {
      if (typeof value !== 'boolean') throw new Error('UU 远程直连设置无效。')
      return runtime.setAllowUURemote(value)
    }, true)
    const generatedScript = async () => {
      const manifest = await readJSON(join(directory, 'SETUP.json'), null)
      if (!manifest?.scriptPath?.startsWith(join(directory, 'Profiles') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('请先保存节点配置')
      return manifest.scriptPath
    }
    safeHandle('reveal-script', async () => { shell.showItemInFolder(await generatedScript()) })
    safeHandle('import-verge-subscription', async () => {
      if (process.platform !== 'win32') throw new Error('当前为 macOS 预览，请在 Windows 版中执行一键导入。')
      const settings = runtime.settings()
      if (!settings || settings.backendKind === 'singbox') throw new Error('请先保存 Clash 的守护配置。')
      const path = await generatedScript()
      const info = await stat(path)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('生成脚本异常，请重新保存配置。')
      const vergeDir = join(app.getPath('appData'), 'io.github.clash-verge-rev.clash-verge-rev')
      return importVergeSubscription({
        settings, vergeDir, backupDir: directory, script: await readFile(path, 'utf8'),
        isRunning: async () => {
          const tasklist = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe')
          const { stdout } = await execute(tasklist, ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 })
          return /^"clash[ -]verge\.exe",/im.test(stdout)
        },
      })
    }, true)
    // 复制生成的脚本（含本机网关凭据，中转有账号时也含出口凭据）；2 分钟后若剪贴板未变则清空
    safeHandle('copy-script', async () => {
      const path = await generatedScript(), info = await stat(path)
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('生成脚本异常，请重新保存配置')
      const text = await readFile(path, 'utf8')
      clipboard.writeText(text)
      setTimeout(() => { if (clipboard.readText() === text) clipboard.clear() }, 120000)
      return true
    })
    safeHandle('guard', async action => { const result = await runtime.action(action); push(); return result }, true)
    safeHandle('probes', networkProbes)
    safeHandle('login', enabled => {
      if (typeof enabled !== 'boolean') throw new Error('启动设置无效')
      app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
      return app.getLoginItemSettings().openAtLogin
    }, true)
    // 环境检查、修复与恢复：只读检查 + 用户确认后的可还原修改；不改动守护核心
    const environment = createEnvironment({ dataDir: directory, guardStatus: () => runtime.status(), clashConfigs: () => runtime.clashConfigs(),
      exitProbe: () => probes.cloudflare })
    const windowsOnly = () => { if (process.platform !== 'win32') throw new Error('环境检查只在 Windows 上可用。') }
    safeHandle('env-check', async () => { windowsOnly(); return environment.inspect() })
    safeHandle('env-baseline', async input => { windowsOnly(); return input ? environment.saveBaseline(input) : environment.baseline() }, true)
    safeHandle('env-repair-preview', async keys => { windowsOnly(); return environment.preview(keys ?? undefined) })
    safeHandle('env-repair-apply', async input => { windowsOnly(); return environment.apply(input) }, true)
    safeHandle('env-history', async () => { windowsOnly(); return environment.history() })
    safeHandle('env-restore', async id => { windowsOnly(); return environment.restore(id) }, true)
    safeHandle('env-open-settings', async page => {
      const url = { language: 'ms-settings:regionlanguage', time: 'ms-settings:dateandtime' }[page]
      if (!url) throw new Error('未知设置页')
      await shell.openExternal(url)
    })
  }
  // 原生部分跟随外观：系统对话框、窗口底色、titleBarOverlay（Windows 绘制的最小化 / 最大化 / 关闭按钮）
  function applyChrome() {
    nativeTheme.themeSource = theme
    if (!window || window.isDestroyed()) return
    const chrome = THEME_CHROME[theme]
    window.setBackgroundColor(chrome.background)
    try { if (process.platform === 'win32') window.setTitleBarOverlay({ color: chrome.background, symbolColor: chrome.symbol, height: 36 }) } catch {}
  }
  async function ready() {
    await privateDirectory(directory)
    await ensureDataDirectory(directory)
    theme = await readTheme(directory) // 默认浅色；读不到或无效时也用浅色
    nativeTheme.themeSource = theme
    const chrome = THEME_CHROME[theme]
    const relayVault = createRelayVault(directory, safeStorage)
    runtime = await createRuntime(serviceDirectory, directory, { loadRelayCredentials: relayVault.load, storeRelayCredentials: relayVault.save,
      removeRelayCredentials: relayVault.remove, pruneRelayCredentials: relayVault.prune })
    await runtime.start().catch(() => {}) // 原因写入 status().reason，界面直接显示
    window = new BrowserWindow({ width: 1040, height: 720, minWidth: 820, minHeight: 600,
      title: 'ClaudeGuard', show: false, icon: imageFor(protectionIndicator(null, false), 48), autoHideMenuBar: true, backgroundColor: chrome.background,
      // 原生 Windows 窗口：系统最小化/最大化/关闭按钮由 titleBarOverlay 绘制，标题栏只放品牌
      titleBarStyle: 'hidden', titleBarOverlay: { color: chrome.background, symbolColor: chrome.symbol, height: 36 },
      webPreferences: { preload: join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: !app.isPackaged } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    window.on('close', event => { if (!quitting) { event.preventDefault(); window.minimize() } })
    // 注销 / 关机：不再拦截关闭，否则 Windows 会显示「此应用正在阻止关机」
    const endingSession = () => { quitting = true; clearInterval(timer) }
    window.on('session-end', endingSession)
    powerMonitor.on('shutdown', endingSession)
    installHandlers()
    // 外观经 URL hash 传给渲染层，renderer/js/theme-boot.js 在首次绘制前设好 data-theme，避免闪白
    await window.loadFile(uiPath, { hash: 'theme=' + theme })
    tray = new Tray(imageFor(protectionIndicator(null, false), 24))
    tray.on('click', showWindow)
    lastIndicator = undefined; lastTrayKey = undefined // 托盘刚创建：下一次 push 写入当前状态的图标和菜单
    globalShortcut.register('CommandOrControl+Alt+Space', showWindow)
    window.on('restore', push)
    showWindow()
    push()
    timer = setInterval(push, 1000)
    if (smoke) {
      await window.webContents.executeJavaScript('window.guardnookReady')
      try {
        const script = await readFile(join(here, '../tests/smoke-renderer.js'), 'utf8')
        const result = await window.webContents.executeJavaScript(script)
        await writeFile(join(directory, 'smoke.png'), (await window.webContents.capturePage()).toPNG())
        await writeFile(join(directory, 'smoke.json'), JSON.stringify(result, null, 2))
        console.log(JSON.stringify(result))
        app.quit()
      } catch (error) { console.error('Electron smoke failed:', error.message); await runtime.stop(); app.exit(1) }
    }
  }
  app.on('second-instance', () => { if (window && !window.isDestroyed()) showWindow() })
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault(); quitting = true
    clearInterval(timer); globalShortcut.unregisterAll()
    void mutation.finally(() => runtime?.stop()).catch(() => {}).finally(() => { tray?.destroy(); app.quit() })
  })
  app.whenReady().then(ready).catch(error => {
    dialog.showErrorBox('ClaudeGuard 无法启动', /[\u3400-\u9fff]/.test(error.message) ? error.message : '请检查安装文件和本机数据目录的权限。')
    app.quit()
  })
}
