import AppKit
import NookApp

@MainActor
final class GuardStatusMenu: NSObject, NSMenuDelegate {
    static let shared = GuardStatusMenu()
    private var item: NSStatusItem?
    private weak var model: GuardModel?
    private weak var coordinator: AppCoordinator?
    private var applyingRules = false

    private enum Operation {
        case openClash, changeExit, applyRules, continueSetup, unblock
    }

    private struct Presentation {
        var title: String
        var color: NSColor
        var detail: [String] = []
        var actionTitle: String?
        var action: Operation?
        var showsVerification = true
        var showsDiagnostics = true
    }

    func install(model: GuardModel, coordinator: AppCoordinator) {
        self.model = model
        self.coordinator = coordinator
        guard item == nil else { return }
        let status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let url = Bundle.module.url(forResource: "ClaudeGuardMenu", withExtension: "png"),
           let icon = NSImage(contentsOf: url) {
            icon.size = NSSize(width: 21, height: 21)
            icon.isTemplate = true
            status.button?.image = icon
        }
        status.button?.setAccessibilityLabel("ClaudeGuard")
        let menu = NSMenu(title: "ClaudeGuard")
        menu.autoenablesItems = false
        menu.showsStateColumn = false
        menu.delegate = self
        status.menu = menu
        // 设置 › 菜单栏显示 Clawd (default on).
        status.isVisible = UserDefaults.standard.object(forKey: guardMenuBarClawdKey) as? Bool ?? true
        item = status
    }

    func setMenuBarVisible(_ visible: Bool) {
        item?.isVisible = visible
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        let state = presentation(model?.status)
        menu.removeAllItems()
        let summary = NSMenuItem()
        summary.view = header(state)
        menu.addItem(summary)

        if let action = state.action, let title = state.actionTitle {
            command(menu, title, #selector(runPrimary(_:))).representedObject = action
        }
        if state.showsVerification {
            if state.action != nil { menu.addItem(.separator()) }
            let check = command(menu, model?.status?.verifiedNow == true ? "立即重新验证" : "重新验证",
                                #selector(revalidate), key: "r")
            check.isEnabled = model?.runningAction == nil
            if model?.status?.verifiedNow == true {
                command(menu, "立即阻断 Claude", #selector(block))
            }
        }

        menu.addItem(.separator())
        command(menu, "打开 ClaudeGuard", #selector(openPanel), key: ";")
        if state.showsDiagnostics {
            command(menu, "复制诊断信息（已脱敏）", #selector(copyDiagnostics)).isEnabled = model?.status != nil
        }
        command(menu, "设置…", #selector(openSettings), key: ",")
        menu.addItem(.separator())
        command(menu, model?.status?.verifiedNow == true ? "退出（Claude 将断网）" : "退出",
                #selector(confirmQuit), key: "q")
    }

    @discardableResult
    private func command(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let entry = NSMenuItem(title: title, action: action, keyEquivalent: key)
        entry.target = self
        if #available(macOS 26, *) {
            // Clear AppKit's action-specific default image, including its column.
            entry.image = NSImage(size: .zero)
            entry.image = nil
        }
        menu.addItem(entry)
        return entry
    }

    private func header(_ state: Presentation) -> NSView {
        let title = NSMutableAttributedString()
        title.append(NSAttributedString(string: "● ", attributes: [.foregroundColor: state.color]))
        title.append(NSAttributedString(string: state.title, attributes: [
            .font: NSFont.boldSystemFont(ofSize: 13), .foregroundColor: NSColor.labelColor,
        ]))
        for line in state.detail {
            title.append(NSAttributedString(string: "\n" + line, attributes: [
                .font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor,
            ]))
        }
        let control = NSButton(frame: NSRect(x: 0, y: 0, width: 310, height: 32 + 16 * state.detail.count))
        control.attributedTitle = title
        control.alignment = .left
        control.isBordered = false
        control.setAccessibilityLabel(([state.title] + state.detail).joined(separator: "，"))
        control.setAccessibilityHelp("打开 ClaudeGuard")
        control.target = self
        control.action = #selector(openPanel)
        let view = NSView(frame: control.frame)
        control.frame = view.bounds.insetBy(dx: 16, dy: 2)
        view.addSubview(control)
        return view
    }

    private func presentation(_ status: GuardStatus?) -> Presentation {
        guard GuardSettings.current != nil else {
            return Presentation(title: "尚未保护", color: .secondaryLabelColor,
                                detail: ["请设置固定出口并接入 Clash。"], actionTitle: "继续设置…",
                                action: .continueSetup, showsVerification: false, showsDiagnostics: false)
        }
        guard let status else {
            return Presentation(title: "保护状态待确认", color: .systemOrange,
                                detail: ["正在等待守护服务。"], actionTitle: "检查设置…", action: .continueSetup,
                                showsVerification: false)
        }
        if status.verifiedNow {
            let country = status.last?.location.flatMap { Locale(identifier: "zh_CN").localizedString(forRegionCode: $0) }
            let fixedIP = maskedIP(status.last?.ip)
            let line = [fixedIP.map { "出口 " + $0 }, country].compactMap { $0 }.joined(separator: " · ")
            var evidence: [String] = []
            if let at = status.last?.verifiedAt {
                let seconds = max(0, Int(Date.now.timeIntervalSince1970 - at / 1000))
                evidence.append(seconds == 0 ? "刚刚验证" : "\(seconds) 秒前已验证")
            }
            if let entry = status.relay?.entry {
                evidence.append("入口 " + GuardLogPrivacy.redact(entry.name, limit: 18))
                if let delay = entry.delay { evidence.append("\(delay) 毫秒") }
            }
            if status.relay?.entry?.delay == nil,
               let elapsed = status.relay?.stages["egress"]?.durationMs {
                evidence.append("出口检测 \(elapsed) 毫秒")
            }
            return Presentation(title: "保护中", color: .systemGreen,
                                detail: [line, evidence.joined(separator: " · ")].filter { !$0.isEmpty })
        }
        if status.manual == true {
            return Presentation(title: "已阻断 · 手动阻断", color: .systemRed,
                                actionTitle: "解除阻断并验证", action: .unblock)
        }
        if status.phase == "awaiting-rules" || status.reason == "relay-awaiting-confirmation" {
            let next = status.reason == "relay-awaiting-confirmation" ? "还差一步：确认实测出口。" : "还差一步：把规则应用到 Clash。"
            return Presentation(title: "尚未保护", color: .secondaryLabelColor,
                                detail: [next], actionTitle: "继续设置…", action: .continueSetup,
                                showsVerification: false, showsDiagnostics: false)
        }

        switch status.reason {
            case "exit-ip-mismatch", "egress_mismatch":
                let actual = maskedIP(status.last?.ip) ?? "未取得"
                let expected = maskedIP(status.expectedIP) ?? "未设定"
                return Presentation(title: "已阻断 · 出口 IP 变了", color: .systemRed,
                                    detail: ["实测 \(actual)，目标 \(expected)"],
                                    actionTitle: "去 Clash 检查出口节点", action: .openClash)
            case "entry_unavailable":
                return Presentation(title: "已阻断 · 入口不可用", color: .systemRed,
                                    actionTitle: "打开 Clash 切换入口", action: .openClash)
            case "exit_auth_failed", "relay_credentials_unavailable":
                return Presentation(title: "已阻断 · SOCKS5 凭据异常", color: .systemRed,
                                    actionTitle: "修改出口设置…", action: .changeExit)
            case "exit_unreachable":
                return Presentation(title: "已阻断 · 出口连接失败", color: .systemRed,
                                    actionTitle: "打开 Clash 检查入口", action: .openClash)
            case "tun-required", "tun-status-unavailable", "device-tun-coverage":
                return Presentation(title: "已阻断 · TUN 接管异常", color: .systemRed,
                                    actionTitle: "打开 Clash 检查 TUN", action: .openClash)
            case "guard-route-not-installed", "device-rules-required", "protected-rules-changed", "coverage-rules-changed":
                return Presentation(title: "已阻断 · 守护规则未通过", color: .systemRed,
                                    actionTitle: applyingRules ? "正在应用到 Clash…" : "一键应用到 Clash…", action: .applyRules)
            case "global_ipv6_present":
                return Presentation(title: "已阻断 · 检测到 IPv6 出口", color: .systemRed,
                                    actionTitle: "打开连接检查", action: .continueSetup)
            case "confirming-exit":
                return Presentation(title: "正在验证固定出口", color: .systemOrange,
                                    detail: ["连续通过 \(status.successes ?? 0)/\(status.recoverySamples ?? 3) 次"])
            case "ready-not-enabled":
                return Presentation(title: "尚未保护", color: .secondaryLabelColor,
                                    actionTitle: "继续设置…", action: .continueSetup,
                                    showsVerification: false, showsDiagnostics: false)
            default:
                return Presentation(title: "已阻断 · 保护未确认", color: .systemRed,
                                    actionTitle: "检查配置…", action: .continueSetup)
        }
    }

    private func maskedIP(_ value: String?) -> String? {
        guard let value else { return nil }
        let parts = value.split(separator: ".")
        guard parts.count == 4, parts.allSatisfy({ UInt8($0) != nil }) else { return "已隐藏" }
        return "\(parts[0]).xx.xx.\(parts[3])"
    }

    @objc private func runPrimary(_ sender: NSMenuItem) {
        guard let operation = sender.representedObject as? Operation else { return }
        switch operation {
            case .openClash:
                let identifier = "io.github.clash-verge-rev.clash-verge-rev"
                if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) {
                    NSWorkspace.shared.open(url)
                } else { GuardSetupWindow.show() }
            case .changeExit: GuardSetupWindow.show(openExitSettings: true)
            case .applyRules: applyRules()
            case .continueSetup: GuardSetupWindow.show()
            case .unblock: run(.enable)
        }
    }

    @objc private func openPanel() {
        item?.menu?.cancelTracking()
        coordinator?.showHome()
    }
    @objc private func openSettings() { coordinator?.showSettings() }
    @objc private func revalidate() { run(.inspect) }
    @objc private func block() { run(.block) }

    private func run(_ action: GuardAction) {
        Task { await model?.run(action) }
    }

    @objc private func copyDiagnostics() {
        guard let status = model?.status else { return }
        let state = presentation(status)
        var lines = ["ClaudeGuard \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")",
                     "状态 \(state.title)"]
        if let ip = maskedIP(status.expectedIP) { lines.append("目标出口 \(ip)") }
        if let ip = maskedIP(status.last?.ip) { lines.append("最近探测出口 \(ip)") }
        if let tun = status.tunEnabled { lines.append("TUN \(tun ? "已开启" : "已关闭")") }
        for (key, label) in [("entry", "入口"), ("exit", "SOCKS5"), ("egress", "出口验证")] {
            if let value = status.relay?.stages[key] { lines.append("\(label) \(value.ok ? "通过" : "未通过")") }
        }
        let clipboard = NSPasteboard.general
        clipboard.clearContents()
        clipboard.setString(lines.joined(separator: "\n"), forType: .string)
    }

    private func applyRules() {
        guard !applyingRules else { return }
        guard GuardSettings.current?.relay != nil, GuardSetupModel.manifestScriptPath() != nil else {
            GuardSetupWindow.show()
            return
        }
        let alert = NSAlert()
        alert.messageText = "重新应用规则到 Clash？"
        alert.informativeText = "ClaudeGuard 会重新生成独立订阅并重启 Clash，网络可能短暂中断。"
        alert.addButton(withTitle: "应用并重启")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        applyingRules = true
        Task {
            defer { applyingRules = false }
            let setup = GuardSetupModel()
            await setup.applyDeviceExit()
            await model?.refresh()
            GuardSetupWindow.show()
            if setup.verge == nil, let message = setup.message {
                let feedback = NSAlert()
                feedback.messageText = "规则应用未确认"
                feedback.informativeText = message
                feedback.addButton(withTitle: "确定")
                _ = feedback.runModal()
            }
        }
    }

    @objc private func confirmQuit() {
        let alert = NSAlert()
        alert.messageText = "退出 ClaudeGuard？"
        alert.informativeText = "退出后，已接入守护通道的 Claude 将无法联网。"
        alert.addButton(withTitle: "继续运行")
        alert.addButton(withTitle: "退出")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn { NSApp.terminate(nil) }
    }
}

