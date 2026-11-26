# ClaudeGuard Windows 1.0.0 使用指南

双击 `ClaudeGuard.exe` 打开普通的 Windows 窗口（系统自带的最小化 / 最大化 / 关闭按钮）。界面默认浅色，可在「设置 → 外观」切换为深色。窗口里有四页：「Claude 守护」「环境」「日志」「设置」。

关闭窗口只会最小化，守护继续运行；点任务栏或通知区域的 Clawd 图标、或按 `Ctrl + Alt + Space` 回到窗口。通知区域菜单可以重新验证、立即阻断 Claude 或退出。退出时会二次确认：退出后经守护网关的 Claude 连接会断开。注销或关机时 ClaudeGuard 不会拦截，Windows 可以正常结束会话。

任务栏和通知区域里的小 Clawd 会变色：绿色＝固定出口已验证、正在放行；橙色＝正在验证；红色＝已阻断；灰色＝尚未配置或等待导入守护规则。窗口里的状态只看大标题和它左边的像素 Clawd：走路＝放行，左右张望＝确认中，睡觉 zzz＝阻断，眨眼＝未配置。

## 运行

适用于 Windows 10 / 11 x64。完整解压 ZIP，运行其中的 `ClaudeGuard.exe`。包内含运行组件，无需另装 Node.js。开发包未签名，Windows 可能提示未知发布者。设置和加密后的中转凭据位于 `%APPDATA%\GuardNook Share`。已有设置可继续使用。

**开机自动启动：** 在「设置」里开启后，Windows 记住的是当前 `ClaudeGuard.exe` 的位置。使用免安装 ZIP 时，开启后请不要再移动或重命名这个文件夹；要移动，先关掉开机自启，移动后再打开。

## 接入 Clash（三步）

1. **识别 Clash。** 启动 Clash Verge Rev（或 Mihomo），点「自动识别」。ClaudeGuard 会读取 Verge 的配置文件，依次探测 Verge 配置里写的地址、`127.0.0.1:9097`（Verge Rev 默认）和 `127.0.0.1:9090`（Mihomo 默认）。找到密钥时只在本机主进程里使用，界面只显示「已读取密钥」。Verge 没开外部控制器、或需要密钥时会直接告诉你去哪里改。也可以手动填写控制接口和密钥。
2. **选入口节点并填固定出口。**
   - 推荐「SOCKS5 中转」：勾选一个或多个 Clash 节点做入口（或按名称关键词），再粘贴 `socks5://` 链接或手填地址、端口、账号密码。中转始终要求 TUN；可选「整机公网 TCP 使用固定出口」。
   - **多选入口只是候选，不会自动切换。** 勾选的节点都放进 Clash 的「入口选择」手动选择组（守护要求它是 Selector）。当前入口失效时 Claude 会被阻断，需要你在 Clash 里把「入口选择」切到另一个候选，再点「重新验证」。
   - 也可以选「已有固定出口节点」：直接选 Clash 里本身就是固定 IP 的节点，并填写唯一允许的出口 IPv4。
   - 已有扩展脚本时，在「高级」里选取接入前的原始脚本，已有分流会保留。
3. **生成脚本并导入。** 使用 Clash Verge Rev 时，可以从托盘退出 Clash Verge，再点「一键导入」。ClaudeGuard 会创建名为「ClaudeGuard（出口 IPv4）」的独立本地订阅，并把脚本挂到该订阅。重新打开 Clash Verge 后，选中该订阅，保持「规则」模式并开启 TUN。手动导入也可以使用「复制脚本」（2 分钟后自动清空剪贴板），然后在 Clash Verge 的「全局扩展脚本」中粘贴并重载。生成的脚本含本机凭据，只供本机使用。

导入后回到「Claude 守护」：中转模式会显示实测到的公网 IPv4，点「确认出口」后开始连续验证；已有节点模式点「启用保护」。只有固定出口、守护规则和实测 IPv4 连续验证通过才放行。退出、手动阻断、验证失效或出口变化时，进入守护网关的 Claude 请求会被阻断。普通网络继续使用 Clash 或系统路由。

保存配置后如果守护没能启动（例如网关端口被别的程序占用），守护页和第 3 步会直接写明原因和处理办法。

## 接入 v2rayN（sing-box 内核）

**尚未在真实的 v2rayN 上验证。** 只支持 sing-box 内核，不支持 Xray；只支持「已有固定出口节点」（不支持 SOCKS5 中转和整机固定出口）。

1. **识别 v2rayN。** 在第 1 步选「v2rayN（sing-box 内核）」，点「自动识别」。ClaudeGuard 读取 v2rayN 生成的 `binConfigs\config.json`，找到 sing-box 的控制接口（默认 `127.0.0.1:10813`，开启 TUN 时 `10814`）；也可以手动填写。ClaudeGuard 不改写、不重启 v2rayN。
2. **填固定出口节点。** 填这个节点在 v2rayN 里的别名（一字不差）、唯一允许的出口 IPv4、v2rayN 本地端口（默认 10808）和第二本地端口（默认 10809）。
3. **在 v2rayN 里完成接入（两次粘贴）：**
   - 点「复制网关节点链接」，在 v2rayN 服务器列表按 `Ctrl+V`（或「服务器 → 从剪贴板导入分享链接」）。会新增 HTTP 节点 `GuardNookShare-Gateway`（`127.0.0.1`、网关端口，默认 19904，用户名 `claude-guard`，密码已带上）。不要把它设为活动服务器。链接是 v2rayN 自己的 `v2rayn://http/…` 格式（v2rayN 不把 `http://` 链接当节点，而是当订阅地址），含本机凭据，2 分钟后清空剪贴板。导入失败时可手动添加 HTTP 服务器，密码点「复制网关密码」。
   - 在「设置 → 参数设置」里开启第二个本地监听端口（本地端口 + 1）。守护网关经它连到固定出口。
   - 点「复制路由规则」，在「路由设置 → 规则列表 → 从剪贴板中导入规则」，提示时选「是」（追加；选「否」会替换全部规则）。导入的规则在列表末尾：从最后一条 ClaudeGuard 规则起逐条「上移至顶」，保持启用。
   - 内核选 sing-box，开启 TUN。
   - 回到「Claude 守护」点「启用保护」。

判断方式与 Clash 路线相同：固定出口、守护规则和实测 IPv4 连续验证通过才放行。不同点：sing-box 下 ClaudeGuard 不切换任何选择器，只靠本机守护网关拦截；TUN 状态读自 v2rayN 生成的配置文件，读不到时保持阻断；排在 ClaudeGuard 规则前面、可能接走 Claude 流量的规则会让守护保持阻断。直接用 sing-box（不用 v2rayN）的人可以在第 3 步「复制 sing-box 片段」手动合并。

## 其他页面

- **Claude 守护**：状态、主操作、保护进度、关键数字，以及「连接检查」清单（Clash 控制接口、TUN、守护规则、入口节点、SOCKS5 出口、守护链路出口、IPv6、Claude DNS）和诊断工具。
- **这台电脑的网络**（在「Claude 守护」页标题区下方，四张渐变卡片）：分别实测 Claude 守护通道（只在放行后）和这台电脑的系统网络（Codex、IPv4、Cloudflare）。打开守护页时自动测一次，2 分钟后过期再测。浏览器 WebRTC 请在实际使用的浏览器里自检。
- **环境**：对照目标检查时区、国家或地区、区域格式、显示语言、各物理网卡的 IPv6、系统 DNS 是否 Fake-IP、Clash TUN 和公网出口国家。可以一键修复时区、国家或地区、区域格式和网卡 IPv6（IPv6 需要管理员授权），修复前自动保存恢复点，可从最新一条开始恢复。显示语言只给指引。守护要求 TUN 而 Clash 没有接管 IPv6 时，开着的网卡 IPv6 视为放行条件。
- **日志**：Clash 内核当前可见的 Claude 连接。
- **设置**：外观（浅色 / 深色）、开机自动启动、快捷键说明。外观切换立即生效，标题栏和系统按钮一起换色，下次启动直接以所选外观打开；保存在 `%APPDATA%\GuardNook Share\appearance.json`。

## 构建及验证

需要 Node.js 22.12+ 和 pnpm。以下命令在 `apps/guardnook-windows` 下运行。

```sh
pnpm install --frozen-lockfile
pnpm test                 # = node --test tests/*.test.mjs
pnpm run dev              # 开发模式，守护核心直接读 ../../packages/guard-core
pnpm run dev -- --smoke-test
pnpm run package:zip      # 只打免安装 ZIP
pnpm run package:win      # 安装包 + ZIP
```

`scripts/stage.mjs` 打包前把 `packages/guard-core` 复制到 `staged/GuardCore`（不含测试和样例）。`staged/` 每次打包重新生成，不随源码提交。共用守护核心的测试在 `packages/guard-core` 下运行 `node --test *.test.mjs`。

任务栏渲染、TUN、Clash Verge 实际导入、v2rayN（sing-box）接入、PowerShell 环境修复和真实 Claude 连接仍待 Windows 真机验收。
