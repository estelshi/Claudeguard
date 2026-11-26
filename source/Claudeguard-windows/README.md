<div align="center">

<img src="apps/guardnook-windows/renderer/assets/icon.svg" width="72" alt="ClaudeGuard" />

# ClaudeGuard for Windows

**让经过守护通道的 Claude 流量走你指定的固定出口。出口变化时，守护会断开连接。**

一个跑在本机的小守护：校验你的代理客户端规则和真实出口 IP，全部对上才放行 Claude 的流量；任何一项对不上就阻断，不回退、不偷偷换线路。

1.0.2 · Windows 10 / 11 x64 · Clash Verge Rev / Mihomo · v2rayN（sing-box 内核）

</div>

> [!WARNING]
> 1.0.2 已生成 Windows x64 便携包和安装程序。安装包未签名，尚未在真实 Windows 设备上完整验收。真实 Windows 上的代理导入、系统 TUN 和应用联动仍待验证。

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

1. **接入**：ClaudeGuard 为代理客户端生成守护规则。Clash Verge Rev 可在退出后通过向导导入独立订阅，也支持手动导入扩展脚本。v2rayN 使用手动导入的节点和路由规则。
2. **校验**：通过代理客户端的控制接口检查规则模式、守护规则、固定出口节点、TUN 状态，再用独立探测确认**真实出口 IPv4 == 你填的那个 IP**。
3. **放行**：连续多次通过后，本机网关才在一个短时间窗口内放行；每个新连接都会重新检查。
4. **阻断**：出口变化、规则被改、控制接口失联、TUN 关闭、验证过期或你手动阻断，网关立即关闭受管连接，**不回退到其他线路**。退出 ClaudeGuard 后，受保护的 Claude 流量同样连不出去。

只拦进入守护通道的流量，不是系统防火墙，不影响你的其他网络。

## 功能

| | |
|---|---|
| **Claude 守护** | 一眼看到是否在保护：放行 / 验证中 / 阻断 / 未配置。一键重新验证、立即阻断。 |
| **三步接入向导** | 自动识别客户端控制接口 → 选固定出口 → 复制规则导入，右侧清单实时变绿。 |
| **SOCKS5 中转** | 用 Clash 里的节点做入口，接到你自己的固定出口 SOCKS5。可多选候选入口（手动切换，不自动故障转移）。 |
| **这台电脑的网络** | 分别实测守护通道和系统网络的出口。 |
| **环境检查与修复** | 时区、地区、区域格式、显示语言、网卡 IPv6、DNS Fake-IP、TUN。可一键修复，修复前自动保存恢复点。 |
| **日志** | 查看代理内核当前可见的 Claude 连接。 |
| **外观** | 浅色默认，可在设置里切换深色。 |

## 支持的代理客户端

| 客户端 | 状态 | 接入方式 |
|---|---|---|
| Clash Verge Rev | 主路线 | 一键导入独立订阅，或手动导入全局扩展脚本 |
| Mihomo | 支持 | 手动填写控制接口并导入扩展脚本 |
| v2rayN（sing-box 内核） | 实验性，未在真机验证 | 粘贴网关节点链接 + 从剪贴板导入路由规则 |
| v2rayN（Xray 内核） | 不支持 | Xray 没有 Clash API |

ClaudeGuard 不提供节点、订阅或线路。你需要自己有一个固定 IP 的出口。

## 下载与安装

安装包已作为 **v1.0.2 预发布测试版** 发布，见 [GitHub Release](https://github.com/estelshi/Claudeguard/releases/tag/v1.0.2)，可下载 [便携 ZIP](https://github.com/estelshi/Claudeguard/releases/download/v1.0.2/ClaudeGuard-1.0.2-windows-x64.zip) 或 [安装程序](https://github.com/estelshi/Claudeguard/releases/download/v1.0.2/ClaudeGuard-1.0.2-windows-x64-setup.exe)。可用 [SHA256SUMS.txt](https://github.com/estelshi/Claudeguard/releases/download/v1.0.2/SHA256SUMS.txt) 核对完整性。这不是正式稳定版，不建议在生产环境依赖。macOS 安装包正在重新打包。也可在本平台源码目录本地构建，产物位于 `dist/`。总览见[仓库首页](../../README.md)。

适用于 Windows 10 / 11 x64。完整解压 `ClaudeGuard-1.0.2-windows-x64.zip` 后运行 `ClaudeGuard.exe`，也可使用 `ClaudeGuard-1.0.2-windows-x64-setup.exe`。发布包未签名。Clash 扩展脚本与 v2rayN 节点和路由导入步骤见 [Windows 使用指南](apps/guardnook-windows/README.md)。

## 从源码构建

需要 Node.js 22.12+ 和 pnpm。以下命令从本平台源码目录 `source/Claudeguard-windows/` 运行（不要从整个仓库的最外层运行）。

```sh
(cd packages/guard-core && node --test *.test.mjs)
cd apps/guardnook-windows
pnpm install --frozen-lockfile
pnpm test
pnpm run package:win
```

构建产物位于本平台源码目录的 `dist/`。只打包便携 ZIP 可运行 `pnpm run package:zip`。在 macOS 交叉构建安装程序时，从纯英文路径运行 `pnpm run package:win --config.toolsets.nsis=1.2.1`。版本定义在 [package.json](apps/guardnook-windows/package.json)。

## 仓库结构

```
packages/guard-core     共用守护核心（Node）：配置、规则校验、出口探测、网关、诊断、环境修复
apps/guardnook-windows  Windows 版：Electron，主进程直接运行核心，渲染层通过受限 IPC 访问
docs/                   测试报告
```

## 隐私与安全

- 配置和日志保存在本机。出口检测会访问公开的网络探测地址。
- 网关凭据和控制接口密钥只在主进程使用，界面只显示「已读取」。日志不记录密码和密钥。
- 复制到剪贴板的规则 / 链接含本机凭据，2 分钟后自动清空。不要分享生成的脚本。
- 判断偏严格：读不到、对不上、超时、格式变化，一律保持阻断。

## 当前状态

| 项 | 状态 |
|---|---|
| 守护核心 | 206 项通过，包含真实 Mihomo 的本地隔离测试 |
| Windows 版 | 37 项应用测试通过。x64 ZIP 和安装程序已构建并核验完整性，未在真实 Windows 上验收 |
| Clash Verge Rev / Mihomo | 已在真实 Mihomo 内核上验证本地监测、放行、阻断和恢复。Windows 客户端导入待验证 |
| v2rayN / sing-box | 已在真实 sing-box 1.12.12 内核上通过本地集成测试。v2rayN 的节点、路由导入和系统 TUN 待真机验证 |


详细结果见[核心网络测试报告](docs/核心网络测试报告.md)，版本记录见[变更记录](CHANGELOG.md)。

## 局限

- 只保护进入守护通道的流量，不是系统级防火墙。
- 不是系统服务：退出应用即停止网关，受保护流量随之阻断。
- 多个候选入口不会自动故障转移，需要在代理客户端里手动切换。
- 浏览器 WebRTC 泄露请在你实际使用的浏览器里自检。

## 致谢

- [界面字体授权说明](apps/guardnook-windows/renderer/fonts/README.md)。
- 状态小螃蟹致敬 Claude 的 Clawd。

## 许可证

项目发布许可待确认。仓库随附[已有许可文本](LICENSE)及第三方授权说明。
