<div align="center">

<img src="apps/guardnook/Assets/AppIcon.png" width="72" alt="ClaudeGuard" />

# ClaudeGuard for macOS

**让经过守护通道的 Claude 流量走你指定的固定出口。出口变化时，守护会断开连接。**

一个跑在本机的小守护：校验你的代理客户端规则和真实出口 IP，全部对上才放行 Claude 的流量；任何一项对不上就阻断，不回退、不偷偷换线路。

1.0.0 · macOS 15+ · Clash Verge Rev / Mihomo

</div>

> [!WARNING]
> 1.0.0 已完成 Universal 编译和打包。真实公网固定出口和系统 TUN 联动仍待验证。

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

1. **接入**：ClaudeGuard 为你的代理客户端生成一段守护规则。你可以手动导入，或在向导中选择写入 Clash Verge 全局扩展脚本或独立订阅。
2. **校验**：通过代理客户端的控制接口检查规则模式、守护规则、固定出口节点、TUN 状态（当配置要求启用时），再用独立探测确认**真实出口 IPv4 == 你填的那个 IP**。
3. **放行**：连续多次通过后，本机网关才在一个短时间窗口内放行；每个新连接都会重新检查。
4. **阻断**：出口变化、规则被改、控制接口失联、要求启用的 TUN 被关闭、验证过期或你手动阻断，网关立即关闭受管连接，**不回退到其他线路**。退出 ClaudeGuard 后，受保护的 Claude 流量同样连不出去。

只拦进入守护通道的流量，不是系统防火墙，不影响你的其他网络。

## 功能

| | |
|---|---|
| **Claude 守护** | 一眼看到是否在保护：放行 / 验证中 / 阻断 / 未配置。一键重新验证、立即阻断。 |
| **接入向导** | 识别客户端、选固定出口并导入规则。也可只使用基础监测。 |
| **SOCKS5 中转** | 用 Clash 里的节点做入口，接到你自己的固定出口 SOCKS5。可多选候选入口（手动切换，不自动故障转移）。 |
| **这台电脑的网络** | 分别实测守护通道和系统网络的出口。 |
| **环境检查与修复** | 时区、地区、区域格式、显示语言、网卡 IPv6、DNS Fake-IP、TUN。可一键修复，修复前自动保存恢复点。 |
| **日志** | 查看代理内核当前可见的 Claude 连接。 |
| **外观** | 深色顶部悬浮面板。 |

## 支持的代理客户端

| 客户端 | 状态 | 接入方式 |
|---|---|---|
| Clash Verge Rev | 主路线 | 复制扩展脚本 → 全局扩展脚本 → 重载 |
| Mihomo | 支持 | 同上，手动填写控制接口 |

ClaudeGuard 不提供节点、订阅或线路。你需要自己有一个固定 IP 的出口。

## 下载与安装

macOS 安装包正在重新打包，暂未提供下载。这不是正式稳定版，不建议在生产环境依赖。也可在本平台源码目录本地构建，产物位于 `dist/`。总览见[仓库首页](../../README.md)。

适用于 macOS 15+，支持 Apple Silicon 和 Intel。打开 DMG，将 `ClaudeGuard.app` 拖入「应用程序」。安装包未公证。接入和恢复说明见 [macOS 使用指南](apps/guardnook/README.md)。

## 从源码构建

需要 Node.js 22+、Python 3 和 Xcode 命令行工具。OpenNook 源码随仓库提供。以下命令从本平台源码目录 `source/Claudeguard-macos/` 运行（不要从整个仓库的最外层运行）。

```sh
(cd packages/guard-core && node --test *.test.mjs)
python3 apps/guardnook/Scripts/package-macos.py
```

构建产物位于 `dist/`，包括 DMG、应用 ZIP 和 SHA-256 校验文件。版本和内部构建号定义在 [release-version.json](apps/guardnook/Scripts/release-version.json)。

## 仓库结构

```
packages/guard-core     共用守护核心（Node）：配置、规则校验、出口探测、网关、诊断、环境修复
apps/guardnook          macOS 版：SwiftUI / AppKit + OpenNook 悬浮面板，内嵌 Node 运行核心
docs/                   测试报告
```

## 隐私与安全

- 配置和日志保存在本机。出口检测会访问公开的网络探测地址。
- 日志会对凭据和本机路径做脱敏。
- 生成的规则含本机凭据，只供本机导入。
- 判断偏严格：读不到、对不上、超时、格式变化，一律保持阻断。

## 当前状态

| 项 | 状态 |
|---|---|
| 守护核心 | 206 项通过，包含真实 Mihomo 的本地隔离测试 |
| macOS 版 | Apple Silicon 和 Intel 已完成编译和打包。真实公网固定出口、系统 TUN 和界面联动仍待验证 |
| Clash Verge Rev / Mihomo | 已在真实 Mihomo 内核上验证本地监测、放行、阻断和恢复 |


详细结果见[核心网络测试报告](docs/核心网络测试报告.md)，版本记录见[变更记录](CHANGELOG.md)。

## 局限

- 只保护进入守护通道的流量，不是系统级防火墙。
- 不是系统服务：退出应用即停止网关，受保护流量随之阻断。
- 多个候选入口不会自动故障转移，需要在代理客户端里手动切换。
- 浏览器 WebRTC 泄露请在你实际使用的浏览器里自检。

## 致谢

- macOS 悬浮面板基于 [OpenNook](apps/guardnook/Vendor/OpenNook)。
- 状态小螃蟹致敬 Claude 的 Clawd。

## 许可证

项目发布许可待确认。仓库随附[已有许可文本](LICENSE)及第三方授权说明。
