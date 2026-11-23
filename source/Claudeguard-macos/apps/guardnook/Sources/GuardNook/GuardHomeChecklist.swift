import AppKit
import NookApp
import SwiftUI

struct GuardProductOverview: View {
    @ObservedObject var model: GuardModel
    @StateObject private var setup = GuardSetupModel()
    @Environment(\.nookResolvedTheme) private var theme
    @State private var showingOptimization = false
    @State private var working = false
    @State private var operationNote: String?

    private enum Result {
        case passed, issue, pending, optional

        var symbol: String {
            switch self {
                case .passed: "checkmark.circle.fill"
                case .issue: "exclamationmark.circle.fill"
                case .pending: "minus.circle"
                case .optional: "circle"
            }
        }

        var accessibilityLabel: String {
            switch self {
                case .passed: "通过"
                case .issue: "需要处理"
                case .pending: "待检查"
                case .optional: "可选"
            }
        }
    }

    private var settings: GuardSettings? { GuardSettings.current }
    private var status: GuardStatus? { model.status }
    private var environment: SetupEnvironment? { setup.environment }
    private var tun: Bool? { status?.tunEnabled ?? environment?.tunEnabled }
    private var needsTun: Bool { settings?.requireTun == true && tun == false }
    private var canEnableTun: Bool { needsTun && settings?.deviceWide == true && setup.verge?.standalone?.selected == true }
    private var canCloseIPv6: Bool {
        guard settings != nil, environment?.controllerOnline == true, environment?.globalIPv6 == true,
              let services = environment?.services, !services.isEmpty else { return false }
        return services.allSatisfy { $0.mode != nil } && services.contains { $0.mode != "Off" }
    }
    private var canChangePreferences: Bool {
        settings != nil && environment?.controllerOnline == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            GuardHero(tone: GuardTone(model.verdict), headline: "连接检查", reason: model.verdict.headline) {
                Button(settings == nil ? "设置保护" : "打开配置") { GuardSetupWindow.show() }
                    .buttonStyle(GuardPillButtonStyle())
            }
            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 16) {
                    section("连通与保护", content: requiredRows)
                    section("可选优化", content: optionalRows)
                }
                .padding(.bottom, 2)
            }
            .frame(maxHeight: 330)
            HStack(spacing: 8) {
                if let operationNote {
                    Text(operationNote)
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(2)
                        .help(operationNote)
                }
                Spacer(minLength: 4)
                if working { ProgressView().controlSize(.small) }
                Button("重新检查") { Task { await recheck() } }
                    .buttonStyle(GuardPillButtonStyle())
                    .disabled(working)
                Button("一键优化") {
                    showingOptimization = true
                }
                .buttonStyle(GuardPillButtonStyle(prominent: true))
                .disabled(working)
            }
        }
        .font(.system(size: 11))
        .task(id: settings?.relay?.id ?? settings?.expectedIP ?? "") {
            await readEnvironment()
        }
        .nookSheet(isPresented: $showingOptimization) {
            GuardOptimizationSheet(
                enableTun: canEnableTun, needsTun: needsTun, closeIPv6: canCloseIPv6,
                hasIPv6: environment?.globalIPv6 == true,
                blockedReason: status?.phase == "blocked" && !needsTun ? status?.reasonText : nil,
                configured: settings != nil, preferences: preferenceOptions,
                onApply: { ids in Task { await optimize(preferences: ids) } }
            )
        }
        .nookKeepsExpanded(while: $showingOptimization)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            GuardSectionTitle(title: title)
            VStack(spacing: 0, content: content)
                .guardSurface(padding: 4, radius: 16)
        }
    }

    @ViewBuilder private func requiredRows() -> some View {
        let online = environment?.controllerOnline
        row("Clash 内核", online == true ? "在线" : online == false ? "无法连接 · 请打开 Clash" : "正在检查", result(online))
        row("TUN 网卡", tun == true ? "已开启" : tun == false ? (needsTun ? "需开启" : "已关闭") : "待确认",
            tun == false && !needsTun ? .optional : result(tun))
        row("守护规则", status?.prepared == true || setup.verge?.loaded == true ? "已载入"
            : settings == nil ? "等待接入" : "尚未确认载入", result(settings == nil ? nil : (status?.prepared == true || setup.verge?.loaded == true)))
        if settings?.relay != nil {
            stage("入口节点", key: "entry")
            stage("SOCKS5 连接", key: "exit")
        }
        let expected = settings?.expectedIP
        let actual = model.verdict.exitProbe?.ip
        row("Claude 出口 IPv4", actual ?? (status?.verifiedNow == true ? "等待入口实测" : "未放行 · 目标 \(expected ?? "未设置")"),
            result(actual.map { $0 == expected }))
        let priorIP = model.probes.dropLast().reversed().first { $0.viaGuard && $0.ip != nil }?.ip
        if let actual, let priorIP {
            row("出口与上次一致", actual == priorIP ? "一致" : "上次 \(priorIP)", result(actual == priorIP))
        } else {
            row("出口与上次一致", "等待两次守护实测", .pending)
        }
        row("Claude 守护", status?.headline ?? "等待守护状态", status?.verifiedNow == true ? .passed : status?.phase == "blocked" ? .issue : .pending)
            .help(status?.reasonText ?? "查看守护页获取实时状态。")
        row("Claude 服务可达性", model.verdict.exitProbe?.ok == true ? "经守护通道可达" : "待通道放行并实测",
            model.verdict.exitProbe?.ok == true ? .passed : .pending)
            .help("匿名网络请求只能验证连接。账号登录和 API 权限需在客户端确认。")
        let v6 = environment?.globalIPv6
        row("IPv6 出口", v6 == false ? "未检测到可用出口" : v6 == true ? "检测到可用出口" : "待确认", result(v6.map { !$0 }))
        let dns = model.diagnostics?.auditFresh == true ? model.diagnostics?.dns?.state : nil
        row("Claude DNS", dns == "configured" ? "配置已核对" : dns == "needs-review" ? "需检查配置" : "待核对",
            dns == "configured" ? .passed : dns == "needs-review" ? .issue : .pending)
    }

    private func stage(_ title: String, key: String) -> some View {
        let stage = status?.relay?.stages[key]
        return row(title, stage.map { $0.ok ? "通过" : "未通过" } ?? "等待检测", result(stage?.ok))
    }

    @ViewBuilder private func optionalRows() -> some View {
        row("时区", environment?.timezone ?? "待读取", environment?.timezone == "America/New_York" ? .passed : .optional)
        row("地区", environment?.locale ?? "待读取", environment?.locale == "en_US" ? .passed : .optional)
        row("Claude 语言", environment?.language ?? "沿用系统或未设定", environment?.language == "en-US" ? .passed : .optional)
        row("浏览器 WebRTC", "请在实际使用的浏览器里自检", .optional)
    }

    private func result(_ flag: Bool?) -> Result {
        guard let flag else { return .pending }
        return flag ? .passed : .issue
    }

    private func row(_ title: String, _ value: String, _ state: Result) -> some View {
        HStack(spacing: 8) {
            Image(systemName: state.symbol)
                .foregroundStyle(state == .passed ? theme.success : state == .issue ? theme.warning : theme.tertiaryLabel)
                .frame(width: 14)
                .accessibilityHidden(true)
            Text(title).font(.system(size: 11.5, weight: .medium)).foregroundStyle(theme.primaryLabel)
            Spacer(minLength: 8)
            Text(value).font(.system(size: 11)).foregroundStyle(theme.tertiaryLabel).lineLimit(1).truncationMode(.middle)
        }
        .padding(.horizontal, 10)
        .frame(minHeight: 30)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title)，\(value)，\(state.accessibilityLabel)")
    }

    private var preferenceOptions: [GuardOptimizationSheet.Preference] {
        guard canChangePreferences else { return [] }
        return [
            .init(id: "timezone", title: "时区", current: environment?.timezone, target: "America/New_York"),
            .init(id: "locale", title: "地区", current: environment?.locale, target: "en_US"),
            .init(id: "language", title: "Claude 语言", current: environment?.language, target: "en-US"),
        ]
    }

    private func readEnvironment() async {
        await setup.refreshHomeEnvironment()
        if settings?.relay != nil { await setup.refreshVerge() }
    }

    private func runChecks() async {
        model.refreshLocalNow()
        await readEnvironment()
        if settings != nil {
            await model.run(.inspect)
            await model.run(.audit)
        }
    }

    private func recheck() async {
        guard !working else { return }
        working = true
        operationNote = nil
        defer { working = false }
        await runChecks()
    }

    private func optimize(preferences: Set<String>) async {
        guard !working else { return }
        working = true
        operationNote = nil
        defer { working = false }
        let enableTun = canEnableTun
        let closeIPv6 = canCloseIPv6
        var notes: [String] = []
        if enableTun {
            await setup.applyDeviceExit()
            if let note = setup.message { notes.append(note) }
            await readEnvironment()
        }
        if closeIPv6 {
            await setup.disableIPv6()
            if let note = setup.message { notes.append(note) }
        }
        if !preferences.isEmpty && canChangePreferences {
            await setup.previewPreferences(only: preferences)
            if !setup.preferencePlan.isEmpty { await setup.applyPreferences() }
            if let note = setup.message { notes.append(note) }
        }
        await runChecks()
        operationNote = notes.isEmpty ? nil : notes.joined(separator: " ")
    }
}


private struct GuardOptimizationSheet: View {
    struct Preference: Identifiable {
        let id: String
        let title: String
        let current: String?
        let target: String

        var available: Bool { current != target }
        var detail: String {
            available ? "\(current ?? "沿用系统") → \(target)" : "已符合预设 · \(target)"
        }
    }

    let enableTun: Bool
    let needsTun: Bool
    let closeIPv6: Bool
    let hasIPv6: Bool
    let blockedReason: String?
    let configured: Bool
    let preferences: [Preference]
    let onApply: (Set<String>) -> Void
    @Environment(\.nookDismissPresentation) private var dismiss
    @Environment(\.nookResolvedTheme) private var theme
    @State private var selected: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("一键优化").font(.headline)
            Text("必优化项").font(.subheadline.weight(.semibold))
            if configured && !enableTun && !needsTun && !closeIPv6 && !hasIPv6 && blockedReason == nil {
                Text("当前没有需要自动处理的连通问题。").foregroundStyle(.secondary)
            }
            if enableTun {
                Label("自动开启 TUN · Clash 会短暂重启", systemImage: "network")
            } else if needsTun {
                Label("请在 Clash 开启 TUN，或先完成独立订阅接入。", systemImage: "network")
            }
            if closeIPv6 {
                Label("自动关闭网络服务的 IPv6 · 需要管理员授权", systemImage: "network.slash")
            } else if hasIPv6 {
                Label("请检查正在使用的 VPN 或网络服务的 IPv6 设置。", systemImage: "network.slash")
            }
            if let blockedReason {
                Text(blockedReason).foregroundStyle(.secondary)
            }
            if !preferences.isEmpty {
                Divider()
                Text("可选优化项").font(.subheadline.weight(.semibold))
                Text("勾选要更改的偏好。").font(.caption).foregroundStyle(.secondary)
                ForEach(preferences, content: preferenceRow)
                Text("调整时区可能需要管理员授权。原值可在「维护与恢复」中找回。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !configured {
                Text("请先接入固定出口，再应用自动修复。").foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                if configured {
                    Button("应用优化") {
                        dismiss()
                        onApply(selected)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!enableTun && !closeIPv6 && selected.isEmpty)
                } else {
                    Button("打开配置") { dismiss(); GuardSetupWindow.show() }.buttonStyle(.borderedProminent)
                }
            }
        }
        .padding(20)
        .frame(width: 440)
    }

    private func preferenceRow(_ preference: Preference) -> some View {
        let checked = selected.contains(preference.id)
        return Button {
            if checked { selected.remove(preference.id) }
            else { selected.insert(preference.id) }
        } label: {
            HStack(spacing: 9) {
                Image(systemName: preference.available ? (checked ? "checkmark.square.fill" : "square") : "checkmark.circle.fill")
                    .foregroundStyle(checked ? theme.accent : preference.available ? theme.secondaryLabel : theme.success)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(preference.title)
                    Text(preference.detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!preference.available)
        .accessibilityAddTraits(checked ? .isSelected : [])
        .accessibilityIdentifier("guard.optimize.\(preference.id)")
    }
}
