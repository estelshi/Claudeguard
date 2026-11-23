import NookApp
import SwiftUI

enum GuardLook {
    static let headerActionWidth: CGFloat = 88
    static func symbol(_ verdict: LocalVerdict) -> String {
        switch verdict.level {
            case .good: "checkmark.shield.fill"
            case .caution: "shield.lefthalf.filled"
            case .bad: "exclamationmark.shield.fill"
            case .unknown: "shield"
        }
    }

    static func tint(_ verdict: LocalVerdict, _ theme: NookResolvedTheme) -> Color {
        switch verdict.level {
            case .good: theme.success
            case .caution: theme.warning
            case .bad: theme.destructive
            case .unknown: theme.quaternaryLabel
        }
    }

    static func time(_ date: Date?) -> String {
        guard let date else { return "—" }
        return date.formatted(date: .omitted, time: .standard)
    }

    static func age(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "—" }
        let seconds = max(0, now.timeIntervalSince(date))
        if seconds < 60 { return "\(Int(seconds)) 秒前" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        return "\(Int(seconds / 3600)) 小时前"
    }

    static func symbol(_ status: GuardStatus?) -> String {
        guard let status else { return "shield.slash" }
        if status.verifiedNow { return "checkmark.shield.fill" }
        if status.enabled == true { return "shield.lefthalf.filled" }
        return "shield"
    }

    static func tint(_ status: GuardStatus?, _ theme: NookResolvedTheme) -> Color {
        guard let status else { return theme.quaternaryLabel }
        if status.verifiedNow { return theme.success }
        if status.enabled == true { return theme.warning }
        return theme.accent
    }

    static func headline(_ status: GuardStatus?) -> String {
        status?.headline ?? "守护服务未接入"
    }

    static func checkTint(_ check: GuardStatus.CheckItem, _ theme: NookResolvedTheme) -> Color {
        if check.ok { return theme.success }
        return check.warnOnly ? theme.warning : theme.destructive
    }

    /// Millisecond epochs, as the guard service reports them.
    static func time(_ ms: Double?) -> String {
        guard let ms else { return "—" }
        return Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .standard)
    }
}

enum EnvStatus {
    case good
    case warn
    case bad
}

struct GuardCapsuleButtonStyle: ButtonStyle {
    let tint: Color
    var width: CGFloat? = nil

    // Dark pill: a faint tinted wash and hairline, tinted label. Used for secondary
    // and status-coloured actions; main actions use GuardPillButtonStyle.
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, 12)
            .frame(width: width, height: 26)
            .background(Capsule().fill(tint.opacity(0.16)))
            .overlay(Capsule().strokeBorder(tint.opacity(0.28)))
            .foregroundStyle(tint)
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

struct EnvRow: Identifiable {
    let id: String
    let label: String
    let detail: String
    let state: EnvStatus
    var action: GuardAction?
    var actionDisabled = false
}

/// Product tabs share the native top bar.
enum GuardTab: Hashable, CaseIterable {
    case home
    case guardTab
    case line
    case environment
    case logs

    var title: String {
        switch self {
            case .home: "首页"
            case .guardTab: "Claude 守护"
            case .line: "专线检测"
            case .environment: "环境"
            case .logs: "日志"
        }
    }

    var symbol: String {
        switch self {
            case .home: "house"
            case .guardTab: "shield.lefthalf.filled"
            case .line: "network"
            case .environment: "slider.horizontal.3"
            case .logs: "list.bullet.rectangle"
        }
    }

    var help: String {
        switch self {
            case .home: "Claude 固定出口状态"
            case .guardTab: "实时守护状态与手动阻断"
            case .line: "专线节点质量：出口与代理链、采样通过率、环境检查"
            case .environment: "启动前环境检查、自动修复与恢复"
            case .logs: "运行日志：守护变化、网络检测与环境检查"
        }
    }
}

struct GuardHomeView: View {
    @ObservedObject var model: GuardModel
    @ObservedObject var navigation: GuardNavigation
    @Environment(\.nookResolvedTheme) private var theme
    @State private var confirmingBlock = false
    private var tab: GuardTab { navigation.tab }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if tab == .home {
                GuardProductOverview(model: model)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 16)
            } else if tab == .logs {
                GuardLogView(model: GuardLogModel.shared)
            } else if tab == .environment {
                ScrollView(.vertical, showsIndicators: false) {
                    GuardEnvironmentTab(desktop: GuardDesktopModel.shared, networkModel: model)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 22)
                        .padding(.vertical, 16)
                }
                .frame(maxWidth: .infinity, maxHeight: 440, alignment: .top)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    Group {
                        if tab == .guardTab { guardContent } else { lineContent }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 22)
                    .padding(.vertical, 16)
                }
                .frame(maxWidth: .infinity, maxHeight: 400, alignment: .top)
                Divider().overlay(theme.subtleStroke).padding(.horizontal, 22)
                configurationEntry
                    .padding(.horizontal, 22)
                    .padding(.vertical, 10)
            }
        }
        .disabled(confirmingBlock)
        .accessibilityHidden(confirmingBlock)
        .overlay {
            if confirmingBlock {
                // Stay in the nook's window: a system dialog adds a screen-sized
                // scrim and makes the surface interpret its hover as an exit.
                ZStack {
                    Color.clear
                        .contentShape(Rectangle())
                        .onTapGesture {}
                    blockConfirmation
                }
            }
        }
        .nookKeepsExpanded(while: $confirmingBlock)
        .onChange(of: navigation.tab) { _, _ in confirmingBlock = false }
        .onDisappear { confirmingBlock = false }
        .onExitCommand { confirmingBlock = false }
    }

    private var blockConfirmation: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("手动阻断 Claude 通道？")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(theme.primaryLabel)
            Text("阻断后 Claude 网页与 API 将不可用，直到你点「启用保护」重新验证。")
                .font(.system(size: 12))
                .foregroundStyle(theme.secondaryLabel)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button {
                    confirmingBlock = false
                } label: {
                    Text("取消")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(theme.subtleFill, in: Capsule())
                        .foregroundStyle(theme.secondaryLabel)
                }
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("guard.block.cancel")
                Button(role: .destructive) {
                    confirmingBlock = false
                    Task { await model.run(.block) }
                } label: {
                    Text("阻断 Claude")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(theme.destructive.opacity(0.18), in: Capsule())
                        .foregroundStyle(theme.destructive)
                }
                .disabled(model.runningAction != nil)
                .accessibilityIdentifier("guard.block.confirm")
            }
            .font(.system(size: 12, weight: .semibold))
            .buttonStyle(.plain)
        }
        .padding(20)
        .frame(width: 320)
        .background(Color(guardHex: 0x1C1D22), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(theme.subtleStroke))
        .shadow(color: .black.opacity(0.3), radius: 16, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("guard.block.dialog")
    }

    private var configurationEntry: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(GuardSettings.current?.selectedProxy.map { "已配置节点：" + $0 } ?? "配置你自己的 Clash 节点")
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1).truncationMode(.middle)
                if let note = GuardRuntime.shared.note {
                    Text(note).font(.system(size: 10)).foregroundStyle(theme.warning)
                }
            }
            Spacer()
            Button {
                GuardSetupWindow.show()
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 10, weight: .semibold))
                    Text("配置节点")
                }
            }
                .buttonStyle(GuardPillButtonStyle())
                .accessibilityLabel("配置节点")
                .accessibilityIdentifier("guard.setup.open")
        }
        .padding(.top, 4)
    }

    // MARK: - Tab content

    @ViewBuilder
    private var guardContent: some View {
        let verdict = model.verdict
        VStack(alignment: .leading, spacing: 18) {
            if GuardSettings.current == nil {
                GuardProductOverview(model: model)
            } else { header(verdict) }
            if let note = model.actionNote {
                Text(note)
                    .font(.system(size: 10))
                    .foregroundStyle(theme.warning)
                    .lineLimit(2)
            }
            // Ages and probe times tick with the clock rather than the poll.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                VStack(alignment: .leading, spacing: 18) {
                    exitCards(verdict, now: context.date)
                    sampling(verdict)
                    checkPills(verdict)
                }
            }
            trafficLog
            footer
        }
    }

    @ViewBuilder
    private var lineContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            lineHeader
            if let status = model.status {
                // Ages and countdowns tick with the clock rather than the poll.
                TimelineView(.periodic(from: .now, by: 1)) { _ in
                    VStack(alignment: .leading, spacing: 18) {
                        lineExitCards(status)
                        lineSampling(status)
                        lineCheckPills(status)
                    }
                }
                lineEnvironmentSection(status)
                if let events = status.events, !events.isEmpty {
                    lineRecentConnections(events)
                }
            } else if let error = model.lastError {
                Text(error)
                    .font(.system(size: 11))
                    .foregroundStyle(theme.tertiaryLabel)
                    .lineLimit(2)
            }
            footer
        }
    }

    // MARK: - Line tab (guard status)

    private var lineHeader: some View {
        GuardHero(
            tone: GuardTone(model.status),
            headline: GuardLook.headline(model.status),
            reason: model.status?.reasonText ?? "无法读取服务状态。"
        )
    }

    private func lineExitCards(_ status: GuardStatus) -> some View {
        HStack(spacing: 10) {
            card(
                title: "固定出口",
                value: status.relay?.confirmed == false ? "待确认" : status.expectedIP ?? "—",
                detail: "唯一允许访问 Claude 的出口",
                tint: theme.accent,
                fill: .teal,
                valueSize: 26
            )
            card(
                title: "实测出口",
                value: status.last?.ip ?? "未检测",
                detail: lineMeasuredDetail(status),
                tint: status.exitMatches ? theme.success : theme.warning,
                fill: status.exitMatches ? .blue : .sunset,
                valueSize: 26
            )
        }
    }

    private func lineMeasuredDetail(_ status: GuardStatus) -> String {
        var parts: [String] = []
        if let location = status.last?.location, !location.isEmpty { parts.append(location) }
        if let colo = status.last?.colo, !colo.isEmpty { parts.append(colo) }
        if let age = status.freshnessSeconds { parts.append("\(age) 秒前") }
        return parts.isEmpty ? "尚无验证记录" : parts.joined(separator: " · ")
    }

    /// The service's checks as one quiet line (no chips; the headline badge carries state).
    private func lineCheckPills(_ status: GuardStatus) -> some View {
        let passed = status.checks.filter { $0.ok }.map { $0.label }
        let pending = status.checks.filter { !$0.ok }.map { $0.label }
        var parts: [String] = []
        if !passed.isEmpty { parts.append(passed.joined(separator: "、") + " 已通过") }
        if !pending.isEmpty { parts.append(pending.joined(separator: "、") + " 待通过") }
        return Text(parts.joined(separator: " · "))
            .font(.system(size: 10.5))
            .foregroundStyle(theme.tertiaryLabel)
            .lineLimit(1)
            .truncationMode(.tail)
    }

    private func lineSampling(_ status: GuardStatus) -> some View {
        let stats = status.sampleStats
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom, spacing: 34) {
                stat(
                    value: stats.successRate.map { "\($0)%" } ?? "—",
                    label: "近 \(stats.total) 次采样通过率",
                    tint: (stats.successRate ?? 0) >= 99 ? theme.primaryLabel : theme.warning
                )
                stat(
                    value: stats.avgMs.map { "\($0)" } ?? "—",
                    label: lineLatencyDetail(stats),
                    tint: theme.primaryLabel
                )
                Spacer(minLength: 0)
                GuardSampleSparkline(samples: status.samples ?? [])
            }
            Text(lineWindowLine(status))
                .font(.system(size: 10))
                .foregroundStyle(theme.quaternaryLabel)
        }
    }

    private func lineLatencyDetail(_ stats: GuardStatus.SampleStats) -> String {
        guard let min = stats.minMs, let max = stats.maxMs else { return "平均延迟" }
        return "平均延迟（\(min)–\(max) ms）"
    }

    private func lineWindowLine(_ status: GuardStatus) -> String {
        var parts: [String] = []
        if let remaining = status.windowRemainingSeconds, status.gateway?.open == true {
            parts.append("守护窗口剩余 \(remaining) 秒")
        } else {
            parts.append("守护窗口关闭")
        }
        if let connections = status.gateway?.connections {
            parts.append("活跃连接 \(connections)")
        }
        let target = status.recoverySamples ?? 3
        parts.append("连续验证 \(min(status.successes ?? 0, target))/\(target)")
        if let lastOkAt = status.sampleStats.lastOkAt {
            parts.append("最近通过 \(GuardLook.time(lastOkAt))")
        }
        return parts.joined(separator: " · ")
    }

    private func lineEnvironmentSection(_ status: GuardStatus) -> some View {
        let diagnostics = model.diagnostics
        let rows = lineEnvRows(status, diagnostics)
        return VStack(alignment: .leading, spacing: 12) {
            GuardSectionTitle(
                title: "环境检查",
                note: diagnostics?.checkedAt.map { "核验于 \(GuardLook.time($0))" }
            )
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in
                    lineEnvRow(row)
                    if row.id != rows.last?.id {
                        Divider().overlay(theme.subtleStroke)
                    }
                }
            }
            .guardSurface(padding: 12, radius: 16)
            lineBrowserCard(diagnostics)
        }
    }

    private func lineEnvRows(_ status: GuardStatus, _ diagnostics: GuardDiagnostics?) -> [EnvRow] {
        var rows: [EnvRow] = []

        rows.append(EnvRow(
            id: "exit",
            label: "固定出口",
            detail: status.exitMatches ? "\(status.last?.ip ?? "—") · 已验证" : "未取得验证",
            state: status.exitMatches ? .good : .warn,
            action: .inspect
        ))

        let protection: (EnvStatus, String)
        if status.manual == true {
            protection = (.warn, "手动阻断中，启用保护后重新验证")
        } else if status.verifiedNow {
            protection = (.good, "保护运行中，异常自动阻断")
        } else if status.enabled == true {
            protection = (.warn, "正在连续验证出口，暂不放行")
        } else {
            protection = (.warn, "尚未启用保护")
        }
        rows.append(EnvRow(id: "guard", label: "专线保护", detail: protection.1, state: protection.0))

        let route = diagnostics?.routeCheck
        var routeState: EnvStatus = .warn
        var routeDetail = "请点击检查，重新验证"
        if let route, route.state == "completed" {
            if diagnostics?.routeCheckFresh != true {
                routeDetail = "旧记录，请重新检查"
            } else if diagnostics?.routeCheckPassed == true {
                routeState = .good
                routeDetail = "claude.ai · api.anthropic.com 已通过"
            } else if let failed = diagnostics?.routeCheckClaudeRows.first(where: { $0.state != "verified" }) {
                routeDetail = "\(failed.host ?? "—")：" + GuardDiagnostics.routeStateText(failed.state)
            }
        } else if route?.state == "gate-closed" {
            routeDetail = "守护窗口未开启，先启用保护"
        }
        rows.append(EnvRow(
            id: "route",
            label: "网页与 API 路径",
            detail: routeDetail,
            state: routeState,
            action: .routeCheck,
            actionDisabled: !status.verifiedNow
        ))

        if let diagnostics, diagnostics.auditFresh, let dns = diagnostics.dns, let udp = diagnostics.udp {
            let configured = dns.state == "configured" && udp.state == "configured"
            rows.append(EnvRow(
                id: "dns",
                label: "DNS / UDP 配置",
                detail: configured ? "配置已核验，实时泄漏未检测" : "配置需复核",
                state: configured ? .good : .warn,
                action: .audit
            ))
        } else {
            let detail = diagnostics?.checkedAt == nil ? "尚未核验，请检查" : "核验已过期，请重新检查"
            rows.append(EnvRow(id: "dns", label: "DNS / UDP 配置", detail: detail, state: .warn, action: .audit))
        }

        if let observations = diagnostics?.observations {
            switch observations.state {
                case "no-observed-bypass":
                    rows.append(EnvRow(id: "bypass", label: "异常 Claude 连接", detail: "本次未观察到旁路", state: .good, action: .audit))
                case "needs-review":
                    rows.append(EnvRow(id: "bypass", label: "异常 Claude 连接", detail: "\(observations.rows?.count ?? 0) 条连接待复核", state: .warn, action: .audit))
                default:
                    rows.append(EnvRow(id: "bypass", label: "异常 Claude 连接", detail: "尚未检查", state: .warn, action: .audit))
            }
        } else {
            rows.append(EnvRow(id: "bypass", label: "异常 Claude 连接", detail: "尚未检查", state: .warn, action: .audit))
        }

        return rows
    }

    private func lineEnvRow(_ row: EnvRow) -> some View {
        HStack(spacing: 8) {
            Image(systemName: envSymbol(row.state))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(envTint(row.state))
            Text(row.label)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(theme.primaryLabel)
            Spacer(minLength: 8)
            Text(row.detail)
                .font(.system(size: 10.5))
                .foregroundStyle(theme.tertiaryLabel)
                .lineLimit(1)
                .truncationMode(.middle)
            if let action = row.action {
                Button {
                    Task { await model.run(action) }
                } label: {
                    if model.runningAction == action {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 10, weight: .semibold))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(theme.tertiaryLabel)
                .disabled(row.actionDisabled || model.runningAction != nil)
                .help(lineActionHelp(action))
            }
        }
        .frame(minHeight: 34)
    }

    private func lineBrowserCard(_ diagnostics: GuardDiagnostics?) -> some View {
        let verified = diagnostics?.browser?.state == "configured"
        return VStack(alignment: .leading, spacing: 4) {
            Text(verified ? "浏览器登录环境：Ego Lite 推荐设置已核验" : "浏览器登录环境：尚未完整验证")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(theme.secondaryLabel)
            Text("\(diagnostics?.browser?.evidence ?? "推荐偏好尚未确认")。不能代表 RoxyChrome 或其他浏览器，请在准备登录 Claude 的浏览器中检查 DNS / WebRTC 旁路。")
                .font(.system(size: 10))
                .foregroundStyle(theme.tertiaryLabel)
                .lineLimit(3)
            HStack(spacing: 12) {
                Link("DNS 检测", destination: URL(string: "https://ip.net.coffee/dns/")!)
                Link("WebRTC 检测", destination: URL(string: "https://ip.net.coffee/webrtc/")!)
            }
            .font(.system(size: 10, weight: .medium))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .guardSurface(padding: 12, radius: 16)
    }

    private func lineActionHelp(_ action: GuardAction) -> String {
        switch action {
            case .inspect: "立即验证固定出口"
            case .audit: "重新检查（DNS / UDP · 异常连接 · 浏览器环境）"
            case .routeCheck: "重新验证 Claude 网页和 API 的实际连接路径"
            case .enable, .block: ""
        }
    }

    private func lineRecentConnections(_ events: [GuardStatus.ConnEvent]) -> some View {
        let recent = Array(events.prefix(3))
        return VStack(alignment: .leading, spacing: 8) {
            GuardSectionTitle(title: "最近连接记录")
            ForEach(recent.indices, id: \.self) { index in
                HStack(spacing: 8) {
                    Text(recent[index].host ?? "—")
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(theme.secondaryLabel)
                        .lineLimit(1)
                    Spacer()
                    if let proto = recent[index].proto {
                        Text(proto)
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(theme.quaternaryLabel)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(theme.subtleFill))
                    }
                    Text(GuardLook.time(recent[index].at))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(theme.quaternaryLabel)
                }
            }
        }
    }

    // MARK: - Header

    private func header(_ verdict: LocalVerdict) -> some View {
        GuardHero(tone: GuardTone(verdict), headline: verdict.headline, reason: verdict.reason) {
            if let status = model.status { blockButton(status) }
        }
    }

    /// Manual block / re-enable, pinned to the hero's top-right corner.
    private func blockButton(_ status: GuardStatus) -> some View {
        let blocked = status.manual == true
        let running = model.runningAction == .block || model.runningAction == .enable
        let tint = blocked ? theme.success : theme.destructive
        return Button {
            if blocked {
                Task { await model.run(.enable) }
            } else {
                confirmingBlock = true
            }
        } label: {
            HStack(spacing: 5) {
                if running {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: blocked ? "checkmark.shield.fill" : "hand.raised.fill")
                        .font(.system(size: 10, weight: .semibold))
                }
                Text(blocked ? "启用保护" : "手动阻断")
            }
        }
        .buttonStyle(GuardCapsuleButtonStyle(tint: tint, width: GuardLook.headerActionWidth))
        .disabled(model.runningAction != nil)
        .accessibilityIdentifier("guard.block.toggle")
        .help(blocked ? "清除手动阻断并重新连续验证" : "立即阻断 Claude 通道（需确认）")
    }

    // MARK: - Exit cards

    private func exitCards(_ verdict: LocalVerdict, now: Date) -> some View {
        let admitted = model.status?.verifiedNow == true
        let ipv4 = model.systemIPv4?.currentIP(now: now)
        let cloudflare = model.systemCloudflare?.currentIP(now: now)
        let expected = GuardSettings.current?.expectedIP
        let compareSystem = GuardSettings.current?.deviceWide == true
        let systemIPs = [ipv4, cloudflare].compactMap { $0 }
        let systemMismatch = compareSystem && expected != nil && systemIPs.contains { $0 != expected }
        let claudeMatches = verdict.exitProbe?.ok == true
        let claudeMismatch = verdict.exitProbe?.ip != nil && !claudeMatches
        let ordinaryStatus = systemIPs.isEmpty ? "普通网络出口待确认" : "普通网络可达"
        let summary = !admitted ? "\(ordinaryStatus) · Claude 尚未放行"
            : claudeMismatch ? "Claude 出口与目标不符"
            : systemMismatch ? "普通网络出口与目标不符"
            : claudeMatches && compareSystem && systemIPs.count == 2 ? "三项实测均与固定出口一致"
            : claudeMatches ? "Claude 守护出口已确认"
            : "等待 Claude 出口检测"
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                systemExitCard("系统网络 · IPv4", reading: model.systemIPv4, now: now, fill: .teal)
                systemExitCard("系统网络 · Cloudflare", reading: model.systemCloudflare, now: now, fill: .blue)
                card(
                    title: "Claude 通道实测出口",
                    value: verdict.exitProbe?.ip ?? verdict.exitPlaceholder,
                    detail: exitDetail(verdict, now: now),
                    tint: exitTint(verdict),
                    fill: claudeMismatch ? .sunset : .violet
                )
                .help("通过 Claude 客户端使用的本地守护入口请求 claude.ai 并实测出口；未放行或检测失败时不回退到系统网络。")
            }
            HStack(spacing: 8) {
                Text(summary)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(claudeMismatch || systemMismatch ? theme.warning : claudeMatches ? theme.success : theme.secondaryLabel)
                    .help("前两项按本机网络实际出网。Claude 一栏单独验证守护通道。")
                Spacer(minLength: 0)
                Button {
                    model.refreshClaudeNow()
                } label: {
                    if model.refreshingClaude || model.refreshingExits {
                        ProgressView().controlSize(.mini).accessibilityLabel("正在检测出口")
                    } else {
                        Text("重新检测出口")
                    }
                }
                .buttonStyle(GuardPillButtonStyle())
                .disabled(model.refreshingClaude || model.refreshingExits)
            }
        }
    }

    private func systemExitCard(_ title: String, reading: NetworkExitProbe?, now: Date, fill: GuardFill) -> some View {
        let ip = reading?.currentIP(now: now)
        let didFail = reading?.ok == false && !model.refreshingExits
        let value = ip ?? (didFail ? "检测失败" : "等待检测")
        let detail: String
        if let reading, ip != nil {
            let location = [reading.loc, reading.colo].compactMap { $0 }.filter { !$0.isEmpty }
            let label = location.isEmpty ? reading.source : location.joined(separator: " · ")
            detail = label + " · " + GuardLook.age(reading.at, now: now)
        } else {
            detail = didFail ? "可点「重新检测出口」" : "按本机网络实测"
        }
        return card(title: title, value: value, detail: detail,
                    tint: ip != nil ? theme.success : didFail ? theme.warning : theme.quaternaryLabel,
                    fill: fill)
    }

    private func exitDetail(_ verdict: LocalVerdict, now: Date) -> String {
        guard let exit = verdict.exitProbe else { return verdict.exitPlaceholder == "未放行" ? "守护通道关闭，不发起出口请求" : "等待守护通道实测" }
        var parts: [String] = []
        if !exit.locationLine.isEmpty { parts.append(exit.locationLine) }
        parts.append(GuardLook.age(exit.at, now: now))
        return parts.joined(separator: " · ")
    }

    private func exitTint(_ verdict: LocalVerdict) -> Color {
        guard let ip = verdict.exitProbe?.ip else { return theme.quaternaryLabel }
        guard ip == GuardSettings.current?.expectedIP else { return theme.warning }
        return theme.success
    }

    /// A gradient tile (GuardStyle.swift). `tint` is the status dot in its corner.
    private func card(title: String, value: String, detail: String, tint: Color,
                      fill: GuardFill = .teal, valueSize: CGFloat = 22) -> some View {
        GuardTile(title: title, value: value, detail: detail, fill: fill, dot: tint, valueSize: valueSize)
    }

    // MARK: - Pills

    private func checkPills(_ verdict: LocalVerdict) -> some View {
        var pills: [(String, Color)] = []
        pills.append(verdict.exitProbe?.ip == nil ? (verdict.exitPlaceholder, theme.warning) : ("出口已实测", exitTint(verdict)))
        if verdict.lastProbe != nil {
            pills.append(verdict.exitProbe?.ok == true ? ("通道已验证", theme.success) : ("通道未通过", theme.warning))
        } else {
            pills.append(("实测中", theme.warning))
        }
        if let proxy = model.env?.proxy {
            switch proxy {
                case .on: pills.append(("系统代理开", theme.success))
                case .pac: pills.append(("系统代理 PAC", theme.warning))
                case .off: pills.append(("系统代理关", theme.warning))
                case .unknown: pills.append(("系统代理 ?", theme.warning))
            }
        } else {
            pills.append(("系统代理 ?", theme.warning))
        }
        let fresh = verdict.lastProbe.map { Date.now.timeIntervalSince($0.at) < 45 } ?? false
        pills.append(fresh ? ("采样在线", theme.success) : ("采样停", theme.warning))

        // One quiet line, no chips: the headline badge already carries the state.
        return Text(pills.map { $0.0 }.joined(separator: " · "))
            .font(.system(size: 10.5))
            .foregroundStyle(theme.tertiaryLabel)
            .lineLimit(1)
    }

    // MARK: - Sampling

    private func sampling(_ verdict: LocalVerdict) -> some View {
        let stats = model.probeStats
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .bottom, spacing: 34) {
                stat(
                    value: stats.successRate.map { "\($0)%" } ?? "—",
                    label: "通道验证通过率（\(stats.total) 次）",
                    tint: (stats.successRate ?? 0) >= 90 ? theme.primaryLabel : theme.warning
                )
                .help("统计经 Claude 客户端守护入口的出口验证；未放行时不显示当前通过率。")
                stat(
                    value: stats.avgMs.map { "\($0)" } ?? "—",
                    label: latencyDetail(stats),
                    tint: theme.primaryLabel
                )
                Spacer(minLength: 0)
                GuardSparkline(probes: model.probes)
            }
            Text(windowLine(verdict))
                .font(.system(size: 10))
                .foregroundStyle(theme.quaternaryLabel)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    /// Huge thin number (GuardKPI); latency gets an "ms" unit.
    private func stat(value: String, label: String, tint: Color) -> some View {
        GuardKPI(value: value, unit: label.contains("延迟") ? "ms" : nil, label: label, tint: tint)
    }

    private func latencyDetail(_ stats: GuardModel.ProbeStats) -> String {
        guard let min = stats.minMs, let max = stats.maxMs else { return "平均延迟" }
        return "平均延迟（\(min)–\(max) ms）"
    }

    private func windowLine(_ verdict: LocalVerdict) -> String {
        var parts: [String] = []
        if let probe = verdict.lastProbe {
            if probe.ok {
                parts.append("最近通道验证通过 \(GuardLook.time(probe.at))")
            } else {
                parts.append("最近实测失败 \(GuardLook.time(probe.at)) · \(probe.reason ?? "失败")")
            }
        } else {
            parts.append("等待首次实测")
        }
        if let ip = verdict.exitProbe?.ip { parts.append("实测出口 \(ip)") }
        if let measuredAt = model.env?.measuredAt { parts.append("环境读数 \(GuardLook.time(measuredAt))") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Claude traffic log

    /// Controller connection IDs carry the original application metadata.
    private var trafficLog: some View {
        let log = model.status?.connectionLog
        let events = Array((log?.events ?? []).prefix(3))
        return VStack(alignment: .leading, spacing: 8) {
            GuardSectionTitle(title: "最近 Claude 网关连接")
            .help("Clash 提供的守护网关连接记录，包括自动探测。每秒采集一次，可能遗漏较短的连接。")
            if events.isEmpty {
                Text(log?.available == true ? "尚未观察到守护网关连接。" : "连接记录暂不可用。")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.quaternaryLabel)
            } else {
                ForEach(events) { event in
                    logRow(event, fresh: log?.fresh == true)
                }
            }
        }
    }

    private func logRow(_ event: GuardStatus.ConnectionLog.Connection, fresh: Bool) -> some View {
        HStack(spacing: 7) {
            Text(clock(event.at))
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.secondaryLabel)
            Circle()
                .fill(fresh && event.active == true ? theme.accent : theme.quaternaryLabel)
                .frame(width: 5, height: 5)
            Text("守护网关")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(theme.secondaryLabel)
            Text(event.host ?? "—")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(theme.secondaryLabel)
                .lineLimit(1)
            Spacer(minLength: 8)
            if let source = event.sourceLabel {
                Text(source)
                    .font(.system(size: 10))
                    .foregroundStyle(theme.tertiaryLabel)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: 260, alignment: .trailing)
                    .help(event.sourceDetail)
            }
        }
    }

    /// `HH:mm:ss`, matching the log the guard service keeps.
    private func clock(_ milliseconds: Double?) -> String {
        guard let milliseconds else { return "--:--:--" }
        let parts = Calendar.current.dateComponents(
            [.hour, .minute, .second],
            from: Date(timeIntervalSince1970: milliseconds / 1000)
        )
        return String(format: "%02d:%02d:%02d", parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
    }

    // MARK: - Environment indicators

    private func envSymbol(_ state: EnvStatus) -> String {
        switch state {
            case .good: "checkmark.circle.fill"
            case .warn: "exclamationmark.circle.fill"
            case .bad: "xmark.circle.fill"
        }
    }

    private func envTint(_ state: EnvStatus) -> Color {
        switch state {
            case .good: theme.success
            case .warn: theme.warning
            case .bad: theme.destructive
        }
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 8) {
            Text(footerText)
                .font(.system(size: 10))
                .foregroundStyle(theme.quaternaryLabel)
            Spacer()
            Button {
                model.refreshLocalNow()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.secondaryLabel)
            }
            .buttonStyle(.plain)
            .disabled(model.refreshingLocal)
            .help("立即重新实测")
        }
    }

    private var footerText: String {
        model.status != nil
            ? "面板定期自测 · 守护动作服务 \(GuardSettings.origin)"
            : "面板定期自测 · 守护动作服务未连接"
    }
}

/// The last probes as a strip: green is a verified pass, red a failure.
struct GuardSparkline: View {
    let probes: [ClaudeProbe]
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        let recent = Array(probes.suffix(24))
        HStack(alignment: .center, spacing: 3) {
            ForEach(recent) { probe in
                RoundedRectangle(cornerRadius: 2)
                    .fill(probe.ok ? theme.success.opacity(0.9) : theme.destructive.opacity(0.9))
                    .frame(width: 4, height: 26)
            }
        }
        .accessibilityLabel(Text("最近 \(recent.count) 次实测"))
    }
}

/// The guard service's own recent samples as a strip: green is a verified pass,
/// red a failure.
struct GuardSampleSparkline: View {
    let samples: [GuardStatus.Sample]
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        let recent = Array(samples.suffix(24))
        HStack(alignment: .center, spacing: 3) {
            ForEach(recent.indices, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(barTint(recent[index]))
                    .frame(width: 4, height: 26)
            }
        }
        .accessibilityLabel(Text("最近 \(recent.count) 次采样"))
    }

    private func barTint(_ sample: GuardStatus.Sample) -> Color {
        switch sample.ok {
            case .some(true): theme.success.opacity(0.9)
            case .some(false): theme.destructive.opacity(0.9)
            case .none: theme.quaternaryLabel.opacity(0.4)
        }
    }
}

struct GuardCompactGlyph: View {
    @ObservedObject var model: GuardModel
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        let verdict = model.verdict
        Image(systemName: GuardLook.symbol(verdict))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(GuardLook.tint(verdict, theme))
            .frame(width: 24, height: 24)
            .accessibilityLabel(Text("Claude 本机网络：" + verdict.headline))
            .help(verdict.reason)
    }
}

/// Hovering the pill drops a one-glance summary below it.
struct GuardPeekView: View {
    @ObservedObject var model: GuardModel
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        let verdict = model.verdict
        HStack(spacing: 10) {
            Image(systemName: GuardLook.symbol(verdict))
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(GuardLook.tint(verdict, theme))
            VStack(alignment: .leading, spacing: 1) {
                Text(verdict.exitProbe?.ip ?? verdict.exitPlaceholder)
                    .font(.system(size: 14, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(theme.primaryLabel)
                Text(peekDetail(verdict))
                    .font(.system(size: 10))
                    .foregroundStyle(theme.tertiaryLabel)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
    }

    private func peekDetail(_ verdict: LocalVerdict) -> String {
        var parts = [verdict.headline]
        if let probe = verdict.lastProbe, let ms = probe.durationMs {
            parts.append("\(ms) ms")
        }
        return parts.joined(separator: " · ")
    }
}

struct GuardWidgetView: View {
    @ObservedObject var model: GuardModel
    let size: NookWidgetSize
    @Environment(\.nookResolvedTheme) private var theme

    var body: some View {
        let verdict = model.verdict
        let roomy = size.columns > 1 || size.rows > 1
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                Image(systemName: GuardLook.symbol(verdict))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(GuardLook.tint(verdict, theme))
                Text("Claude 守护")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(theme.tertiaryLabel)
            }
            Spacer(minLength: 0)
            Text(verdict.exitProbe?.ip ?? verdict.exitPlaceholder)
                .font(.system(size: roomy ? 20 : 15, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(theme.primaryLabel)
                .lineLimit(1)
            Text(verdict.headline)
                .font(.system(size: 10))
                .foregroundStyle(theme.quaternaryLabel)
                .lineLimit(1)
            if roomy {
                Text(widgetStats)
                    .font(.system(size: 10, weight: .medium).monospacedDigit())
                    .foregroundStyle(theme.tertiaryLabel)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(maxHeight: .infinity)
    }

    private var widgetStats: String {
        let stats = model.probeStats
        var parts: [String] = []
        if let rate = stats.successRate { parts.append("通过 \(rate)%") }
        if let avg = stats.avgMs { parts.append("\(avg) ms") }
        return parts.isEmpty ? "尚在实测" : parts.joined(separator: " · ")
    }
}
