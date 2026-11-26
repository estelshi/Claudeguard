import NookApp
import ServiceManagement
import SwiftUI

/// UserDefaults key for 菜单栏显示 Clawd (default on).
let guardMenuBarClawdKey = "guardnook.showsMenuBarClawd"

/// 设置: the gear's page, replacing the framework Settings screen (main.swift
/// `setSettings`). Fixed exit summary, maintenance, and the few general switches.
/// No version number, no display / pin pickers.
struct GuardSettingsPage: View {
    @ObservedObject private var loginItem = GuardLoginItem.shared
    @State private var showsMenuBarClawd = UserDefaults.standard.object(forKey: guardMenuBarClawdKey) as? Bool ?? true
    @State private var showingMaintenance = false
    @State private var allowUURemote = GuardSettings.current?.allowUURemote ?? false
    @State private var uuRemoteBusy = false
    @State private var uuRemoteNote: String?

    var body: some View {
        Group {
            if showingMaintenance {
                maintenancePage
            } else {
                mainPage
            }
        }
        .padding(.horizontal, GuardMetrics.horizontal)
        .padding(.top, GuardMetrics.top)
        .padding(.bottom, GuardMetrics.bottom)
        .frame(maxWidth: .infinity)
        .frame(height: GuardMetrics.contentHeight, alignment: .topLeading)
        .background(GuardPanelBackground())
        .onAppear { loginItem.refresh() }
        .onChange(of: showsMenuBarClawd) { _, visible in
            UserDefaults.standard.set(visible, forKey: guardMenuBarClawdKey)
            GuardStatusMenu.shared.setMenuBarVisible(visible)
        }
    }

    private var mainPage: some View {
        VStack(alignment: .leading, spacing: 0) {
            GuardPageHeader(title: "设置", subtitle: "守护在后台持续运行，收起面板不影响保护")
            Spacer().frame(height: GuardMetrics.section)
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    VStack(spacing: 0) {
                        row(title: "固定出口", detail: exitSummary) {
                            Button(GuardSettings.current == nil ? "开始配置" : "修改配置") { GuardSetupWindow.show() }
                                .buttonStyle(GuardPillButtonStyle())
                                .accessibilityIdentifier("guard.settings.setup")
                        }
                        divider
                        row(title: "允许 UU 远程直连", detail: uuRemoteNote ?? uuRemoteDetail) {
                            Toggle("允许 UU 远程直连", isOn: Binding(
                                get: { allowUURemote },
                                set: { setUURemote($0) }
                            ))
                            .labelsHidden()
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .disabled(uuRemoteBusy || GuardSettings.current?.relay == nil)
                            .accessibilityIdentifier("guard.settings.uuRemote")
                        }
                        divider
                        row(title: "维护与恢复", detail: "解除 Clash 接入、诊断包、手动更新与环境恢复") {
                            Button("打开") { showingMaintenance = true }
                                .buttonStyle(GuardPillButtonStyle())
                                .accessibilityIdentifier("guard.settings.maintenance")
                        }
                    }
                    .padding(.horizontal, 16)
                    .guardCard()
                    Spacer().frame(height: GuardMetrics.gap)
                    VStack(spacing: 0) {
                        row(title: "登录时启动", detail: loginDetail) {
                            if loginItem.status == .requiresApproval {
                                Button("打开登录项") { SMAppService.openSystemSettingsLoginItems() }
                                    .buttonStyle(GuardPillButtonStyle())
                            }
                            Toggle("登录时启动", isOn: Binding(
                                get: { loginItem.isEnabled },
                                set: { loginItem.setEnabled($0) }
                            ))
                            .labelsHidden()
                            .toggleStyle(.switch)
                            .controlSize(.small)
                        }
                        divider
                        row(title: "启动时自动验证并启用保护", detail: startupDetail) {
                            Text(GuardSettings.current?.startProtected == true ? "已开启" : "未开启")
                                .font(GuardFont.meta)
                                .foregroundStyle(GuardInk.tertiary)
                        }
                        divider
                        row(title: "菜单栏显示 Clawd", detail: "面板收起时，在菜单栏看守护状态") {
                            Toggle("菜单栏显示 Clawd", isOn: $showsMenuBarClawd)
                                .labelsHidden()
                                .toggleStyle(.switch)
                                .controlSize(.small)
                        }
                    }
                    .padding(.horizontal, 16)
                    .guardCard()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: .infinity)
        }
    }

    /// Maintenance opens in place rather than as a sheet: its own confirmations are sheets.
    private var maintenancePage: some View {
        VStack(alignment: .leading, spacing: 0) {
            GuardPageHeader(title: "维护与恢复", subtitle: "卸载前先解除连接；所有更改都会保留恢复点") {
                Button {
                    showingMaintenance = false
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left").font(GuardFont.make(10, .semibold))
                        Text("设置")
                    }
                }
                .buttonStyle(GuardPillButtonStyle())
            }
            Spacer().frame(height: GuardMetrics.section)
            ScrollView(.vertical, showsIndicators: false) {
                GuardMaintenanceView()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .frame(maxHeight: .infinity)
            .guardCard()
        }
    }

    private var divider: some View {
        Rectangle().fill(GuardInk.hairline).frame(height: 1)
    }

    private func row<Trailing: View>(title: String, detail: String, @ViewBuilder trailing: () -> Trailing) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(GuardFont.make(12.5, .semibold))
                    .foregroundStyle(GuardInk.primary)
                    .lineLimit(1)
                Text(detail)
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(detail)
            }
            Spacer(minLength: 8)
            trailing()
        }
        .padding(.vertical, 12)
    }

    private var exitSummary: String {
        guard let settings = GuardSettings.current else {
            return GuardSettings.isMonitoring ? "基础监测中 · 尚未设定固定出口" : "尚未设定固定出口"
        }
        if let relay = settings.relay {
            let entries = relay.keyword.isEmpty ? relay.nodes.joined(separator: "、") : "关键词「\(relay.keyword)」"
            var parts = ["\(entries.isEmpty ? "入口节点" : entries) → SOCKS5 \(relay.host)"]
            if relay.auth { parts.append("凭据在钥匙串") }
            return parts.joined(separator: " · ")
        }
        var parts: [String] = []
        if let node = settings.selectedProxy, !node.isEmpty { parts.append("节点 \(node)") }
        if let ip = settings.expectedIP { parts.append("固定出口 \(ip)") }
        return parts.isEmpty ? "已配置" : parts.joined(separator: " · ")
    }

    private var loginDetail: String {
        if let error = loginItem.errorMessage { return error }
        return loginItem.status == .requiresApproval
            ? "请在系统设置的「登录项」中允许 ClaudeGuard 启动"
            : "登录 macOS 后自动启动 ClaudeGuard"
    }

    private var uuRemoteDetail: String {
        "仅 UU 远程进程绕过固定出口，Claude 不受影响。修改后需重新应用配置。"
    }

    /// Saves the preference through setup.mjs. The rules live in the standalone
    /// profile, so the change only takes effect after 应用配置 regenerates it.
    @MainActor private func setUURemote(_ wanted: Bool) {
        guard !uuRemoteBusy, wanted != allowUURemote else { return }
        let before = allowUURemote
        allowUURemote = wanted
        uuRemoteBusy = true
        uuRemoteNote = nil
        Task {
            do {
                let reply = try await Task.detached {
                    try GuardRuntime.helper(["operation": "set-uu-remote", "allowUURemote": wanted])
                }.value
                allowUURemote = reply.allowUURemote ?? wanted
                if reply.needsReapply == true {
                    uuRemoteNote = "已保存。请在「修改配置」里重新应用配置后生效。"
                }
                GuardLogModel.shared.record(.configuration, .success, wanted ? "已允许 UU 远程直连" : "已关闭 UU 远程直连")
            } catch {
                allowUURemote = before
                uuRemoteNote = error.localizedDescription
                GuardLogModel.shared.record(.configuration, .error, "UU 远程直连设置未保存", detail: error.localizedDescription)
            }
            uuRemoteBusy = false
        }
    }

    private var startupDetail: String {
        GuardSettings.current == nil ? "配置固定出口后可用" : "与登录时启动独立；在配置向导的端口与原始脚本里修改"
    }
}
