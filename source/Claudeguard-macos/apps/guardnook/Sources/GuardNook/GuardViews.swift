import NookApp
import SwiftUI

enum GuardLook {
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

    /// Millisecond epochs, as the guard service reports them.
    static func time(_ ms: Double?) -> String {
        guard let ms else { return "—" }
        return Date(timeIntervalSince1970: ms / 1000).formatted(date: .omitted, time: .standard)
    }

    /// `HH:mm:ss` from a millisecond epoch, matching the log the guard service keeps.
    static func clock(_ ms: Double?) -> String {
        guard let ms else { return "--:--:--" }
        return clock(Date(timeIntervalSince1970: ms / 1000))
    }

    static func clock(_ date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute, .second], from: date)
        return String(format: "%02d:%02d:%02d", parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
    }
}

/// The expanded panel: 守护 / 环境 / 日志 at 680 × 422 under the top bar. The gear's
/// 设置 page is the framework's settings slot (main.swift `setSettings`).
struct GuardHomeView: View {
    @ObservedObject var model: GuardModel
    @ObservedObject var navigation: GuardNavigation
    @State private var confirmingBlock = false

    var body: some View {
        Group {
            switch navigation.tab {
                case .guardTab:
                    GuardGuardPage(model: model, navigation: navigation, confirmingBlock: $confirmingBlock)
                case .environment:
                    GuardEnvironmentPage(desktop: GuardDesktopModel.shared, networkModel: model)
                case .logs:
                    GuardLogView(model: GuardLogModel.shared, guardModel: model, navigation: navigation)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: GuardMetrics.contentHeight)
        .background(GuardPanelBackground())
        .disabled(confirmingBlock)
        .accessibilityHidden(confirmingBlock)
        .overlay {
            if confirmingBlock {
                // Stay in the nook's window: a system dialog adds a screen-sized
                // scrim and makes the surface interpret its hover as an exit.
                ZStack {
                    GuardInk.panelBottom.opacity(0.55)
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
                .font(GuardFont.make(15, .semibold))
                .foregroundStyle(GuardInk.primary)
            Text("阻断后 Claude 网页与 API 将不可用，直到你点「启用保护」重新验证。")
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 10) {
                Button {
                    confirmingBlock = false
                } label: {
                    Text("取消").frame(maxWidth: .infinity)
                }
                .buttonStyle(GuardPillButtonStyle(height: 32))
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("guard.block.cancel")
                Button {
                    confirmingBlock = false
                    Task { await model.run(.block) }
                } label: {
                    Text("阻断 Claude").frame(maxWidth: .infinity)
                }
                .buttonStyle(GuardPillButtonStyle(prominent: true, height: 32))
                .disabled(model.runningAction != nil)
                .accessibilityIdentifier("guard.block.confirm")
            }
        }
        .padding(20)
        .frame(width: 320)
        .guardCard(raised: true)
        .shadow(color: .black.opacity(0.3), radius: 16, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("guard.block.dialog")
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
