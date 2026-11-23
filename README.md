<div align="center">

<img src="source/Claudeguard-macos/apps/guardnook/Assets/AppIcon.png" width="72" alt="ClaudeGuard" />

# ClaudeGuard

**让经过守护通道的 Claude 流量走你指定的固定出口。出口变化时，守护会断开连接。**

一个跑在本机的小守护：校验你的代理客户端规则和真实出口 IP，全部对上才放行 Claude 的流量；任何一项对不上就阻断，不回退、不偷偷换线路。

1.0.0 · macOS 15+ · Windows 10 / 11 x64 · Clash Verge Rev / Mihomo · Windows 另有实验性 v2rayN（sing-box 内核）

</div>

> [!WARNING]
> 1.0.0 是预发布测试版，**不建议在生产环境依赖**。已提供 macOS Universal 安装包（临时签名、未经 Apple 公证）和 Windows x64 安装包（未签名，尚未在真实 Windows 设备上完整验收）。真实公网固定出口、系统 TUN 和应用联动仍待验证。

---

## 为什么做这个

如果你的网络环境不稳定，Claude 的连接可能在不知不觉中换了出口：节点自动切换、订阅更新、TUN 被关掉、IPv6 绕了出去。代理客户端只管「能连上」，不管「从哪儿连出去」。

ClaudeGuard 只管后者：**经过守护通道的 Claude 流量只允许走一个固定出口 IPv4，验证不过就不放行（fail-closed）。**

## 它怎么工作

```
Claude 客户端 ──► 你的代理客户端（守护规则）──► ClaudeGuard 本机网关 ──► 固定出口 ──► Claude
                         │                               ▲
                         └── 代理控制接口────────────┘ 持续校验
```

1. **接入**：ClaudeGuard 为你的代理客户端生成一段守护规则。macOS 可手动导入，或在向导中选择写入 Clash Verge 全局扩展脚本或独立订阅。Windows 以 Clash 扩展脚本，或 v2rayN（sing-box）的节点加路由规则形式提供，由你粘贴导入，不会改写或重启你的代理客户端。
2. **校验**：通过代理客户端的控制接口检查规则模式、守护规则、固定出口节点，以及配置要求启用时的 TUN 状态，再用独立探测确认**真实出口 IPv4 == 你填的那个 IP**。
3. **放行**：连续多次通过后，本机网关才在一个短时间窗口内放行；每个新连接都会重新检查。
4. **阻断**：出口变化、规则被改、控制接口失联、要求启用的 TUN 被关闭、验证过期或你手动阻断，网关立即关闭受管连接，**不回退到其他线路**。退出 ClaudeGuard 后，受保护的 Claude 流量同样连不出去。

只拦进入守护通道的流量，不是系统防火墙，不影响你的其他网络。

## 功能

| 功能 | 说明 | 平台 |
|---|---|---|
| **Claude 守护** | 一眼看到是否在保护：放行 / 验证中 / 阻断 / 未配置。一键重新验证、立即阻断。 | macOS、Windows |
| **接入向导** | 识别客户端、选固定出口并导入规则。也可只使用基础监测。 | macOS、Windows（接入方式见上） |
| **SOCKS5 中转** | 用 Clash 里的节点做入口，接到你自己的固定出口 SOCKS5。可多选候选入口（手动切换，不自动故障转移）。 | macOS、Windows |
| **这台电脑的网络** | 分别实测守护通道和系统网络的出口。 | macOS、Windows |
| **环境检查与修复** | 时区、地区、区域格式、显示语言、网卡 IPv6、DNS Fake-IP、TUN。可一键修复，修复前自动保存恢复点。 | macOS、Windows |
| **日志** | 查看代理内核当前可见的 Claude 连接。 | macOS、Windows |
| **外观** | macOS 为深色顶部悬浮面板；Windows 默认浅色，可在设置里切换深色。 | 见说明 |

ClaudeGuard 不提供节点、订阅或线路。你需要自己有一个固定 IP 的出口。

## 支持的代理客户端

| 客户端 | 平台 | 状态 | 接入方式 |
|---|---|---|---|
| Clash Verge Rev | macOS、Windows | 主路线 | 复制扩展脚本 → 全局扩展脚本 → 重载；macOS 向导还可写入全局扩展脚本或独立订阅 |
| Mihomo | macOS、Windows | 支持 | 同上，手动填写控制接口 |
| v2rayN（sing-box 内核） | 仅 Windows | 实验性，未在真机验证 | 粘贴网关节点链接 + 从剪贴板导入路由规则 |
| v2rayN（Xray 内核） | Windows 亦不支持 | 不支持 | Xray 没有 Clash API |

macOS 应用不提供 v2rayN 接入界面。使用说明见 [macOS README](source/Claudeguard-macos/README.md)、[macOS 使用指南](source/Claudeguard-macos/apps/guardnook/README.md)、[Windows README](source/Claudeguard-windows/README.md) 和 [Windows 使用指南](source/Claudeguard-windows/apps/guardnook-windows/README.md)。

## 下载与安装

安装包已作为 **v1.0.0 预发布测试版** 发布，见 [GitHub Release](https://github.com/xinghaoshi-ux/Claudeguard/releases/tag/v1.0.0)。这不是正式稳定版，**不建议在生产环境依赖**。

- macOS 15+ Universal（Apple Silicon arm64 与 Intel x86_64）：[DMG](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-macos-universal.dmg) 或 [应用 ZIP](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-macos-universal.zip)。安装包为临时（ad-hoc）签名，**未经 Apple 公证**。系统可能在首次打开时拦截，请按 macOS 的「系统设置 → 隐私与安全性」提示确认，不要关闭或绕过系统安全机制。打开 DMG，将 `ClaudeGuard.app` 拖入「应用程序」。
- Windows 10 / 11 x64：[便携 ZIP](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-windows-x64.zip) 或 [安装程序](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-windows-x64-setup.exe)。安装包**未签名**，且**尚未在真实 Windows 设备上完整验收**。系统或浏览器可能提示来源不明，请自行判断风险。完整解压便携 ZIP 后运行 `ClaudeGuard.exe`，或使用安装程序。

下载后可用 [`SHA256SUMS.txt`](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/SHA256SUMS.txt) 核对完整性。校验只说明文件在传输中未被改动，不能证明发布者身份。

## 源码入口

本仓库以解压后的源码目录发布，同时包含 macOS 和 Windows 两个平台，互不替代。在对应平台目录内构建和测试，不要把本仓库最外层当作原来的单平台仓库根目录。

| 平台 | 目录 | 说明 |
| --- | --- | --- |
| macOS 15+ | [`source/Claudeguard-macos/`](source/Claudeguard-macos/) | Apple Silicon 与 Intel Universal。使用说明与本地构建见该目录 [README](source/Claudeguard-macos/README.md)。 |
| Windows 10 / 11 x64 | [`source/Claudeguard-windows/`](source/Claudeguard-windows/) | 便携包与安装程序的源码。使用说明与本地构建见该目录 [README](source/Claudeguard-windows/README.md)。 |

## 从源码构建

先进入对应平台目录，再运行该目录 README 中的命令，不要从本仓库最外层直接执行旧的 `apps/` 或 `packages/` 路径。

**macOS** 需要 Node.js 22+、Python 3 和 Xcode 命令行工具。OpenNook 源码随仓库提供。

```sh
cd source/Claudeguard-macos
(cd packages/guard-core && node --test *.test.mjs)
python3 apps/guardnook/Scripts/package-macos.py
```

产物位于 `source/Claudeguard-macos/dist/`，包括 DMG、应用 ZIP 和 SHA-256 校验文件。版本定义在 [release-version.json](source/Claudeguard-macos/apps/guardnook/Scripts/release-version.json)。

**Windows** 需要 Node.js 22.12+ 和 pnpm。

```sh
cd source/Claudeguard-windows
(cd packages/guard-core && node --test *.test.mjs)
cd apps/guardnook-windows
pnpm install --frozen-lockfile
pnpm test
pnpm run package:win
```

产物位于 `source/Claudeguard-windows/dist/`。只打包便携 ZIP 可运行 `pnpm run package:zip`。版本定义在 [package.json](source/Claudeguard-windows/apps/guardnook-windows/package.json)。交叉构建等细节见 [Windows README](source/Claudeguard-windows/README.md)。

## 仓库结构

```
source/Claudeguard-macos/
  packages/guard-core     守护核心（Node）：配置、规则校验、出口探测、网关、诊断、环境修复
  apps/guardnook          macOS 版：SwiftUI / AppKit + OpenNook 悬浮面板，内嵌 Node 运行核心
  docs/                   测试报告
source/Claudeguard-windows/
  packages/guard-core     同上核心在 Windows 源码树中的副本
  apps/guardnook-windows  Windows 版：Electron，主进程直接运行核心，渲染层通过受限 IPC 访问
  docs/                   测试报告
```

## 隐私与安全

- 配置和日志保存在本机。出口检测会访问公开的网络探测地址。
- 生成的规则含本机凭据，只供本机导入，不要分享。
- macOS 的日志与诊断导出有脱敏处理。
- 判断偏严格：读不到、对不上、超时、格式变化，一律保持阻断。

## 当前状态

| 项 | 状态 |
|---|---|
| 安装包 | 已作为 [v1.0.0 预发布测试版](https://github.com/xinghaoshi-ux/Claudeguard/releases/tag/v1.0.0) 公开发布，可用 [SHA256SUMS.txt](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/SHA256SUMS.txt) 校验 |
| macOS 版 | 已提供 Universal 安装包（临时签名、未公证）。本轮发布未重新进行 Swift 编译，也未做完整应用验收。真实公网固定出口、系统 TUN 和界面联动仍待验证 |
| Windows 版 | 已提供 x64 便携包和安装程序，未签名，尚未在真实 Windows 设备上完整验收。代理导入、系统 TUN 和应用联动仍待验证 |
| Clash Verge Rev / Mihomo | 仓库内测试报告记录了在真实 Mihomo 内核上的本地隔离测试。Windows 客户端导入待验证 |
| v2rayN / sing-box | 仅 Windows 应用提供该接入。仓库内测试报告记录了针对 sing-box 的本地集成测试。v2rayN 的节点、路由导入和系统 TUN 待真机验证 |

上述测试结果引自仓库内既有报告，不是本轮重新跑过的结论，也不能替代完整应用验收。详细记录见 [macOS 核心网络测试报告](source/Claudeguard-macos/docs/核心网络测试报告.md) 与 [Windows 核心网络测试报告](source/Claudeguard-windows/docs/核心网络测试报告.md)（两份内容相同），版本记录见 [macOS 变更记录](source/Claudeguard-macos/CHANGELOG.md) 和 [Windows 变更记录](source/Claudeguard-windows/CHANGELOG.md)。

## 局限

- 只保护进入守护通道的流量，不是系统级防火墙。
- 不是系统服务：退出应用即停止网关，受保护流量随之阻断。
- 多个候选入口不会自动故障转移，需要在代理客户端里手动切换。
- 浏览器 WebRTC 泄露请在你实际使用的浏览器里自检。

## 致谢

- macOS 悬浮面板基于 [OpenNook](source/Claudeguard-macos/apps/guardnook/Vendor/OpenNook)。
- [Windows 界面字体授权说明](source/Claudeguard-windows/apps/guardnook-windows/renderer/fonts/README.md)。
- 状态小螃蟹致敬 Claude 的 Clawd。

## 许可证

项目发布许可待确认。各平台目录随附已有许可文本及第三方说明，见 [macOS LICENSE](source/Claudeguard-macos/LICENSE) 与 [Windows LICENSE](source/Claudeguard-windows/LICENSE)。这些随附文本不能理解为已对本项目作出完整的发布授权声明。
