import AppKit
import Foundation
import NookApp
import SwiftUI

struct EnvironmentBaseline: Codable, Sendable {
    var template: String?
    var networkService: String?
    var country: String
    var timezone: String
    var locale: String
    var language: String
}

struct DesktopAudit: Decodable, Sendable {
    struct Row: Decodable, Identifiable, Sendable {
        var id: String
        var title: String
        var state: String
        var detail: String
        var blocking: Bool
        var fixable: Bool
    }
    var services: [String]?
    var configured: Bool?
    var checkedAt: Double
    var policy: EnvironmentBaseline
    var rows: [Row]
    var ready: Bool
    var repairIds: [String]
    var fresh: Bool { Date.now.timeIntervalSince1970 * 1000 - checkedAt < 120_000 }
}

struct EnvironmentChange: Decodable, Identifiable, Sendable {
    var id: String
    var at: Double
    var status: String
    var detail: String
    var outcomes: [String]
}
struct EnvironmentPlan: Decodable, Identifiable, Sendable {
    var id: String
    var title: String
    var before: String
    var after: String
}
struct MaintenanceStatus: Decodable, Sendable {
    var configured: Bool
    var external: Bool
    var latestConnection: String?
}
private struct DesktopReply: Decodable, Sendable {
    var maintenance: MaintenanceStatus?
    var originalPath: String?
    var history: [EnvironmentChange]?
    var planToken: String?
    var plan: [EnvironmentPlan]?
    var audit: DesktopAudit?
    var policy: EnvironmentBaseline?
    var note: String?
    var error: String?
}

@MainActor
final class GuardDesktopModel: ObservableObject {
    static let shared = GuardDesktopModel()
    @Published private(set) var maintenance: MaintenanceStatus?
    @Published private(set) var originalScript: String?
    @Published private(set) var history: [EnvironmentChange] = []
    @Published private(set) var plan: [EnvironmentPlan] = []
    @Published private(set) var audit: DesktopAudit?
    @Published private(set) var checking = false
    @Published private(set) var busy: String?
    @Published private(set) var note: String?
    @Published private(set) var auditError: String?
    private var planToken: String?
    private var previewRequest = UUID()
    private var polling: Task<Void, Never>?

    func start() {
        guard polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.check()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    private nonisolated static func helper(_ script: String, data: Data) throws -> DesktopReply {
        let process = try GuardRuntime.nodeProcess()
        process.arguments = (process.arguments ?? []) + [GuardRuntime.serviceDirectory.appendingPathComponent(script).path]
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        try input.fileHandleForWriting.write(contentsOf: data)
        try input.fileHandleForWriting.close()
        // Consume while the helper is running: helper output cannot fill a pipe.
        let result = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let reply = try? JSONDecoder().decode(DesktopReply.self, from: result) else {
            throw SetupFailure(message: "操作没有返回有效结果，请重新检查。")
        }
        if let error = reply.error { throw SetupFailure(message: error) }
        guard process.terminationStatus == 0 else { throw SetupFailure(message: "操作未完成，请重新检查。") }
        return reply
    }

    private func request(_ script: String, _ input: [String: Any]) async throws -> DesktopReply {
        let data = try JSONSerialization.data(withJSONObject: input)
        return try await Task.detached(priority: .userInitiated) { try Self.helper(script, data: data) }.value
    }

    func check(activeSTUN: Bool = false) async {
        guard !checking, busy == nil else { return }
        checking = true
        defer { checking = false }
        if activeSTUN { GuardLogModel.shared.record(.environment, .info, "开始主动检测", detail: "重新检查启动条件，并运行本进程的 STUN / UDP 探针。") }
        do {
            let result = try await request("desktop-environment.mjs", ["action": "inspect", "activeSTUN": activeSTUN])
            audit = result.audit
            auditError = nil
            if let audit {
                let signature = audit.rows.map { "\($0.id):\($0.state)" }.joined(separator: "|")
                let failed = audit.rows.filter { $0.blocking && $0.state != "ok" }.map(\.title)
                GuardLogModel.shared.transition("environment.audit", value: signature, category: .environment,
                    level: audit.ready ? .success : .warning,
                    title: audit.configured == false ? "基础监测：固定出口保护未接入" : audit.ready ? "启动环境基线通过" : "启动环境仍有待处理项",
                    detail: audit.configured == false ? "基础监测保留系统设置；当前没有启用固定出口守护。" : failed.isEmpty ? "启动条件已通过；诊断项仍需单独查看，不代表账号登录已验证。" : "未通过或未确认：" + failed.joined(separator: "、"),
                    force: activeSTUN)
            }
        } catch {
            audit = nil
            auditError = error.localizedDescription
            GuardLogModel.shared.transition("environment.audit", value: "unavailable", category: .environment,
                level: .error, title: "环境检查未完成", detail: error.localizedDescription, force: activeSTUN)
        }
    }

    func saveBaseline(_ policy: EnvironmentBaseline) async {
        guard busy == nil else { return }
        busy = "正在保存环境基线…"
        do {
            let value = try JSONSerialization.jsonObject(with: JSONEncoder().encode(policy))
            _ = try await request("desktop-environment.mjs", ["action": "baseline", "policy": value])
            note = "环境基线已保存，系统设置会在确认修复后才修改。"
            GuardLogModel.shared.record(.environment, .success, "环境基线已保存", detail: note ?? "")
        } catch {
            note = error.localizedDescription
            GuardLogModel.shared.record(.environment, .error, "环境基线保存失败", detail: error.localizedDescription)
        }
        busy = nil
        await check()
    }

    func repair(_ selection: [String]) async {
        let ids = selection.sorted()
        guard busy == nil else { return }
        guard let planToken, Set(plan.map(\.id)) == Set(ids) else { note = "请重新预览环境更改。"; return }
        busy = "正在修复所选项目…"
        let titles = audit?.rows.filter { ids.contains($0.id) }.map(\.title).joined(separator: "、") ?? "所选项目"
        GuardLogModel.shared.record(.environment, .info, "开始环境修复", detail: titles)
        do {
            note = try await request("desktop-environment.mjs", ["action": "repair", "ids": ids, "planToken": planToken]).note
            GuardLogModel.shared.record(.environment, .info, "环境修复已返回", detail: note ?? "请查看随后的环境检查结果。")
        } catch {
            note = error.localizedDescription
            GuardLogModel.shared.record(.environment, .error, "环境修复未完成", detail: error.localizedDescription)
        }
        busy = nil
        await loadHistory()
        await check()
    }
    func maintenanceAction(_ action: String, id: String? = nil) async {
        guard busy == nil else { return }
        if action != "summary" { busy = "正在处理连接恢复…" }
        defer { if action != "summary" { busy = nil } }
        do {
            var data: [String: Any] = ["action": action, "confirmed": true]
            if let id { data["id"] = id }
            let result = try await request("desktop-maintenance.mjs", data)
            maintenance = result.maintenance
            if let path = result.originalPath { originalScript = path }
            if let message = result.note { note = message }
            if action == "detach" { GuardRuntime.shared.stop(); GuardLogModel.shared.record(.configuration, .info, "已解除 GuardNook 连接", detail: note ?? "") }
            if action == "restore" { await GuardRuntime.shared.restart(); GuardLogModel.shared.record(.configuration, .info, "连接恢复已返回", detail: note ?? "") }
        } catch { note = error.localizedDescription }
    }
    func loadHistory() async {
        do { history = try await request("desktop-environment.mjs", ["action": "history"]).history ?? [] }
        catch { note = error.localizedDescription }
    }
    func previewRepair(_ ids: [String]) async {
        let requestID = UUID(); previewRequest = requestID
        plan = []; planToken = nil
        guard !ids.isEmpty else { return }
        do {
            let result = try await request("desktop-environment.mjs", ["action": "preview", "ids": ids.sorted()])
            guard !Task.isCancelled, previewRequest == requestID else { return }
            plan = result.plan ?? []; planToken = result.planToken
        } catch { if previewRequest == requestID { note = error.localizedDescription } }
    }
    func restoreEnvironment(_ id: String) async {
        guard busy == nil else { return }
        busy = "正在恢复环境设置…"
        GuardLogModel.shared.record(.environment, .info, "开始恢复环境更改")
        do {
            let result = try await request("desktop-environment.mjs", ["action": "restore", "id": id])
            history = result.history ?? []
            note = result.note
            GuardLogModel.shared.record(.environment, .info, "环境恢复已返回", detail: note ?? "")
        } catch { note = error.localizedDescription; GuardLogModel.shared.record(.environment, .error, "环境恢复未完成", detail: note ?? "") }
        busy = nil
        await check()
    }
}

/// 环境: the audit as a table that fills the page. Title follows the result; refresh,
/// 恢复记录 (with the baseline beside it) and 修复 N 项… sit at the top right.
struct GuardEnvironmentPage: View {
    @ObservedObject var desktop: GuardDesktopModel
    @ObservedObject var networkModel: GuardModel
    @State private var repairing = false
    @State private var showingRecords = false

    private struct Row: Identifiable {
        enum Mark { case ok, fixable, fail, warn, info, unknown }
        let id: String
        let title: String
        let current: String
        let target: String
        let mark: Mark
        var links: [(String, URL)] = []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TimelineView(.periodic(from: .now, by: 5)) { _ in
                GuardPageHeader(title: headline, subtitle: summary, subtitleColor: summaryColor) {
                    headerActions
                }
            }
            Spacer().frame(height: GuardMetrics.section)
            table
                .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, GuardMetrics.horizontal)
        .padding(.top, GuardMetrics.top)
        .padding(.bottom, GuardMetrics.bottom)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task {
            if desktop.audit?.fresh != true { await desktop.check() }
        }
        .nookSheet(isPresented: $repairing) {
            if let audit = desktop.audit { EnvironmentRepairSheet(rows: audit.rows.filter(\.fixable), model: desktop) }
        }
        .nookKeepsExpanded(while: $repairing)
        .nookSheet(isPresented: $showingRecords) { EnvironmentRecordsSheet(model: desktop) }
        .nookKeepsExpanded(while: $showingRecords)
    }

    // MARK: Header

    private var headline: String {
        guard let audit = desktop.audit else { return desktop.checking ? "正在检查环境" : "尚未检查环境" }
        if audit.configured == false { return "基础监测 · 保护未接入" }
        if !audit.fresh { return "环境检查已过期" }
        return audit.ready ? "环境检查通过" : "环境需要处理"
    }

    private var summary: String {
        if let busy = desktop.busy { return busy }
        if let note = desktop.note { return note }
        guard let audit = desktop.audit else {
            return desktop.auditError ?? "读取时区、地区、语言、IPv6、TUN 与 DNS 等启动条件"
        }
        let checked = "检查于 \(GuardLook.time(audit.checkedAt))"
        if audit.configured == false { return "接入固定出口后，检查结果才计入启动条件 · \(checked)" }
        if !audit.fresh { return "结果超过两分钟，请重新检查 · \(checked)" }
        let blocking = audit.rows.filter(\.blocking)
        let pending = blocking.filter { $0.state != "ok" }.count
        if audit.ready { return "\(blocking.count) 项启动条件均已满足 · \(checked)" }
        let fixable = audit.repairIds.isEmpty ? "请按提示手动处理" : "其中 \(audit.repairIds.count) 项可自动修复"
        return "\(pending) 项未通过，\(fixable) · \(checked)"
    }

    private var summaryColor: Color {
        if desktop.busy != nil || desktop.auditError != nil { return GuardInk.warning }
        if let audit = desktop.audit, !audit.fresh { return GuardInk.warning }
        return GuardInk.secondary
    }

    private var headerActions: some View {
        HStack(spacing: 8) {
            Button {
                networkModel.refreshLocalNow()
                Task { await desktop.check(activeSTUN: true) }
            } label: {
                if desktop.checking {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: "arrow.clockwise")
                }
            }
            .buttonStyle(GuardCircleButtonStyle())
            .disabled(desktop.checking || desktop.busy != nil)
            .help("重新检查环境，并运行本进程的 STUN / UDP 探针")
            .accessibilityLabel("重新检查环境")
            .accessibilityIdentifier("guard.environment.inspect")
            Button("恢复记录") { showingRecords = true }
                .buttonStyle(GuardPillButtonStyle())
                .help("查看环境更改并恢复；环境基线也在这里")
            if let audit = desktop.audit, !audit.repairIds.isEmpty {
                Button("修复 \(audit.repairIds.count) 项…") { repairing = true }
                    .buttonStyle(GuardPillButtonStyle(prominent: true))
                    .disabled(desktop.busy != nil || desktop.checking)
                    .accessibilityIdentifier("guard.environment.repair")
            }
        }
    }

    // MARK: Table

    private var rows: [Row] {
        var rows: [Row] = (desktop.audit?.rows ?? []).map { item in
            let split = item.detail.components(separatedBy: " · 目标 ")
            var current = split[0]
            var target = "—"
            if split.count > 1 {
                let rest = split[1]
                if let geo = rest.range(of: "；IP 地理参考 ") {
                    target = String(rest[..<geo.lowerBound])
                    current += "；IP 地理参考 " + rest[geo.upperBound...]
                } else {
                    target = rest
                }
            }
            let mark: Row.Mark
            switch item.state {
                case "ok": mark = .ok
                case "fail": mark = item.fixable ? .fixable : .fail
                case "warn": mark = .warn
                case "info": mark = .info
                default: mark = .unknown
            }
            return Row(id: item.id, title: item.title, current: current,
                       target: target, mark: mark)
        }
        let proxy: String
        switch networkModel.env?.proxy {
            case .on(let endpoint): proxy = "已开启 · \(endpoint)"
            case .pac(let url): proxy = "自动配置 · \(url)"
            case .off: proxy = "已关闭 · VPN / TUN 仍可能影响出口"
            case .unknown: proxy = "未读取到配置"
            case nil: proxy = "读取中…"
        }
        rows.append(Row(id: "local-proxy", title: "系统代理", current: proxy, target: "—", mark: .info))
        var browser = Row(id: "browser", title: "浏览器旁路", current: "在实际使用的浏览器里自检",
                          target: "DNS · WebRTC 无泄漏", mark: .info)
        if let dns = URL(string: "https://ip.net.coffee/dns/"), let webrtc = URL(string: "https://ip.net.coffee/webrtc/") {
            browser.links = [("DNS", dns), ("WebRTC", webrtc)]
        }
        rows.append(browser)
        return rows
    }

    private var table: some View {
        let items = rows
        return VStack(alignment: .leading, spacing: 0) {
            tableHeader
                .padding(.bottom, 6)
            Rectangle().fill(GuardInk.hairline).frame(height: 1)
            if desktop.audit == nil {
                Text(desktop.auditError ?? "正在读取本机环境…")
                    .font(GuardFont.body)
                    .foregroundStyle(GuardInk.tertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            } else {
                // Rows share the height left; with more rows than fit, the list scrolls.
                GeometryReader { proxy in
                    let rowHeight = max(34, proxy.size.height / CGFloat(max(items.count, 1)))
                    ScrollView(.vertical, showsIndicators: false) {
                        VStack(spacing: 0) {
                            ForEach(Array(items.enumerated()), id: \.element.id) { index, row in
                                tableRow(row)
                                    .frame(height: rowHeight - (index == items.count - 1 ? 0 : 1))
                                if index != items.count - 1 {
                                    Rectangle().fill(GuardInk.hairline).frame(height: 1)
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(.top, 12)
        .padding(.bottom, 4)
        .padding(.horizontal, 16)
        .guardCard()
    }

    private var tableHeader: some View {
        HStack(spacing: 12) {
            Text("项目").frame(width: 140, alignment: .leading)
            Text("当前").frame(maxWidth: .infinity, alignment: .leading)
            Text("目标").frame(width: 150, alignment: .leading)
            Text("状态").frame(width: 76, alignment: .trailing)
        }
        .font(GuardFont.make(11, .medium))
        .foregroundStyle(GuardInk.tertiary)
    }

    private func tableRow(_ row: Row) -> some View {
        HStack(spacing: 12) {
            Text(row.title)
                .font(GuardFont.make(12, .medium))
                .foregroundStyle(GuardInk.primary)
                .lineLimit(1)
                .frame(width: 140, alignment: .leading)
            Text(row.current)
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .help(row.current)
            Text(row.target)
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 150, alignment: .leading)
                .help(row.target)
            status(row)
                .frame(width: 76, alignment: .trailing)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func status(_ row: Row) -> some View {
        if !row.links.isEmpty {
            VStack(alignment: .trailing, spacing: 2) {
                ForEach(Array(row.links.enumerated()), id: \.offset) { _, link in
                    Link(destination: link.1) {
                        HStack(spacing: 2) {
                            Text(link.0)
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                            Image(systemName: "arrow.up.right").font(GuardFont.make(8, .semibold))
                        }
                    }
                    .font(GuardFont.make(11, .medium))
                    .foregroundStyle(GuardInk.primary)
                    .fixedSize(horizontal: true, vertical: false)
                    .lineLimit(1)
                }
            }
        } else {
            HStack(spacing: 5) {
                Circle().fill(color(row.mark)).frame(width: 6, height: 6)
                Text(label(row.mark))
                    .font(GuardFont.make(11, .medium))
                    .foregroundStyle(row.mark == .fixable || row.mark == .fail ? GuardInk.badText : GuardInk.secondary)
            }
        }
    }

    private func color(_ mark: Row.Mark) -> Color {
        switch mark {
            case .ok: GuardInk.success
            case .fixable, .fail: GuardInk.failure
            case .warn: GuardInk.warning
            case .info, .unknown: GuardInk.tertiary
        }
    }

    private func label(_ mark: Row.Mark) -> String {
        switch mark {
            case .ok: "通过"
            case .fixable: "可修复"
            case .fail: "未通过"
            case .warn: "需注意"
            case .info: "信息"
            case .unknown: "未确认"
        }
    }
}

/// 恢复记录 with the environment baseline beside it, one sheet.
private struct EnvironmentRecordsSheet: View {
    @ObservedObject var model: GuardDesktopModel
    @State private var page = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            GuardSegmented(options: [(0, "恢复记录"), (1, "环境基线")], selection: $page)
                .padding(.top, 18)
                .padding(.horizontal, 24)
            if page == 0 {
                GuardEnvironmentHistoryView(model: model)
            } else if let policy = model.audit?.policy {
                EnvironmentBaselineEditor(policy: policy, model: model)
            } else {
                Text("尚未取得环境检查结果，请先重新检查。")
                    .font(GuardFont.body)
                    .foregroundStyle(GuardInk.secondary)
                    .padding(24)
                    .frame(width: 480, alignment: .leading)
            }
        }
    }
}

private struct EnvironmentBaselineEditor: View {
    @State var policy: EnvironmentBaseline
    @ObservedObject var model: GuardDesktopModel
    @Environment(\.nookDismissPresentation) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("环境基线").font(.headline)
            Text("通用模板保留系统偏好；严格模板将地区、语言、IPv6 和 DNS 纳入启动条件。TUN 是否必须开启始终由实际守护配置决定。保存不会修改系统设置。")
                .font(.caption).foregroundStyle(.secondary)
            Form {
                Picker("环境模板", selection: Binding(get: { policy.template ?? "strict" }, set: { policy.template = $0; if $0 == "strict" && policy.country.isEmpty { policy.country = "US" } })) {
                    Text("通用 · 偏好仅提示").tag("standard")
                    Text("严格 · 基线必须通过").tag("strict")
                }
                Picker("网络服务", selection: Binding(get: { policy.networkService ?? "" }, set: { policy.networkService = $0 })) {
                    Text("自动选择活动服务").tag("")
                    ForEach(model.audit?.services ?? [], id: \.self) { Text($0).tag($0) }
                }
                TextField("出口国家代码（通用模板可留空）", text: $policy.country)
                TextField("时区", text: $policy.timezone)
                TextField("地区", text: $policy.locale)
                TextField("Claude 语言", text: $policy.language)
            }
            HStack { Spacer(); Button("取消") { dismiss() }; Button("保存基线") {
                Task { await model.saveBaseline(policy) }; dismiss()
            }.buttonStyle(.borderedProminent) }
        }.padding(24).frame(width: 480)
    }
}

private struct EnvironmentRepairSheet: View {
    let rows: [DesktopAudit.Row]
    @ObservedObject var model: GuardDesktopModel
    @Environment(\.nookDismissPresentation) private var dismiss
    @State private var selected: Set<String> = []
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("确认环境修复").font(.headline)
            Text("先预览更改，再确认执行。每次操作保留可恢复记录；时区和 IPv6 需要管理员验证，语言更改需重启 Claude。")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(rows) { row in
                Toggle(isOn: Binding(get: { selected.contains(row.id) }, set: { if $0 { selected.insert(row.id) } else { selected.remove(row.id) } })) {
                    VStack(alignment: .leading, spacing: 3) { Text(row.title); Text(row.detail).font(.caption).foregroundStyle(.secondary) }
                }
            }
            if !model.plan.isEmpty {
                Divider()
                ForEach(model.plan) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(item.title).font(.system(size: 11, weight: .medium))
                        Text(item.before + " → " + item.after).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            HStack { Spacer(); Button("取消") { dismiss() }; Button("应用所选修复") {
                let ids = Array(selected); dismiss(); Task { await model.repair(ids) }
            }.buttonStyle(.borderedProminent).disabled(selected.isEmpty || Set(model.plan.map(\.id)) != selected) }
        }.padding(24).frame(width: 500)
        .onAppear { selected = Set(rows.filter(\.blocking).map(\.id)) }
        .task(id: selected) { await model.previewRepair(Array(selected).sorted()) }
    }
}
