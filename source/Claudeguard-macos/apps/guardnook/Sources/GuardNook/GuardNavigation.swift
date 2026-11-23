import NookApp
import SwiftUI

@MainActor
final class GuardNavigation: ObservableObject {
    @Published var tab: GuardTab = ProcessInfo.processInfo.arguments.contains("--logs") ? .logs
        : ProcessInfo.processInfo.arguments.contains("--environment") ? .environment
        : .home
}

/// Product tabs occupy the native top bar's leading cluster as one pill: the selected
/// tab is a light capsule with a dark glyph (the dark-panel version of the Windows
/// black pill). Icons only, so the cluster stays clear of the notch at 680 pt.
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
