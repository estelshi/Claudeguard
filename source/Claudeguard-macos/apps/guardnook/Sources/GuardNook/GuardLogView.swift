import AppKit
import NookApp
import SwiftUI
import UniformTypeIdentifiers

/// The 日志 tab's categories. 连接 also lists the Claude gateway connections Clash
/// reports (the old 「最近 Claude 网关连接」 and 「最近连接记录」).
enum GuardLogFilter: Hashable, CaseIterable {
    case all
    case protection
    case connection
    case environment
    case configuration

    var title: String {
        switch self {
            case .all: "全部"
            case .protection: "守护"
            case .connection: "连接"
            case .environment: "环境"
            case .configuration: "配置"
        }
    }

    func includes(_ category: GuardLogCategory) -> Bool {
        switch self {
            case .all: true
            case .protection: category == .protection || category == .application
            case .connection: category == .network
            case .environment: category == .environment
            case .configuration: category == .configuration
        }
    }

    /// The column label for an entry's category.
    static func label(_ category: GuardLogCategory) -> String {
        switch category {
            case .application, .protection: "守护"
            case .network: "连接"
            case .environment: "环境"
            case .configuration: "配置"
            case .accounts: "历史"
        }
    }
}

/// 日志: one list for run events and gateway connections. Filter by category; levels
/// are part of the search text (type 错误 / 提醒 / 成功).
struct GuardLogView: View {
    @ObservedObject var model: GuardLogModel
    @ObservedObject var guardModel: GuardModel
    @ObservedObject var navigation: GuardNavigation
    @State private var query = ""
    @State private var confirmingClear = false
    @State private var exporting = false
    @State private var exportError: String?

    private struct Row: Identifiable {
        let id: String
        let at: Date
        let dot: Color
        let title: String
        let detail: String
        let category: String
        var entry: GuardLogEntry?
    }

    private var filteredEntries: [GuardLogEntry] {
        model.entries.reversed().filter {
            navigation.logFilter.includes($0.category) && $0.matches(query: query, category: nil, level: nil)
        }
    }

    private var connectionRows: [Row] {
        guard navigation.logFilter == .all || navigation.logFilter == .connection else { return [] }
        let log = guardModel.status?.connectionLog
        let fresh = log?.fresh == true
        var rows: [Row] = []
        if let events = log?.events, !events.isEmpty {
            rows = events.compactMap { event -> Row? in
                guard let at = event.at else { return nil }
                return Row(
                    id: "connection-" + event.id,
                    at: Date(timeIntervalSince1970: at / 1000),
                    dot: fresh && event.active == true ? GuardInk.success : GuardInk.tertiary,
                    title: event.host ?? "—",
                    detail: event.sourceLabel.map { "守护网关 · \($0)" } ?? "守护网关",
                    category: "连接"
                )
            }
        } else if let events = guardModel.status?.events {
            rows = events.enumerated().compactMap { index, event -> Row? in
                guard let at = event.at else { return nil }
                return Row(
                    id: "event-\(index)-\(at)",
                    at: Date(timeIntervalSince1970: at / 1000),
                    dot: GuardInk.tertiary,
                    title: event.host ?? "—",
                    detail: event.proto.map { "守护网关 · \($0)" } ?? "守护网关",
                    category: "连接"
                )
            }
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !needle.isEmpty else { return rows }
        return rows.filter { ($0.title + " " + $0.detail + " 连接").localizedCaseInsensitiveContains(needle) }
    }

    private var rows: [Row] {
        let entries = filteredEntries.map { entry -> Row in
            Row(id: entry.id.uuidString, at: entry.at, dot: tint(entry.level), title: entry.title,
                detail: entry.detail, category: GuardLogFilter.label(entry.category), entry: entry)
        }
        return (entries + connectionRows).sorted { $0.at > $1.at }
    }

    private func tint(_ level: GuardLogLevel) -> Color {
        switch level {
            case .info: GuardInk.tertiary
            case .success: GuardInk.success
            case .warning: GuardInk.warning
            case .error: GuardInk.failure
        }
    }

    var body: some View {
        let visible = rows
        VStack(alignment: .leading, spacing: 0) {
            GuardPageHeader(
                title: "日志",
                subtitle: model.storageNotice ?? exportError ?? "本地保留最近 1,000 条 · 已脱敏 · 新记录在前",
                subtitleColor: model.storageNotice != nil || exportError != nil ? GuardInk.warning : GuardInk.secondary
            ) {
                headerActions
            }
            Spacer().frame(height: GuardMetrics.section)
            HStack(spacing: 8) {
                GuardSegmented(
                    options: GuardLogFilter.allCases.map { ($0, $0.title) },
                    selection: $navigation.logFilter
                )
                .accessibilityIdentifier("guard.logs.category")
                Spacer(minLength: 8)
                Text("显示 \(visible.count) / \(model.entries.count + connectionTotal) 条")
                    .font(GuardFont.meta)
                    .monospacedDigit()
                    .foregroundStyle(GuardInk.tertiary)
            }
            Spacer().frame(height: GuardMetrics.gap)
            list(visible)
                .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, GuardMetrics.horizontal)
        .padding(.top, GuardMetrics.top)
        .padding(.bottom, GuardMetrics.bottom)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .nookSheet(isPresented: $confirmingClear) {
            VStack(alignment: .leading, spacing: 14) {
                Text("清空全部运行日志？").font(.headline)
                Text("会清空本地保留的日志。后续事件仍会继续记录；守护设置不受影响。")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("取消") { confirmingClear = false }
                        .accessibilityIdentifier("guard.logs.clear.cancel")
                    Button("清空日志", role: .destructive) { model.clear(); confirmingClear = false }
                        .accessibilityIdentifier("guard.logs.clear.confirm")
                }
            }.padding(24).frame(width: 420)
        }
        .nookKeepsExpanded(while: $confirmingClear)
        .nookKeepsExpanded(while: $exporting)
    }

    private var connectionTotal: Int {
        guardModel.status?.connectionLog?.events.count ?? guardModel.status?.events?.count ?? 0
    }

    private var headerActions: some View {
        HStack(spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .font(GuardFont.make(10.5, .medium))
                    .foregroundStyle(GuardInk.tertiary)
                TextField("搜索日志", text: $query)
                    .textFieldStyle(.plain)
                    .font(GuardFont.make(11.5))
                    .foregroundStyle(GuardInk.primary)
                    .accessibilityLabel("搜索日志")
                    .accessibilityIdentifier("guard.logs.search")
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(GuardInk.tertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("清除搜索")
                }
            }
            .padding(.horizontal, 10)
            .frame(width: 170, height: 28)
            .background(Capsule().fill(Color.white.opacity(0.045)))
            .overlay(Capsule().strokeBorder(GuardInk.hairline, lineWidth: 1))
            .help("搜索标题、详情、分类；输入「错误」「提醒」「成功」按级别查找")
            Button { export() } label: { Image(systemName: "square.and.arrow.up") }
                .buttonStyle(GuardCircleButtonStyle())
                .disabled(filteredEntries.isEmpty || exporting)
                .help("导出当前筛选的日志（已脱敏）")
                .accessibilityLabel("导出日志")
                .accessibilityIdentifier("guard.logs.export")
            Button { confirmingClear = true } label: { Image(systemName: "trash") }
                .buttonStyle(GuardCircleButtonStyle())
                .disabled(model.entries.isEmpty)
                .help("清空全部运行日志")
                .accessibilityLabel("清空全部运行日志")
                .accessibilityIdentifier("guard.logs.clear")
        }
    }

    private func list(_ visible: [Row]) -> some View {
        Group {
            if visible.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.entries.isEmpty && connectionTotal == 0 ? "暂无日志" : "没有匹配的日志")
                        .font(GuardFont.label)
                        .foregroundStyle(GuardInk.secondary)
                    Text(model.entries.isEmpty ? "后续状态变化和操作结果会自动记录。" : "试试其他关键词或分类。")
                        .font(GuardFont.meta)
                        .foregroundStyle(GuardInk.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(16)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(visible.enumerated()), id: \.element.id) { index, row in
                            rowView(row)
                            if index != visible.count - 1 {
                                Rectangle().fill(GuardInk.hairline).frame(height: 1)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .guardCard()
        .accessibilityIdentifier("guard.logs.list")
    }

    private func rowView(_ row: Row) -> some View {
        HStack(spacing: 10) {
            Text(GuardLook.clock(row.at))
                .font(GuardFont.meta)
                .monospacedDigit()
                .foregroundStyle(GuardInk.tertiary)
                .frame(width: 58, alignment: .leading)
            Circle().fill(row.dot).frame(width: 6, height: 6)
            Text(row.title)
                .font(GuardFont.make(12, .medium))
                .foregroundStyle(GuardInk.primary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(width: 180, alignment: .leading)
            Text(row.detail)
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(row.category)
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
                .frame(width: 30, alignment: .trailing)
        }
        .frame(height: 30)
        .contentShape(Rectangle())
        .help(row.detail.isEmpty ? row.title : row.title + "\n" + row.detail)
        .contextMenu {
            Button("复制这条日志") {
                let text: String
                if let entry = row.entry {
                    text = GuardLogFile.export([entry])
                } else {
                    text = GuardLogPrivacy.redact("\(GuardLook.clock(row.at)) [连接] \(row.title) \(row.detail)")
                }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        }
    }

    private func export() {
        let entries = filteredEntries
        guard !entries.isEmpty else { return }
        exporting = true
        exportError = nil
        let panel = NSSavePanel()
        panel.title = "导出运行日志（已脱敏）"
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "GuardNook-日志-\(Date.now.formatted(.iso8601.year().month().day().dateSeparator(.dash))).txt"
        panel.begin { response in
            defer { exporting = false }
            guard response == .OK, let url = panel.url else { return }
            do { try GuardLogFile.export(entries).write(to: url, atomically: true, encoding: .utf8) }
            catch { exportError = "日志导出失败，请检查所选位置的写入权限。" }
        }
    }
}
