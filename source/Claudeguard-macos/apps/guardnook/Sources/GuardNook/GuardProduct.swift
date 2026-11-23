import AppKit
import Foundation
import NookApp
import SwiftUI
import CryptoKit
import UniformTypeIdentifiers

struct GuardMaintenanceView: View {
    @ObservedObject private var desktop = GuardDesktopModel.shared
    @Environment(\.nookResolvedTheme) private var theme
    @State private var showDetach = false
    @State private var showRestore = false
    @State private var showEnvironmentHistory = false
    @State private var choosing = false
    @State private var message: String?
    @State private var verifiedSHA: String?
    @State private var verifiedInstaller: URL?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button("导出脱敏诊断包…") { exportSupport() }
                Button("环境更改与恢复…") { showEnvironmentHistory = true }
            }
            HStack {
                Button("校验新安装包…") { chooseUpdate() }
                if verifiedInstaller != nil { Button("备份当前版本并打开安装包") { openVerifiedUpdate() } }
            }
            Text("手动更新：校验来源可信的 DMG / ZIP 后，备份当前程序并打开安装包，再将新版拖入应用程序。本机配置保存在应用包之外。完整性校验不证明发布者身份。")
                .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel).fixedSize(horizontal: false, vertical: true)
            Button("查看版本备份") {
                let url = GuardSettings.directory.appendingPathComponent("Backups")
                try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                NSWorkspace.shared.open(url)
            }
            Divider()
            HStack {
                Button("解除连接 / 准备卸载…") { showDetach = true }.disabled(desktop.maintenance?.configured != true)
                if desktop.maintenance?.configured == false, desktop.maintenance?.latestConnection != nil {
                    Button("恢复上一次连接…") { showRestore = true }
                }
            }
            Text("卸载前先解除连接，在 Clash 恢复原始扩展脚本并重载。最后关闭开机启动并退出，只移除 ClaudeGuard。")
                .font(.system(size: 10)).foregroundStyle(theme.tertiaryLabel).fixedSize(horizontal: false, vertical: true)
            if let path = desktop.originalScript { Button("显示原始扩展脚本") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) } }
            if let value = message ?? desktop.note { Text(value).font(.system(size: 10)).foregroundStyle(theme.secondaryLabel).fixedSize(horizontal: false, vertical: true) }
        }
        .font(.system(size: 11))
        .toggleStyle(.switch).controlSize(.mini)
        .task { await desktop.maintenanceAction("summary") }
        .nookSheet(isPresented: $showEnvironmentHistory) { GuardEnvironmentHistoryView(model: desktop) }
        .nookSheet(isPresented: $showDetach) {
            VStack(alignment: .leading, spacing: 14) {
                Text("解除 ClaudeGuard 连接？").font(.headline)
                Text("将关闭本应用的保护通道并保存连接恢复点。请在 Clash 恢复原始扩展脚本并重载，才能撤销旧规则。")
                    .font(.callout).foregroundStyle(.secondary)
                HStack { Spacer(); Button("取消") { showDetach = false }; Button("确认解除") {
                    showDetach = false
                    Task { await desktop.maintenanceAction("detach") }
                } }
            }.padding(24).frame(width: 440)
        }
        .nookSheet(isPresented: $showRestore) {
            VStack(alignment: .leading, spacing: 14) {
                Text("恢复上一次连接配置？").font(.headline)
                Text("恢复后仍需到守护页明确启用并验证。不会自动放行。")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("取消") { showRestore = false }
                    Button("恢复连接") {
                        showRestore = false
                        if let id = desktop.maintenance?.latestConnection { Task { await desktop.maintenanceAction("restore", id: id) } }
                    }.buttonStyle(.borderedProminent)
                }
            }.padding(24).frame(width: 420)
        }
        .nookKeepsExpanded(while: $showDetach)
        .nookKeepsExpanded(while: $showRestore)
        .nookKeepsExpanded(while: $showEnvironmentHistory)
        .nookKeepsExpanded(while: $choosing)
    }
    private func exportSupport() {
        choosing = true
        let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "GuardNook-诊断.json"
        panel.begin { response in
            defer { choosing = false }
            guard response == .OK, let url = panel.url else { return }
            let rows = desktop.audit?.rows.map { ["title": GuardLogPrivacy.redact($0.title), "state": $0.state, "blocking": String($0.blocking), "detail": GuardLogPrivacy.redact($0.detail)] } ?? []
            let report: [String: Any] = ["version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版",
                "platform": ProcessInfo.processInfo.operatingSystemVersionString, "createdAt": ISO8601DateFormatter().string(from: .now),
                "configured": GuardSettings.current != nil, "monitoring": GuardSettings.isMonitoring,
                "environment": rows,
                "logs": GuardLogFile.export(GuardLogModel.shared.entries), "scope": "已脱敏；不含配置对象、节点订阅、令牌、账号名称或聊天数据"]
            do { try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic); message = "脱敏诊断包已导出。" }
            catch { message = "诊断包导出失败，请检查所选位置权限。" }
        }
    }
    private func chooseUpdate() {
        choosing = true; verifiedInstaller = nil; verifiedSHA = nil
        let picker = NSOpenPanel(); picker.allowedContentTypes = [.diskImage, .zip]; picker.title = "选择新版本安装包"
        picker.begin { response in
            guard response == .OK, let installer = picker.url else { choosing = false; return }
            let manifest = NSOpenPanel(); manifest.allowedContentTypes = [.json]; manifest.title = "选择安装包附带的 verification.json"; manifest.directoryURL = installer.deletingLastPathComponent()
            manifest.begin { answer in
                defer { choosing = false }
                guard answer == .OK, let file = manifest.url else { return }
                do {
                    let data = try Data(contentsOf: file)
                    guard data.count < 128_000, let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let outputs = value["outputs"] as? [String: [String: Any]], let expected = outputs[installer.lastPathComponent]?["sha256"] as? String else { throw SetupFailure(message: "校验清单不包含这个安装包。") }
                    guard expected.count == 64, sha256(installer) == expected.lowercased() else { throw SetupFailure(message: "安装包完整性校验失败，未打开文件。") }
                    verifiedInstaller = installer; verifiedSHA = expected.lowercased(); message = "文件完整性校验通过。请确认发布来源可信后继续；此校验不证明发布者身份。"
                } catch { message = error.localizedDescription }
            }
        }
    }
    private func sha256(_ url: URL) -> String {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
        defer { try? handle.close() }
        var hash = SHA256()
        do { while let data = try handle.read(upToCount: 1_048_576), !data.isEmpty { hash.update(data: data) } }
        catch { return "" }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    private func openVerifiedUpdate() {
        guard let installer = verifiedInstaller else { return }
        guard sha256(installer) == verifiedSHA else { message = "安装包在校验后发生变化，未打开文件，请重新校验。"; verifiedInstaller = nil; return }
        do {
            let root = GuardSettings.directory.appendingPathComponent("Backups/update-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            try FileManager.default.copyItem(at: Bundle.main.bundleURL, to: root.appendingPathComponent("ClaudeGuard.app"))
            NSWorkspace.shared.open(installer)
            message = "当前程序已备份。请退出 ClaudeGuard 后完成手动替换；如需回退，可从备份目录恢复旧程序。"
        } catch { message = "当前版本备份失败，未打开安装包。请检查磁盘空间与权限。" }
    }
}
