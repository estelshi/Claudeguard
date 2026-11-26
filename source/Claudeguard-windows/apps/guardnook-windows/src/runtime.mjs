import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { atomicJSON, readJSON } from './storage.mjs'

// Explain why the guard could not start, in words the settings page can show as-is.
// v2rayN 的剪贴板导入（服务器列表 Ctrl+V /「从剪贴板导入分享链接」）不认 http:// 分享链接：
// 以 http:// 开头的行会被当成订阅地址添加。v2rayN 自己的「v2rayn://类型/base64url(JSON)」
// 链接（ServiceLib/Handler/Fmt/InnerFmt.cs，7.25.x 起）可以导入 HTTP 节点，要求 ConfigVersion 为 4，
// ConfigType 10 = HTTP。链接含网关密码，只在主进程生成并直接写入剪贴板。
export function v2raynGatewayLink(c) {
  const item = { ConfigType: 10, ConfigVersion: 4, Remarks: c.singbox.gatewayRemark, Address: '127.0.0.1',
    Port: c.gatewayPort, Username: c.proxyUser, Password: c.proxyPassword }
  return 'v2rayn://http/' + Buffer.from(JSON.stringify(item), 'utf8').toString('base64url')
}

export function describeStartError(error, c) {
  if (error?.code === 'EADDRINUSE') {
    const port = error.port || c?.gatewayPort
    return `端口 ${port} 已被其他程序占用，守护网关无法启动。请关闭占用它的程序，或在配置的「高级」里换一个端口后重新保存。`
  }
  if (error?.code === 'EACCES') return `没有权限监听端口 ${error.port || c?.gatewayPort}，守护网关无法启动。请换一个 1024 以上的端口。`
  if (/[\u3400-\u9fff]/.test(error?.message || '')) return '守护未启动：' + error.message
  return '守护未启动。请检查配置是否有效，以及网关端口是否被占用。'
}

export function describeSetupError(error) {
  const message = error?.message || ''
  const status = /^Controller HTTP (\d{3})$/.exec(message)?.[1]
  if (status === '401' || status === '403')
    return `代理客户端的控制接口拒绝了认证（HTTP ${status}）。请回第 1 步检查「接口密钥」。`
  if (status) return `代理客户端的控制接口返回 HTTP ${status}。请检查客户端是否正常运行，再重试。`
  if (message === 'Controller timeout' || error?.code === 'ETIMEDOUT')
    return '读取代理客户端的控制接口超时。请确认客户端正常运行，再重试。'
  if (error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET')
    return '无法连接代理客户端的控制接口。请回第 1 步检查控制接口地址和端口。'
  if (message === 'Invalid controller JSON' || message === 'Not a Clash controller' || message === 'Not a sing-box controller')
    return '控制接口返回了无法识别的数据。请回第 1 步检查控制接口地址和所选客户端。'
  if (message === 'Controller response too large') return '控制接口返回的节点数据过大，无法读取。'
  if (message === 'Invalid controller secret') return '接口密钥格式无效。请从代理客户端重新复制密钥。'
  if (message === 'Invalid controller URL' || message === 'Controller must be a loopback HTTP address with an explicit port')
    return '控制接口地址无效。请在第 1 步填写带端口的本机 HTTP 地址。'
  if (message === 'Gateway, probe, client and dashboard ports must differ' || message === 'This port is reserved for the personal edition'
    || /^Invalid (serverPort|clientPort|probePort|gatewayPort)$/.test(message))
    return '端口配置无效或重复。请在「高级」里检查面板、客户端、探测和网关端口。'
  if (error instanceof SyntaxError) return '生成的 Clash 扩展脚本无法解析。请检查「高级」里选择的原始 JS 脚本。'
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return '没有权限写入配置或脚本文件。请检查应用数据目录的权限。'
  if (error?.code === 'ENOSPC') return '磁盘空间不足，无法写入配置或脚本文件。'
  if (/[\u3400-\u9fff]/.test(message)) return message
  return '未能完成配置操作。请检查接口设置后重试。'
}

export async function createRuntime(serviceDirectory, directory, { loadRelayCredentials = async () => null, storeRelayCredentials = async () => { throw new Error("无法保存中转凭据。") },
  removeRelayCredentials = async () => {}, pruneRelayCredentials = async () => {} } = {}) {
  const load = name => import(pathToFileURL(join(serviceDirectory, `${name}.mjs`)).href)
  const [{ validateShareConfig }, { createController }, { createGateway }, { createGuard }, { probeExit }, { createDiagnostics }, { createRouteCheck }, { createConnectionLog }, { closeClaudeConnections }, setup, { probeRelayPath, parseSocks5Link, normalizeSocks5, isRelayEntryName, maxRelayEntries }, singbox] = await Promise.all(
    ['config', 'controller', 'gateway', 'guard', 'probe', 'diagnostics', 'route-check', 'connection-log', 'tun-connections', 'setup', 'relay', 'singbox'].map(load))
  let running, config, startError = null
  const statePath = join(directory, 'state.json')
  const stop = async () => {
    const previous = running
    running = undefined
    if (previous) {
      previous.diagnostics.stop()
      await previous.connectionLog.stop()
      await previous.guard.dispose()
      await previous.gateway.stop()
    }
  }
  const start = async () => {
    await stop()
    config = await readJSON(join(directory, 'config.json'), null)
    if (!config) return
    const c = validateShareConfig(config)
    if (c.targetPlatform !== 'win32') throw new Error('请重新保存 Windows 节点配置')
    const controller = createController(c)
    let guard
    const gateway = createGateway(c, event => guard.record(event), async () => { if (!await guard.admit()) throw new Error('Guard admission denied') })
    const credentials = c.relay?.auth ? await loadRelayCredentials(c.relay.id).catch(() => null) : null
    guard = createGuard(c, controller, gateway, probeExit, {
      drain: () => closeClaudeConnections(c, controller, { managedOnly: true }),
      relayPath: c.relay ? report => probeRelayPath(c, controller, credentials, report) : undefined,
    })
    const diagnostics = createDiagnostics(c, controller)
    const routeCheck = createRouteCheck(c, controller, guard)
    const connectionLog = createConnectionLog(c, controller)
    try {
      await gateway.start()
      running = { c, controller, guard, gateway, diagnostics, routeCheck, connectionLog }
      const state = await readJSON(statePath, { manual: false })
      if (state.manual !== false) await guard.block()
      else if (c.startProtected) await guard.enable()
      guard.start(); diagnostics.start(); connectionLog.start()
      startError = null
    } catch (error) {
      await guard.dispose(); await gateway.stop(); running = undefined
      throw error
    }
  }
  return {
    async start() { try { await start() } catch (error) { startError = describeStartError(error, config); throw error } },
    startError: () => startError,
    stop,
    settings: () => config ? Object.fromEntries(['expectedIP', 'selectedProxy', 'controllerURL', 'serverPort', 'clientPort', 'probePort', 'gatewayPort', 'startProtected', 'requireTun', 'guardGoogleAuth', 'relay', 'deviceWide'].map(k => [k, config[k]]).concat([['hasSecret', !!config.controllerSecret]])
      // sing-box（v2rayN）：只在该后端时出现，Clash 配置的设置项保持原样
      .concat(config.backendKind === 'singbox' ? [['backendKind', 'singbox'], ['singbox', { exitRemark: config.singbox?.exitRemark, gatewayRemark: config.singbox?.gatewayRemark,
        probeInbound: config.singbox?.probeInbound, hasConfigPath: !!config.singbox?.configPath }], ['gatewayUser', config.proxyUser]] : [])) : null,
    diagnostics: () => running?.diagnostics.status(),
    // Read-only Clash /configs for the environment check (TUN, IPv6 handling).
    async clashConfigs() { return running ? running.controller.request('/configs', 'GET', undefined, { timeoutMs: 1500 }) : null },
    status() { return running ? { ...running.guard.status(), connectionLog: running.connectionLog.status(), receivedAt: Date.now() } : { state: 'unconfigured', phase: 'unconfigured', reason: startError, startError, receivedAt: Date.now() } },
    async catalogue(input) {
      const previous = await readJSON(join(directory, 'config.json'), null)
      const result = await setup.catalogue({ ...input, targetPlatform: 'win32', controllerSocket: '', controllerSecret: input.controllerSecret || previous?.controllerSecret || '' })
      if (input.backendKind === 'singbox') return result
      const nodes = result.nodes.map(node => ({
        ...node,
        relayEligible: !node.chainError && !node.upstreamChain?.length && isRelayEntryName(node.name),
      }))
      return { ...result, nodes, maxRelayEntries }
    },
    async save(input, originalScript) {
      const previous = await readJSON(join(directory, 'config.json'), null)
      if (originalScript === undefined) {
        const manifest = await readJSON(join(directory, 'SETUP.json'), null)
        if (manifest?.originalPath) {
          const { resolve, sep } = await import('node:path')
          const path = resolve(manifest.originalPath)
          if (!path.startsWith(resolve(directory, 'Profiles') + sep)) throw new Error('原始脚本路径无效')
          originalScript = await (await import('node:fs/promises')).readFile(path, 'utf8')
        }
      }
      if (input.backendKind === 'singbox') {
        // v2rayN（sing-box 内核）：只支持「已有固定出口节点」；生成路由规则与 sing-box 片段，不读写任何 v2rayN 文件
        const configPath = typeof input.singboxConfigPath === 'string' && input.singboxConfigPath ? input.singboxConfigPath
          : previous?.backendKind === 'singbox' ? previous.singbox?.configPath || '' : ''
        const result = await setup.saveSingboxSetup(directory, { ...input, singboxConfigPath: configPath, controllerSocket: '', targetPlatform: 'win32',
          controllerSecret: input.controllerSecret || previous?.controllerSecret || '' })
        await pruneRelayCredentials(null).catch(() => {})
        try { await start() }
        catch (error) {
          startError = describeStartError(error, config)
          throw new Error('配置已保存，但' + startError)
        }
        return { ...result, settings: this.settings() }
      }
      const request = { ...input, originalScript, controllerSocket: '', clientID: 'verge', targetPlatform: 'win32',
        controllerSecret: input.controllerSecret || previous?.controllerSecret || '' }
      let result
      if (input.exitMode === 'relay') {
        let exit
        try {
          exit = normalizeSocks5(input.relayLink ? parseSocks5Link(input.relayLink) : input.exit)
        } catch { throw new Error('请检查 SOCKS5 地址、端口和凭据。链接中的特殊字符需要编码。') }
        if (!exit.username && !exit.password && previous?.relay?.auth === true && previous.relay.host === exit.host && previous.relay.port === exit.port) {
          const saved = await loadRelayCredentials(previous.relay.id).catch(() => null)
          if (!saved?.username || !saved?.password) throw new Error('无法读取保存的 SOCKS5 凭据，请重新填写用户名和密码。')
          exit = { ...exit, username: saved.username, password: saved.password }
        }
        if (!exit.username || !exit.password) throw new Error('请填写 SOCKS5 用户名和密码。')
        request.relayID = previous?.relay?.auth === true && previous.relay.host === exit.host && previous.relay.port === exit.port
          ? previous.relay.id : randomBytes(16).toString('hex')
        await storeRelayCredentials(request.relayID, exit).catch(() => { throw new Error('Windows 无法加密保存 SOCKS5 凭据。') })
        try { result = await setup.saveRelay(directory, { ...request, exit, requireTun: true }) }
        catch (error) { await removeRelayCredentials(request.relayID).catch(() => {}); throw error }
      } else result = await setup.saveSetup(directory, request)
      // The new config is on disk: only the secret it references is still needed.
      await pruneRelayCredentials(request.relayID || null).catch(() => {})
      try { await start() }
      catch (error) {
        startError = describeStartError(error, config)
        throw new Error('配置已保存，但' + startError)
      }
      return { ...result, settings: this.settings() }
    },
    // sing-box 模板：路由规则（无密钥）、网关节点链接 / 网关密码、带密码的 sing-box 片段（只供本机粘贴）
    async template(kind) {
      const saved = await readJSON(join(directory, 'config.json'), null)
      if (!saved || saved.backendKind !== 'singbox') throw new Error('请先保存 v2rayN（sing-box）配置')
      const c = validateShareConfig(saved)
      if (kind === 'rules') return JSON.stringify(singbox.v2raynRules(c), null, 2)
      if (kind === 'gateway-link') return v2raynGatewayLink(c)
      if (kind === 'gateway-password') return c.proxyPassword
      if (kind === 'singbox-snippet') return JSON.stringify(singbox.singboxSnippet(c, { includePassword: true }), null, 2)
      throw new Error('未知模板')
    },
    async confirmRelay() {
      const status = running?.guard.status()
      if (!status?.relay?.id || !status.last?.ip) throw new Error('请先重载 Clash 并等待中转实测。')
      await setup.confirmRelay(directory, { relayID: status.relay.id, expectedIP: status.last.ip }, () => status)
      await start()
      return this.settings()
    },
    async action(action) {
      if (!running) throw new Error('请先配置节点并启动守护')
      if (action === 'diagnostics') return running.diagnostics.status()
      if (action === 'audit') return running.diagnostics.inspect()
      if (action === 'route-check') return running.routeCheck.inspect()
      if (action === 'client-exit') return running.routeCheck.verifyClient()
      if (action === 'block') {
        const closing = running.guard.block()
        closing.catch(() => {}) // observed below; never left as an unhandled rejection
        try { await atomicJSON(statePath, { manual: true }) }
        catch {
          await closing.catch(() => {})
          throw new Error('已阻断 Claude，但无法保存「手动阻断」状态；重启 ClaudeGuard 后需要再次阻断。')
        }
        return closing
      }
      if (action === 'enable') {
        await atomicJSON(statePath, { manual: false })
        return running.guard.enable()
      }
      if (action === 'inspect') return running.guard.inspect()
      throw new Error('未知守护操作')
    },
  }
}
