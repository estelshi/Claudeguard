# ClaudeGuard

让经过守护通道的 Claude 流量走你指定的固定出口。出口变化时，守护会断开连接。

本仓库以解压后的源码目录发布，同时包含 macOS 和 Windows 两个平台，互不替代。

## 源码入口

| 平台 | 目录 | 说明 |
| --- | --- | --- |
| macOS 15+ | [`source/Claudeguard-macos/`](source/Claudeguard-macos/) | Apple Silicon 与 Intel Universal。使用说明与本地构建见该目录 [README](source/Claudeguard-macos/README.md)。 |
| Windows 10 / 11 x64 | [`source/Claudeguard-windows/`](source/Claudeguard-windows/) | 便携包与安装程序的源码。使用说明与本地构建见该目录 [README](source/Claudeguard-windows/README.md)。 |

在对应平台目录内构建和测试，不要把本仓库最外层当作原来的单平台仓库根目录。

## 下载

安装包已作为 **v1.0.0 预发布测试版** 发布，见 [GitHub Release](https://github.com/xinghaoshi-ux/Claudeguard/releases/tag/v1.0.0)。这不是正式稳定版，**不建议在生产环境依赖**。

- macOS 15+ Universal（Apple Silicon arm64 与 Intel x86_64）：[DMG](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-macos-universal.dmg) 或 [应用 ZIP](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-macos-universal.zip)。安装包为临时签名，未公证。
- Windows 10 / 11 x64：[便携 ZIP](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-windows-x64.zip) 或 [安装程序](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/ClaudeGuard-1.0.0-windows-x64-setup.exe)。安装包未签名，且尚未在真机验收。

下载后可用 [`SHA256SUMS.txt`](https://github.com/xinghaoshi-ux/Claudeguard/releases/download/v1.0.0/SHA256SUMS.txt) 核对完整性。也可按上面的平台 README 在本地构建。

## 当前状态

两套源码均为 1.0.0。真实公网固定出口、系统 TUN 和应用联动仍待验证；Windows 的代理导入和 v2rayN 相关步骤也尚未在真机验收。详细说明见各平台 README 与测试报告。

## 许可证

项目发布许可待确认。各平台目录随附已有许可文本和第三方说明。
