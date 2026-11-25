import NookApp
import SwiftUI

/// 守护: the one page that answers "is Claude safe right now". The same skeleton in
/// every state: hero (Clawd badge + headline + one line + one action), the three
/// network cards, then one row of three cards on the same grid.
struct GuardGuardPage: View {
    @ObservedObject var model: GuardModel
    @ObservedObject var navigation: GuardNavigation
    @Binding var confirmingBlock: Bool
    @ObservedObject private var runtime = GuardRuntime.shared
    @State private var userRefreshing = false

    var body: some View {
        let hero = GuardHeroState(model: model, runtimeNote: runtime.note)
        VStack(alignment: .leading, spacing: 0) {
            heroRow(hero)
            Spacer().frame(height: GuardMetrics.section)
            // Ages tick with the clock rather than the 3 s poll.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                VStack(alignment: .leading, spacing: GuardMetrics.gap) {
                    networkHeader(now: context.date)
                    networkCards(now: context.date)
                        .frame(height: GuardMetrics.networkCardHeight)
                    bottomRow(hero.kind)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, GuardMetrics.horizontal)
        .padding(.top, GuardMetrics.top)
        .padding(.bottom, GuardMetrics.bottom)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onChange(of: model.refreshingLocal) { _, refreshing in
            if !refreshing { userRefreshing = false }
        }
    }

    // MARK: Hero

    private func heroRow(_ hero: GuardHeroState) -> some View {
        HStack(alignment: .center, spacing: 16) {
            GuardClawdBadge(
                tone: hero.tone,
                busy: userRefreshing || model.runningAction == .inspect || model.runningAction == .enable,
                progress: model.status?.successes,
                progressTarget: model.status?.recoverySamples ?? 3
            )
            VStack(alignment: .leading, spacing: 4) {
                Text(hero.title)
                    .font(GuardFont.pageTitle)
                    .foregroundStyle(hero.titleColor)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Text(hero.subtitle)
                    .font(GuardFont.body)
                    .foregroundStyle(hero.subtitleColor)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .help(hero.subtitle)
            }
            Spacer(minLength: 8)
            heroButton(hero.action)
        }
    }

    @ViewBuilder
    private func heroButton(_ action: GuardHeroState.Action) -> some View {
        let running = model.runningAction != nil
        switch action {
            case .block:
                Button {
                    confirmingBlock = true
                } label: {
                    Label("阻断", systemImage: "hand.raised")
                }
                .buttonStyle(GuardPillButtonStyle(height: 30))
                .disabled(running || model.status == nil)
                .help("立即阻断 Claude 通道（需确认）")
                .accessibilityIdentifier("guard.block.toggle")
            case .revalidate:
                Button {
                    Task { await model.run(.inspect) }
                } label: {
                    buttonLabel("重新验证", symbol: "arrow.clockwise", busy: model.runningAction == .inspect)
                }
                .buttonStyle(GuardPillButtonStyle(prominent: true, height: 30))
                .disabled(running)
                .help("要求守护服务立即重新验证固定出口")
                .accessibilityIdentifier("guard.revalidate")
            case .enable:
                Button {
                    Task { await model.run(.enable) }
                } label: {
                    buttonLabel("启用保护", symbol: "checkmark.shield", busy: model.runningAction == .enable)
                }
                .buttonStyle(GuardPillButtonStyle(prominent: true, height: 30))
                .disabled(running)
                .help("清除阻断并重新连续验证；验证通过前 Claude 保持阻断")
                .accessibilityIdentifier("guard.block.toggle")
            case .retry:
                Button {
                    userRefreshing = true
                    Task { await model.refresh() }
                } label: {
                    buttonLabel("重新检测", symbol: "arrow.clockwise", busy: userRefreshing)
                }
                .buttonStyle(GuardPillButtonStyle(prominent: true, height: 30))
            case .setup(let title):
                Button {
                    GuardSetupWindow.show()
                } label: {
                    HStack(spacing: 5) {
                        Text(title)
                        Image(systemName: "arrow.right").font(GuardFont.make(10, .semibold))
                    }
                }
                .buttonStyle(GuardPillButtonStyle(prominent: true, height: 30))
                .accessibilityIdentifier("guard.setup.open")
        }
    }

    private func buttonLabel(_ title: String, symbol: String, busy: Bool) -> some View {
        HStack(spacing: 5) {
            if busy {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: symbol).font(GuardFont.make(11, .semibold))
            }
            Text(title)
        }
    }

    // MARK: Network

    private func networkHeader(now: Date) -> some View {
        let latest = [model.systemIPv4?.at, model.systemCloudflare?.at, model.probes.last?.at].compactMap { $0 }.max()
        let refreshing = model.refreshingClaude || model.refreshingExits
        return GuardSectionTitle(title: "这台电脑的网络") {
            Text(latest.map { GuardLook.age($0, now: now) } ?? "等待检测")
                .font(GuardFont.meta)
                .monospacedDigit()
                .foregroundStyle(GuardInk.tertiary)
            Button {
                userRefreshing = true
                model.refreshClaudeNow()
            } label: {
                if refreshing {
                    ProgressView().controlSize(.mini).accessibilityLabel("正在检测出口")
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .buttonStyle(GuardCircleButtonStyle(size: 26))
            .disabled(refreshing)
            .help("重新检测这台电脑的出口和 Claude 通道")
            .accessibilityLabel("重新检测出口")
        }
    }

    private func networkCards(now: Date) -> some View {
        HStack(spacing: GuardMetrics.gap) {
            systemCard("系统网络 · IPv4", reading: model.systemIPv4, fill: .teal, now: now)
            systemCard("系统网络 · Cloudflare", reading: model.systemCloudflare, fill: .blue, now: now)
            claudeCard(now: now)
                .help("通过 Claude 客户端使用的本地守护入口实测出口；未放行或检测失败时不回退到系统网络。")
        }
    }

    private func systemCard(_ title: String, reading: NetworkExitProbe?, fill: GuardFill, now: Date) -> some View {
        let ip = reading?.currentIP(now: now)
        let failed = reading?.ok == false && !model.refreshingExits
        let expected = GuardSettings.current?.expectedIP
        let compare = GuardSettings.current?.deviceWide == true && expected != nil
        let dot: Color = ip == nil ? (failed ? GuardInk.failure : GuardInk.tertiary)
            : (compare && ip != expected ? GuardInk.warning : GuardInk.success)
        return GuardTile(
            title: title,
            value: ip ?? (failed ? "检测失败" : "检测中…"),
            detail: systemDetail(reading, ip: ip, failed: failed),
            fill: fill,
            dot: dot,
            valueDimmed: ip == nil
        )
    }

    private func systemDetail(_ reading: NetworkExitProbe?, ip: String?, failed: Bool) -> String {
        guard let reading, ip != nil else { return failed ? (reading?.reason ?? "系统线路未返回 IPv4") : "按本机网络实测" }
        var parts = ["直连"]
        if let region = region(reading.loc ?? sharedLocation(for: ip)) { parts.append(region) }
        if let colo = reading.colo, !colo.isEmpty { parts.append(colo) }
        if parts.count == 1 { parts.append(reading.source) }
        return parts.joined(separator: " · ")
    }

    /// api.ipify.org reports no location; borrow Cloudflare's when both saw the same IP.
    private func sharedLocation(for ip: String?) -> String? {
        guard let ip, model.systemCloudflare?.ip == ip else { return nil }
        return model.systemCloudflare?.loc
    }

    private func region(_ code: String?) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return Locale(identifier: "zh_CN").localizedString(forRegionCode: code) ?? code
    }

    private func claudeCard(now: Date) -> some View {
        let verdict = model.verdict
        let expected = GuardSettings.current?.expectedIP
        let configured = GuardSettings.current != nil
        let admitted = model.status?.verifiedNow == true
        let ip = verdict.exitProbe?.ip
        let matches = ip != nil && ip == expected
        let value = ip ?? (!configured ? "未配置" : !admitted ? "未放行" : "检测中…")
        let detail: String
        if ip != nil, let probe = verdict.exitProbe {
            let entryName = model.status?.relay?.entry?.name
            let route = entryName.map { "经 \($0)" } ?? (probe.locationLine.isEmpty ? nil : probe.locationLine)
            let verdictText = matches ? "与固定出口一致" : "与固定出口 \(expected ?? "—") 不符"
            detail = [route, verdictText].compactMap { $0 }.joined(separator: " · ")
        } else if !configured {
            detail = "配置完成后经守护入口实测"
        } else if !admitted {
            detail = "守护通道已关闭，不发起请求"
        } else {
            detail = "等待守护通道实测"
        }
        let dot: Color = !configured ? GuardInk.tertiary
            : ip != nil ? (matches ? GuardInk.success : GuardInk.failure)
            : admitted ? GuardInk.tertiary : GuardInk.failure
        return GuardTile(title: "Claude 通道", value: value, detail: detail, fill: .violet, dot: dot, valueDimmed: ip == nil)
    }

    // MARK: Second row

    @ViewBuilder
    private func bottomRow(_ kind: GuardHeroState.Kind) -> some View {
        switch kind {
            case .protected, .checking, .notEnabled:
                HStack(spacing: GuardMetrics.gap) {
                    passRateCard
                    latencyCard
                    gatewayCard
                }
            case .blocked:
                HStack(spacing: GuardMetrics.gap) {
                    fixedExitCard
                    measuredCard
                    passRateCard
                }
            case .unconfigured:
                HStack(spacing: GuardMetrics.gap) {
                    stepCard("第 1 步", "识别 Clash", "只读取节点，不改订阅")
                    stepCard("第 2 步", "入口与固定出口", "SOCKS5 凭据存入钥匙串")
                    stepCard("第 3–4 步", "应用并确认出口", "约 2 分钟")
                }
        }
    }

    private var probeResults: [Bool?] {
        model.probes.map { $0.ok && $0.viaGuard }
    }

    private var passRate: Int? {
        let total = model.probes.count
        guard total > 0 else { return nil }
        let ok = model.probes.filter { $0.ok && $0.viaGuard }.count
        return Int((Double(ok) / Double(total) * 100).rounded())
    }

    private var passRateCard: some View {
        GuardKPICard(label: "通道验证通过率", onOpen: { navigation.openLogs(.protection) }, openHelp: "在日志中查看守护记录") {
            VStack(alignment: .leading, spacing: 10) {
                GuardNumber(value: passRate.map { "\($0)" } ?? "—", unit: "%")
                GuardSparkStrip(results: probeResults)
            }
        }
        .help("统计经 Claude 客户端守护入口的通道验证（最近 \(model.probes.count) 次）。")
    }

    private var latencyCard: some View {
        let stats = model.probeStats
        let footnote: String
        if let min = stats.minMs, let max = stats.maxMs {
            footnote = "\(min.formatted()) – \(max.formatted()) ms · 近 \(stats.total) 次"
        } else {
            footnote = "等待通道实测"
        }
        return GuardKPICard(label: "平均延迟", onOpen: { navigation.openLogs(.protection) }, openHelp: "在日志中查看守护记录") {
            VStack(alignment: .leading, spacing: 6) {
                GuardNumber(value: stats.avgMs.map { $0.formatted() } ?? "—", unit: "ms")
                footnoteText(footnote)
            }
        }
    }

    private var gatewayCard: some View {
        let log = model.status?.connectionLog
        let count = log?.events.count ?? model.status?.gateway?.connections
        let footnote: String
        if let newest = log?.events.first?.at {
            footnote = "最近 \(GuardLook.clock(newest))"
        } else {
            footnote = log?.available == true ? "尚未观察到连接" : "连接记录暂不可用"
        }
        return GuardKPICard(label: "网关连接", onOpen: { navigation.openLogs(.connection) }, openHelp: "在日志中查看连接") {
            VStack(alignment: .leading, spacing: 6) {
                GuardNumber(value: count.map { "\($0)" } ?? "—", unit: "条")
                footnoteText(footnote)
            }
        }
        .help("Clash 提供的守护网关连接记录，包括自动探测。每秒采集一次，可能遗漏较短的连接。")
    }

    private var fixedExitCard: some View {
        GuardKPICard(label: "固定出口") {
            VStack(alignment: .leading, spacing: 6) {
                GuardNumber(value: GuardSettings.current?.expectedIP ?? "未设置", size: 22)
                footnoteText("唯一允许访问 Claude 的出口")
            }
        }
    }

    private var measuredCard: some View {
        let last = model.status?.last
        let expected = GuardSettings.current?.expectedIP
        let ip = last?.ip
        let differs = ip != nil && ip != expected
        var parts: [String] = []
        if let at = last?.sampledAt ?? last?.verifiedAt { parts.append(GuardLook.clock(at)) }
        if let entry = model.status?.relay?.entry?.name {
            parts.append("经 \(entry)")
        } else if let location = last?.location, !location.isEmpty {
            parts.append(region(location) ?? location)
        }
        return GuardKPICard(label: "最近实测", onOpen: { navigation.openLogs(.protection) }, openHelp: "在日志中查看守护记录") {
            VStack(alignment: .leading, spacing: 6) {
                GuardNumber(value: ip ?? "未取得", size: 22, color: differs ? GuardInk.badText : GuardInk.primary)
                footnoteText(parts.isEmpty ? "尚无实测记录" : parts.joined(separator: " · "))
            }
        }
    }

    private func stepCard(_ step: String, _ title: String, _ detail: String) -> some View {
        Button {
            GuardSetupWindow.show()
        } label: {
            GuardKPICard(label: step) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(GuardFont.sectionTitle)
                        .foregroundStyle(GuardInk.primary)
                        .lineLimit(1)
                    footnoteText(detail)
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: GuardMetrics.cardRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .help("打开配置向导")
    }

    private func footnoteText(_ text: String) -> some View {
        Text(text)
            .font(GuardFont.meta)
            .monospacedDigit()
            .foregroundStyle(GuardInk.tertiary)
            .lineLimit(1)
            .truncationMode(.middle)
            .help(text)
    }
}

/// What the hero says, derived from the guard service status and the panel's own
/// verdict. Kept apart from the view so every state reads in one place.
struct GuardHeroState {
    enum Kind {
        case protected
        case checking
        case notEnabled
        case blocked
        case unconfigured
    }

    enum Action {
        case block
        case revalidate
        case enable
        case retry
        case setup(String)
    }

    var kind: Kind
    var tone: GuardTone
    var title: String
    var subtitle: String
    var action: Action
    var titleColor: Color = GuardInk.primary
    var subtitleColor: Color = GuardInk.secondary

    @MainActor
    init(model: GuardModel, runtimeNote: String?) {
        let settings = GuardSettings.current
        let status = model.status
        let verdict = model.verdict
        let target = status?.recoverySamples ?? 3
        let streak = min(status?.successes ?? 0, target)

        if settings == nil {
            kind = .unconfigured
            tone = .idle
            title = "尚未配置保护"
            titleColor = GuardInk.idleTitle
            subtitle = GuardSettings.isMonitoring
                ? "基础监测中：只观测本机网络，Claude 通道未受保护"
                : "识别 Clash、设定固定出口后，Claude 才经守护通道放行"
            action = .setup(GuardSettings.isMonitoring ? "配置保护" : "开始配置")
        } else if let status {
            if status.verifiedNow && verdict.level == .good {
                kind = .protected
                tone = .good
                title = "Claude 已受保护"
                subtitle = "固定出口 \(status.expectedIP ?? "—") · 连续验证 \(streak)/\(target) · 异常时自动阻断"
                action = .block
            } else if status.verifiedNow && verdict.level != .bad {
                kind = .checking
                tone = .warn
                title = "正在实测守护通道"
                subtitle = verdict.reason
                action = .block
            } else if status.manual == true {
                kind = .blocked
                tone = .bad
                title = "Claude 已阻断"
                titleColor = GuardInk.badText
                subtitle = "手动阻断中；点「启用保护」后重新连续验证"
                action = .enable
            } else if status.verifiedNow || status.enabled == true {
                if status.phase == "verifying" && !status.verifiedNow {
                    kind = .checking
                    tone = .warn
                    title = status.reason == "relay-awaiting-confirmation" ? "待确认出口 IPv4" : "正在验证固定出口"
                    subtitle = status.reasonText ?? "连续验证 \(streak)/\(target)；验证完成前保持阻断"
                    action = status.reason == "relay-awaiting-confirmation" ? .setup("确认出口") : .block
                } else {
                    kind = .blocked
                    tone = .bad
                    title = "Claude 已阻断"
                    titleColor = GuardInk.badText
                    subtitle = status.verifiedNow ? verdict.reason : (status.reasonText ?? verdict.reason)
                    action = .revalidate
                }
            } else {
                kind = .notEnabled
                tone = .warn
                title = status.headline
                subtitle = status.reasonText ?? "守护规则就绪后启用保护，连续验证通过才放行"
                let needsSetup = status.phase == "awaiting-rules" || status.reason == "relay-awaiting-confirmation"
                    || status.reason == "guard-route-not-installed"
                action = needsSetup ? .setup("继续配置") : .enable
            }
        } else {
            kind = .blocked
            tone = .bad
            title = "保护状态未确认"
            titleColor = GuardInk.badText
            subtitle = "守护服务暂不可用，Claude 通道保持关闭；面板会继续重试"
            action = .retry
        }

        if let note = model.actionNote ?? runtimeNote {
            subtitle = note
            subtitleColor = GuardInk.warning
        }
    }
}
