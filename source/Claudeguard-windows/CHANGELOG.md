# 变更记录

## 1.0.2

- 仅 Windows 更新。macOS 请继续使用 1.0.0。
- 界面：重做多选、输入框、复选框、单选和分段控件的选中态与焦点态，并加入微动效；Clawd 动效系统按 120ms 节拍重做。
- 修复 Windows TUN 和 SOCKS5 检查，并增加 Windows 演示视频。
- 删除未被应用使用的公司内网中继与 usage fixture（Windows 与 macOS 的 guard-core 源码均已清理，本版不重新打包 macOS 安装包）。
- 安装包仍未签名，且尚未在真实 Windows 设备上验收。

## 1.0.1

- 仅 Windows 更新。macOS 请继续使用 1.0.0。
- 支持在 Clash Verge Rev 退出后，通过向导导入独立本地订阅。
- 安装包仍未签名，且尚未在真实 Windows 设备上验收。

## 1.0.0

- 首个独立 Windows x64 发布版本，保留守护、环境、日志、设置及浅色和深色外观。
- 支持 Clash Verge Rev / Mihomo、SOCKS5 中转，以及 v2rayN 的 sing-box 固定出口接入。
- 提供便携 ZIP 和安装程序。v2rayN 导入、系统 TUN 及客户端联动仍待 Windows 真机验证。
