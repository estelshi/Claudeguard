import NookApp
import SwiftUI
import Foundation

// Installation checks run inside the installed app bundle so ServiceManagement
// registers GuardNook itself, rather than a shell or a temporary helper.
if let action = CommandLine.arguments.first(where: { ["--login-item-status", "--enable-login-item", "--disable-login-item"].contains($0) }) {
    MainActor.assumeIsolated {
        let item = GuardLoginItem.shared
        if action != "--login-item-status" { item.setEnabled(action == "--enable-login-item") }
        let result: [String: Any] = ["status": item.statusName, "enabled": item.isEnabled, "error": item.errorMessage ?? ""]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) { print(json) }
        exit(item.errorMessage == nil ? 0 : 1)
    }
}

/// Resident and loaded at launch, so its widget is on the board from the start.
nonisolated func resident(_ descriptor: NookModuleDescriptor) -> NookModuleDescriptor {
    var descriptor = descriptor
    descriptor.backgroundPolicy = .stayResident
    descriptor.loadsAtLaunch = true
    return descriptor
}

@MainActor
final class GuardModule: NookModule {
    nonisolated static let moduleDescriptor = resident(
        NookModuleDescriptor(
            id: "local.guardnook.share.nook",
            displayName: "Claude 守护",
            icon: "checkmark.shield"
        )
    )

    let descriptor = GuardModule.moduleDescriptor
    private let model = GuardModel()
    private let navigation = GuardNavigation()

    init() {
        GuardLogModel.shared.record(.application, .info, "ClaudeGuard 已启动",
            detail: "版本 \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版")；开始记录本次运行事件。")
    }

    func makeConfiguration() -> NookConfiguration {
        let model = model
        let navigation = navigation
        var configuration = NookConfiguration()
        configuration.onReady = { coordinator in
            GuardStatusMenu.shared.install(model: model, coordinator: coordinator)
        }
        configuration.setHome { GuardHomeView(model: model, navigation: navigation) }
        configuration.setCompactLeading { GuardCompactGlyph(model: model) }
        configuration.setCompactTrailing { EmptyView() }
        configuration.setPeek { GuardPeekView(model: model) }
        configuration.setTopBar { context in GuardTabTopBar(navigation: navigation, context: context) }
        // The gear opens the product's own 设置 page (fixed exit, maintenance, startup),
        // replacing the framework screen and its display / pin pickers.
        configuration.setSettings { GuardSettingsPage() }
        // Dark only: the restyle (GuardStyle.swift) is drawn for a black panel, so the
        // palette is pinned rather than following the system or the Settings picker.
        configuration.chromeTheme = NookTheme(accent: "#8FC9C4", palette: .dark)
        configuration.scrollEdgeFade = .standard
        // The framework sizes the whole panel, so every tab shares this width; each page
        // pins its own height (GuardMetrics.contentHeight) for a 680 × 460 panel.
        configuration.expandedWidth = 680
        configuration.addWidget(
            NookWidget(
                id: "claude-guard.status",
                title: "Claude 守护",
                symbol: "checkmark.shield",
                sizes: [.medium, .small],
                action: .openModule
            ) { size in
                GuardWidgetView(model: model, size: size)
            }
        )
        return configuration
    }
}

var host = NookHostConfiguration()
host.showsMenuBarExtra = false
host.branding = NookHostBranding(hostName: "ClaudeGuard", hostTagline: "Claude 固定出口守护", mark: NookHostBranding.symbol("checkmark.shield"))
host.register(GuardModule.moduleDescriptor) { _ in GuardModule() }

host.registerBoard(
    NookBoardConfiguration(
        id: "local.guardnook.share.board",
        displayName: "守护组件",
        defaultLayout: [
            NookWidgetPlacement(moduleID: GuardModule.moduleDescriptor.id, widgetID: "claude-guard.status", size: .medium)
        ]
    )
)

host.defaultModule = GuardModule.moduleDescriptor.id

DispatchQueue.main.async {
    if !CommandLine.arguments.contains("--setup-only") { GuardRuntime.shared.startIfConfigured() }
    if !GuardSettings.isConfigured || CommandLine.arguments.contains("--configure") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { GuardSetupWindow.show() }
    }
}
if CommandLine.arguments.contains("--setup-only") {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    DispatchQueue.main.async { GuardSetupWindow.show() }
    app.run()
} else {
    NookApp.main(host)
}
