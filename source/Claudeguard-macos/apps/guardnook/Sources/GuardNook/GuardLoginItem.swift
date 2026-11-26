import AppKit
import ServiceManagement
import SwiftUI
import NookApp

@MainActor
final class GuardLoginItem: ObservableObject {
    static let shared = GuardLoginItem()
    @Published private(set) var status = SMAppService.mainApp.status
    @Published private(set) var errorMessage: String?

    var isEnabled: Bool { status == .enabled || status == .requiresApproval }
    var statusName: String {
        switch status {
        case .enabled: return "enabled"
        case .notRegistered: return "notRegistered"
        case .requiresApproval: return "requiresApproval"
        case .notFound: return "notFound"
        @unknown default: return "unknown"
        }
    }

    func refresh() { status = SMAppService.mainApp.status }

    func setEnabled(_ enabled: Bool) {
        errorMessage = nil
        refresh()
        do {
            if enabled {
                if !isEnabled { try SMAppService.mainApp.register() }
            } else if status != .notRegistered {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            errorMessage = "无法更新开机启动设置：\(error.localizedDescription)"
        }
        refresh()
    }
}
