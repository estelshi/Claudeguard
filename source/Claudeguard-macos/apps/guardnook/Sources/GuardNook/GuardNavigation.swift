import NookApp
import SwiftUI

@MainActor
final class GuardNavigation: ObservableObject {
    @Published var tab: GuardTab = ProcessInfo.processInfo.arguments.contains("--logs") ? .logs
        : ProcessInfo.processInfo.arguments.contains("--environment") ? .environment
        : .guardTab
    /// The 日志 tab's category; KPI cards on 守护 jump straight to one.
    @Published var logFilter: GuardLogFilter = .all

    func openLogs(_ filter: GuardLogFilter) {
        logFilter = filter
        tab = .logs
    }
}

/// Product tabs: 守护 / 环境 / 日志. The gear opens the product's own 设置 page.
enum GuardTab: Hashable, CaseIterable {
    case guardTab
    case environment
    case logs

    var title: String {
        switch self {
            case .guardTab: "守护"
            case .environment: "环境"
            case .logs: "日志"
        }
    }

    var symbol: String {
        switch self {
            case .guardTab: "shield.lefthalf.filled"
            case .environment: "slider.horizontal.3"
            case .logs: "list.bullet.rectangle"
        }
    }

    var help: String {
        switch self {
            case .guardTab: "Claude 现在是否安全：状态、网络出口与通道验证"
            case .environment: "启动前环境检查、修复与恢复"
            case .logs: "守护变化、连接、环境与配置记录"
        }
    }
}

/// Product tabs occupy the native top bar's leading cluster as one pill: the selected
/// tab is a light capsule with a dark glyph (the dark-panel version of the Windows
/// black pill). Icons only, so the cluster stays clear of the notch at 680 pt. While
/// the gear's 设置 page is open, no tab is selected.
struct GuardTabTopBar: View {
    @ObservedObject var navigation: GuardNavigation
    let context: NookTopBarContext
    @Environment(\.nookResolvedTheme) private var theme
    @Environment(\.nookContentInsets) private var insets

    var body: some View {
        NookNotchRow {
            HStack(spacing: 2) {
                ForEach(GuardTab.allCases, id: \.self) { tab in
                    let selected = !context.isSettingsShown && navigation.tab == tab
                    Button {
                        if context.isSettingsShown { context.goBack() }
                        navigation.tab = tab
                    } label: {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 11, weight: selected ? .semibold : .medium))
                            .foregroundStyle(selected ? Color.black : theme.tertiaryLabel)
                            .frame(width: 30, height: 22)
                            .background(Capsule().fill(selected ? Color.white.opacity(0.92) : Color.clear))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tab.title)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .help(tab.title + " · " + tab.help)
                }
            }
            .padding(2)
            .background(Capsule().fill(Color.white.opacity(0.07)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10)))
            .padding(.leading, insets.leading)
        } trailing: {
            HStack(spacing: 12) {
                NookKeepOpenButton()
                NookSettingsButton()
            }
            .padding(.trailing, insets.trailing)
        }
    }
}
