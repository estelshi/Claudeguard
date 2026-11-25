import AppKit
import SwiftUI

// MARK: - Setup wizard (work/mac-redesign/IA-PROPOSAL.md §3)
//
// Four steps in a 680 × 560 window: 识别 Clash / 入口与出口 / 应用到 Clash / 确认出口.
// Only the presentation changed: every action calls the same GuardSetupModel methods
// as before (relay save, SOCKS5 keychain, Clash apply, personal-script errors).
//
// Mapping to the model: step 1 = model.step 1 (connection); step 2 = model.step
// exitStep (the old 选择出口 and 预览 pages, saved by 「保存，下一步」); step 3 = the
// completed state (apply + live checklist); step 4 = completed + `confirming`.

struct GuardSetupView: View {
    @StateObject private var model = GuardSetupModel()
    @State private var confirming = false
    @State private var confirmingApply = false
    @State private var manualImport = false
    @State private var showingAdvanced = false
    var onFinish: (() -> Void)? = nil
    var openExitSettings = false

    private static let vergeBundleID = "io.github.clash-verge-rev.clash-verge-rev"
    private let titles = ["识别 Clash", "入口与出口", "应用到 Clash", "确认出口"]

    /// -1 = monitoring finished; 0…3 = the four steps.
    private var stage: Int {
        if model.completed {
            if model.mode == "monitor" { return -1 }
            return confirming ? 3 : 2
        }
        return model.step >= GuardSetupModel.exitStep ? 1 : 0
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if stage >= 0 {
                stepper
                    .padding(.top, 18)
                Spacer().frame(height: 24)
            } else {
                Spacer().frame(height: 28)
            }
            header
            Spacer().frame(height: 20)
            ScrollView(.vertical, showsIndicators: false) {
                content
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 8)
            }
            // Keep focus rings inside the scroll view's clipping bounds.
            .contentMargins(.all, 2, for: .scrollContent)
            .frame(maxHeight: .infinity)
            Rectangle().fill(GuardInk.hairline).frame(height: 1)
            footer
                .padding(.vertical, 16)
        }
        .padding(.horizontal, GuardMetrics.horizontal)
        .frame(width: GuardMetrics.setupWindow.width, height: GuardMetrics.setupWindow.height)
        .background(GuardPanelBackground())
        .environment(\.colorScheme, .dark)
        .confirmationDialog("生成并选中独立订阅", isPresented: $confirmingApply, titleVisibility: .visible) {
            Button("生成并重启 Clash") { Task { await model.applyDeviceExit() } }
            Button("取消", role: .cancel) {}
        } message: {
            Text("会新建「GuardNook：出口 IP」独立订阅并设为当前订阅，原订阅保留在列表里。入口组包含上一步选中的全部入口节点。ClaudeGuard 会开启 Clash TUN 并重启 Clash，然后实测系统和 Claude 的出口。接管后的公网 TCP 使用固定 IPv4，UDP 会被阻断。")
        }
        .task {
            if openExitSettings, model.relayID != nil {
                model.editRelay()
                await model.readNodes(automatically: false)
                if model.connectionReady { model.step = GuardSetupModel.exitStep }
            } else if !model.completed {
                if model.step < 1 { model.step = 1 }
                await model.readNodes(automatically: GuardSettings.current == nil)
            }
        }
        .task(id: model.completed) {
            guard model.completed, model.mode == "guard" else { return }
            await model.refreshVerge()
            await model.refreshHomeEnvironment()
            var tick = 0
            while !Task.isCancelled {
                await model.refreshFinalChecks()
                tick += 1
                if tick % 10 == 0 { await model.refreshHomeEnvironment() }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    // MARK: - Stepper

    private var stepper: some View {
        HStack(spacing: 4) {
            ForEach(0..<titles.count, id: \.self) { index in
                let current = index == stage
                let done = index < stage
                HStack(spacing: 8) {
                    ZStack {
                        Circle().fill(done ? Color(guardHex: 0x2FA36B) : current ? GuardInk.accentText : Color.white.opacity(0.08))
                        if done {
                            Image(systemName: "checkmark")
                                .font(GuardFont.make(9, .bold))
                                .foregroundStyle(Color.white)
                        } else {
                            Text("\(index + 1)")
                                .font(GuardFont.make(11, .semibold))
                                .foregroundStyle(current ? Color.white : GuardInk.tertiary)
                        }
                    }
                    .frame(width: 20, height: 20)
                    Text(titles[index])
                        .font(GuardFont.make(12, current ? .semibold : .medium))
                        .foregroundStyle(current ? GuardInk.accentText : done ? GuardInk.primary : GuardInk.tertiary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 5)
                .frame(maxWidth: .infinity, minHeight: 30, maxHeight: 30)
                .background(Capsule().fill(current ? GuardInk.accentFill : Color.clear))
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(current ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(Color.white.opacity(0.045)))
        .overlay(Capsule().strokeBorder(GuardInk.hairline, lineWidth: 1))
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        switch stage {
            case 0:
                stepHeader("识别本机 Clash", "只读取节点列表，不改动你的订阅、当前节点和 Clash 设置")
            case 1:
                HStack(alignment: .bottom, spacing: 12) {
                    stepHeader("选择入口，填写固定出口",
                               model.relayMode ? "Claude 固定走「入口节点 → 你的 SOCKS5 出口」，其他应用不受影响"
                                               : "Claude 固定走你在 Clash 里已有的固定出口节点")
                    Spacer(minLength: 8)
                    GuardSegmented(options: [(true, "SOCKS5 中转"), (false, "已有固定节点")],
                                   selection: $model.relayMode)
                        .onChange(of: model.relayMode) { _, _ in model.confirmChanges = false }
                }
            case 2:
                if model.relayID != nil {
                    stepHeader("应用到 Clash", "新建独立订阅并设为当前订阅，原订阅保留；Clash 会重启约 5 秒")
                } else {
                    stepHeader("导入到 Clash", "把生成的脚本导入代理客户端的扩展脚本并重载，再启用保护")
                }
            case 3:
                stepHeader("确认固定出口", "确认后只允许这个 IPv4 访问 Claude；出口一旦变化会立即阻断")
            default:
                stepHeader("基础监测已就绪", "只显示本机网络，不修改分流，也不提供固定出口保护")
        }
    }

    private func stepHeader(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(GuardFont.wizardTitle)
                .foregroundStyle(GuardInk.primary)
                .lineLimit(1)
            Text(subtitle)
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .help(subtitle)
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        switch stage {
            case 0: connectionStep
            case 1: exitStep
            case 2:
                if model.relayID != nil { applyStep } else { importStep }
            case 3: confirmStep
            default: monitorDone
        }
    }

    // MARK: Step 1 · 识别 Clash

    private var connectionStep: some View {
        VStack(alignment: .leading, spacing: GuardMetrics.gap) {
            HStack(spacing: GuardMetrics.gap) {
                clientOption("verge", "Clash Verge Rev", "自动读取本机接口与密钥")
                clientOption("mihomo", "其他 Mihomo 客户端", "手动填写控制接口地址与密钥")
            }
            if model.personalRoutePresent {
                conflictCard
            } else {
                connectionStatusCard
            }
            controlCard
        }
    }

    private func clientOption(_ id: String, _ title: String, _ detail: String) -> some View {
        let selected = model.clientID == id
        return Button {
            model.selectClient(id)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(GuardFont.make(12.5, .semibold))
                        .foregroundStyle(GuardInk.primary)
                    Text(detail)
                        .font(GuardFont.meta)
                        .foregroundStyle(GuardInk.tertiary)
                }
                Spacer(minLength: 4)
                ZStack {
                    Circle().strokeBorder(selected ? GuardInk.primary : Color.white.opacity(0.24), lineWidth: 1.5)
                    if selected { Circle().fill(GuardInk.primary).frame(width: 7, height: 7) }
                }
                .frame(width: 16, height: 16)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .guardCard(radius: 16, raised: selected)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var connectionFailed: Bool {
        !model.busy && !model.connectionReady && model.nodes.isEmpty && model.message != nil
    }

    private var connectionStatusCard: some View {
        HStack(spacing: 10) {
            if model.busy {
                ProgressView().controlSize(.small)
            } else {
                GuardStatusDot(color: model.connectionReady ? GuardInk.success : connectionFailed ? GuardInk.failure : GuardInk.tertiary)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(model.busy ? "正在识别本机 Clash…"
                     : model.connectionReady ? "已连接 \(model.connectionSummary)"
                     : connectionFailed ? "未连接 Clash" : "尚未识别")
                    .font(GuardFont.make(12.5, .semibold))
                    .foregroundStyle(GuardInk.primary)
                    .lineLimit(1)
                Text(model.connectionReady ? "读到 \(model.nodes.count) 个节点 · 只读，不改订阅"
                     : model.message ?? "先打开 Clash，再点「重新识别」")
                    .font(GuardFont.meta)
                    .foregroundStyle(connectionFailed ? GuardInk.badText : GuardInk.tertiary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if connectionFailed && model.clientID == "verge" {
                Button("打开 Clash Verge") { openVerge() }
                    .buttonStyle(GuardPillButtonStyle())
            }
            Button {
                Task { await model.readNodes(automatically: true) }
            } label: {
                Label("重新识别", systemImage: "arrow.clockwise")
            }
            .buttonStyle(GuardPillButtonStyle())
            .disabled(model.busy)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .guardCard(radius: 16)
    }

    private var conflictCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("检测到个人版守护规则，不能在这里接入", systemImage: "exclamationmark.triangle.fill")
                .font(GuardFont.make(12.5, .semibold))
                .foregroundStyle(GuardInk.badText)
            Text(model.personalScript.map {
                "在\($0)中发现个人版规则。请保留现在的个人配置；只在独立测试环境中恢复这个脚本的原始版本，再重载 Clash。"
            } ?? "请保留现在的个人配置。在独立测试环境中，检查「订阅」里的全局扩展脚本和当前订阅的扩展脚本，恢复注入个人版规则之前的脚本。控制接口无法确定具体来源。")
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button {
                    Task { await model.readNodes(automatically: false) }
                } label: {
                    Label("重新检查", systemImage: "arrow.clockwise")
                }
                .buttonStyle(GuardPillButtonStyle())
                .disabled(model.busy)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(guardHex: 0x221819))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color(guardHex: 0xFF6B63, opacity: 0.20), lineWidth: 1)
        )
        .accessibilityIdentifier("guard.setup.personal-route-conflict")
    }

    private var controlCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("控制接口")
                    .font(GuardFont.sectionTitle)
                    .foregroundStyle(GuardInk.primary)
                Spacer()
                GuardSegmented(options: [(0, "本机 Socket"), (1, "本机 HTTP")], selection: $model.endpointKind, height: 24)
            }
            HStack(spacing: 8) {
                if model.endpointKind == 0 {
                    labeledField("地址") { TextField("/tmp/verge/verge-mihomo.sock", text: $model.socket) }
                } else {
                    labeledField("地址") { TextField("http://127.0.0.1:9090", text: $model.address) }
                }
                labeledField("密钥", invalid: connectionFailed) { SecureField("未设置可留空", text: $model.secret) }
                    .frame(width: 200)
                Button("连接") { Task { await model.readNodes() } }
                    .buttonStyle(GuardPillButtonStyle(height: 32))
                    .disabled(model.busy)
            }
            Text(connectionFailed
                 ? "在哪里找：Clash Verge → 设置 → Clash 设置 → 外部控制。只连接本机接口，不扫描网络。"
                 : "只连接本机接口，不扫描网络，不读取其他客户端的密码")
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .guardCard(radius: 16)
    }

    // MARK: Step 2 · 入口与出口

    private var exitStep: some View {
        VStack(alignment: .leading, spacing: GuardMetrics.gap) {
            HStack(alignment: .top, spacing: GuardMetrics.gap) {
                if model.relayMode {
                    entryCard
                    socksCard
                } else {
                    nodeCard
                    manualExitCard
                }
            }
            .frame(height: 236)
            advancedRow
            if let message = model.message {
                note(message)
            }
        }
    }

    private var entryCard: some View {
        let keyword = model.relayKeyword.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = model.relayCandidates.filter { $0.name.localizedCaseInsensitiveContains(keyword) }.count
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("入口节点")
                    .font(GuardFont.sectionTitle)
                    .foregroundStyle(GuardInk.primary)
                Spacer()
                GuardSegmented(options: [(false, "勾选"), (true, "关键词")], selection: $model.relayUseKeyword, height: 24)
            }
            if model.relayUseKeyword {
                labeledField("关键词") { TextField("例如：香港", text: $model.relayKeyword) }
                Text(keyword.isEmpty ? "入口组包含名称含关键词的全部节点" : "匹配 \(matches) 个入口节点")
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.tertiary)
                Spacer(minLength: 0)
            } else if model.relayCandidates.isEmpty {
                Text("没有可用的独立入口节点。请回到上一步重新识别 Clash。")
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.tertiary)
                Spacer(minLength: 0)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 0) {
                        ForEach(model.relayCandidates) { node in
                            checkboxRow(node.name, checked: model.relayNodes.contains(node.name)) { checked in
                                if checked { model.relayNodes.insert(node.name) } else { model.relayNodes.remove(node.name) }
                            }
                            if node.id != model.relayCandidates.last?.id {
                                Rectangle().fill(GuardInk.hairline).frame(height: 1)
                            }
                        }
                    }
                }
                .frame(maxHeight: .infinity)
            }
            HStack {
                Text(model.relayUseKeyword ? "入口失效时在 Clash 手动切换"
                     : "已选 \(model.relayNodes.count) / \(model.relayCandidates.count) · 入口失效时在 Clash 手动切换")
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.tertiary)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if !model.relayUseKeyword && !model.relayCandidates.isEmpty {
                    let all = model.relayCandidates.allSatisfy { model.relayNodes.contains($0.name) }
                    Button(all ? "全不选" : "全选") {
                        if all { model.relayNodes.removeAll() } else { model.relayNodes = Set(model.relayCandidates.map(\.name)) }
                    }
                    .buttonStyle(.plain)
                    .font(GuardFont.make(11, .medium))
                    .foregroundStyle(GuardInk.secondary)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .guardCard(radius: 16)
    }

    private var socksCard: some View {
        let portInvalid = !model.relayPort.isEmpty && Int(model.relayPort).map { (1...65535).contains($0) } != true
        let hostInvalid = !model.relayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !hostIsIPv4
        let pairInvalid = model.relayUsername.isEmpty != model.relayPassword.isEmpty
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("SOCKS5 出口")
                    .font(GuardFont.sectionTitle)
                    .foregroundStyle(GuardInk.primary)
                Spacer()
                Text("粘贴链接自动拆分")
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.tertiary)
            }
            HStack(spacing: 8) {
                SecureField("socks5://用户名:密码@地址:端口", text: $model.relayLink)
                    .onSubmit { Task { await model.parseRelayLink() } }
                    .guardField()
                if !model.relayLink.isEmpty {
                    Button("拆分") { Task { await model.parseRelayLink() } }
                        .buttonStyle(GuardPillButtonStyle(height: 32))
                        .disabled(model.busy)
                }
            }
            HStack(spacing: 8) {
                labeledField("地址", invalid: hostInvalid) { TextField("IPv4", text: $model.relayHost) }
                labeledField("端口", invalid: portInvalid) { TextField("1080", text: $model.relayPort) }
                    .frame(width: 120)
            }
            HStack(spacing: 8) {
                labeledField("账号", invalid: pairInvalid) { TextField("可选", text: $model.relayUsername) }
                labeledField("密码", invalid: pairInvalid) { SecureField("可选", text: $model.relayPassword) }
            }
            if hostInvalid || portInvalid || pairInvalid {
                Text(hostInvalid ? "地址需为 IPv4：应用到 Clash 时按这个地址核对实测出口"
                     : portInvalid ? "端口需为 1–65535 的整数" : "账号和密码需同时填写，或都留空")
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.badText)
            }
            Spacer(minLength: 0)
            Label(model.relayCredentialsSaved ? "账号密码已保存在 macOS 钥匙串" : "账号密码保存在 macOS 钥匙串",
                  systemImage: model.relayCredentialsSaved ? "checkmark.circle" : "lock")
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .guardCard(radius: 16)
    }

    private var hostIsIPv4: Bool {
        let host = model.relayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        return parts.count == 4 && parts.allSatisfy { part in Int(part).map { (0...255).contains($0) } == true }
    }

    private var nodeCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Claude 节点")
                .font(GuardFont.sectionTitle)
                .foregroundStyle(GuardInk.primary)
            Picker("Claude 节点", selection: $model.selected) {
                Text("请选择具体节点").tag("")
                ForEach(model.nodes) { Text("\($0.name) · \($0.type)").tag($0.name) }
            }
            .labelsHidden()
            .onChange(of: model.selected) { _, _ in
                model.measurement = nil
                model.confirmChanges = false
                model.reconcileFixedUpstream()
            }
            if let error = model.selectedNode?.chainError {
                Text(error).font(GuardFont.meta).foregroundStyle(GuardInk.badText)
            }
            if let chain = model.selectedNode?.upstreamChain, !chain.isEmpty {
                Text("已识别链路：" + chain.joined(separator: " → "))
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.tertiary)
                    .lineLimit(2)
            }
            Button("实测当前路径并校验所选节点（3 次）") { Task { await model.measure() } }
                .buttonStyle(GuardPillButtonStyle())
                .disabled(model.selectedNode == nil || model.manualExit || model.busy)
            if let measured = model.measurement {
                Text("实测出口：\(measured.ip) · \(measured.country) · \(measured.samples) 次一致")
                    .font(GuardFont.make(12, .medium))
                    .foregroundStyle(GuardInk.primary)
            }
            Spacer(minLength: 0)
            Text("先在代理客户端把 Claude 流量指向所选节点；向导不会改动你现有的代理组选择。")
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .guardCard(radius: 16)
    }

    private var manualExitCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("固定出口")
                .font(GuardFont.sectionTitle)
                .foregroundStyle(GuardInk.primary)
            switchRow("手动填写出口（未由本向导实测）", isOn: $model.manualExit)
            if model.manualExit {
                labeledField("IPv4") { TextField("你已确认的固定出口 IPv4", text: $model.expectedIP) }
                checkboxRow("我确认这个 IP 来自所选节点；保存后仍需实时验证才会放行",
                            checked: model.confirmManualExit) { model.confirmManualExit = $0 }
            } else {
                Text(model.expectedIP.isEmpty ? "左侧实测 3 次一致后，自动填入固定出口" : "固定出口：\(model.expectedIP)")
                    .font(GuardFont.body)
                    .foregroundStyle(GuardInk.secondary)
            }
            Spacer(minLength: 0)
            Text("保护只覆盖进入 Clash 守护规则的流量，未进入规则的请求不受保护。")
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .guardCard(radius: 16)
    }

    private var advancedRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                showingAdvanced.toggle()
            } label: {
                HStack {
                    Text(advancedSummary)
                        .font(GuardFont.body)
                        .foregroundStyle(GuardInk.secondary)
                        .lineLimit(1)
                    Spacer()
                    Image(systemName: showingAdvanced ? "chevron.down" : "arrow.right")
                        .font(GuardFont.make(10, .semibold))
                        .foregroundStyle(GuardInk.tertiary)
                }
                .padding(.horizontal, 16)
                .frame(height: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(showingAdvanced ? "已展开" : "已收起")
            .accessibilityIdentifier("guardnook.advanced-settings")
            if showingAdvanced {
                Rectangle().fill(GuardInk.hairline).frame(height: 1)
                VStack(alignment: .leading, spacing: 10) {
                    if model.relayMode {
                        switchRow("整机固定出口", isOn: $model.deviceWide)
                            .onChange(of: model.deviceWide) { _, _ in model.confirmChanges = false }
                        Text(model.deviceWide ? "应用时会自动重开 Clash 并启用 TUN。浏览器和普通应用与 Claude 共用固定出口，接管的 UDP 会被阻断。"
                             : "固定出口仅用于已接入 Claude 守护的流量。")
                            .font(GuardFont.meta)
                            .foregroundStyle(GuardInk.tertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    switchRow("固定出口保护要求开启 TUN（推荐）", isOn: $model.requireTun)
                    switchRow("启动时开始验证并启用保护", isOn: $model.startProtected)
                    HStack(spacing: 8) {
                        labeledField("面板") { TextField("端口", text: $model.serverPort) }
                        labeledField("客户端") { TextField("端口", text: $model.clientPort) }
                        labeledField("探测") { TextField("端口", text: $model.probePort) }
                        labeledField("网关") { TextField("端口", text: $model.gatewayPort) }
                    }
                    labeledField("固定上游") { TextField("补充固定上游名称（英文逗号分隔）", text: $model.chain) }
                    HStack(spacing: 8) {
                        Button("选择已有的原始扩展脚本…") { model.chooseScript() }
                            .buttonStyle(GuardPillButtonStyle())
                        Text(model.scriptName)
                            .font(GuardFont.meta)
                            .foregroundStyle(GuardInk.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Text("已有扩展脚本时请选择加入 ClaudeGuard 之前的原始版本，以保留内网和其他应用规则。")
                        .font(GuardFont.meta)
                        .foregroundStyle(GuardInk.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(16)
            }
        }
        .guardCard(radius: 16)
    }

    private var advancedSummary: String {
        var parts: [String] = []
        if model.relayMode { parts.append("整机固定出口：\(model.deviceWide ? "开" : "关")") }
        parts.append("要求 TUN：\(model.requireTun ? "开" : "关")")
        parts.append("端口与原始脚本")
        return parts.joined(separator: " · ")
    }

    private var exitBlocker: String? {
        if !model.connectionReady { return "Clash 连接已变化，请回到上一步重新识别" }
        if model.relayMode {
            let keyword = model.relayKeyword.trimmingCharacters(in: .whitespacesAndNewlines)
            if model.relayUseKeyword {
                if keyword.isEmpty { return "填写入口关键词" }
                if !model.relayCandidates.contains(where: { $0.name.localizedCaseInsensitiveContains(keyword) }) {
                    return "关键词没有匹配的入口"
                }
            } else if model.relayNodes.isEmpty {
                return "至少选 1 个入口"
            }
            if model.relayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "填写 SOCKS5 地址" }
            if !hostIsIPv4 { return "SOCKS5 地址需为 IPv4" }
            if Int(model.relayPort).map({ (1...65535).contains($0) }) != true { return "端口需为 1–65535" }
            if model.relayUsername.isEmpty != model.relayPassword.isEmpty { return "账号和密码需同时填写或都留空" }
            return nil
        }
        if model.selectedNode == nil { return "选择 Claude 节点" }
        if model.selectedNode?.chainError != nil { return "所选节点链路无法固定" }
        if model.manualExit {
            if model.expectedIP.isEmpty { return "填写固定出口 IPv4" }
            if !model.confirmManualExit { return "勾选确认出口来源" }
        } else if !model.exitReady {
            return "先实测 3 次并确认出口"
        }
        return model.exitReady ? nil : "检查入口与出口设置"
    }

    // MARK: Step 3 · 应用到 Clash

    private var standaloneSelected: Bool { model.verge?.standalone?.selected == true }

    private var applyStep: some View {
        VStack(alignment: .leading, spacing: GuardMetrics.gap) {
            applyCard
            if manualImport { manualImportCard }
            checklistCard
            if let message = model.message { note(message) }
        }
    }

    private var applyCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if model.vergeBusy {
                    ProgressView().controlSize(.small)
                } else {
                    GuardStatusDot(color: standaloneSelected ? GuardInk.success : GuardInk.tertiary)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(applyTitle)
                        .font(GuardFont.make(12.5, .semibold))
                        .foregroundStyle(GuardInk.primary)
                        .lineLimit(1)
                    Text(applyDetail)
                        .font(GuardFont.meta)
                        .foregroundStyle(GuardInk.tertiary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Button(manualImport ? "收起手动导入" : "改为手动导入") { manualImport.toggle() }
                    .buttonStyle(GuardPillButtonStyle())
                    .disabled(model.generatedPath == nil)
                if standaloneSelected {
                    Button("重新应用") { confirmingApply = true }
                        .buttonStyle(GuardPillButtonStyle())
                        .disabled(model.vergeBusy || model.generatedPath == nil)
                } else {
                    Button("应用并重启 Clash") { confirmingApply = true }
                        .buttonStyle(GuardPillButtonStyle(prominent: true))
                        .disabled(model.vergeBusy || model.generatedPath == nil)
                }
            }
            if let feedback = model.applyFeedback, feedback.failed {
                HStack(alignment: .top, spacing: 8) {
                    Text(feedback.text)
                        .font(GuardFont.meta)
                        .foregroundStyle(GuardInk.badText)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    Spacer(minLength: 4)
                    if feedback.text.contains("钥匙串") {
                        Button("允许读取钥匙串") { Task { await model.applyDeviceExit() } }
                            .buttonStyle(GuardPillButtonStyle())
                            .disabled(model.vergeBusy)
                    } else if feedback.text.contains("打开 Clash Verge") {
                        Button("打开 Clash Verge") { openVerge() }
                            .buttonStyle(GuardPillButtonStyle())
                    }
                }
            }
            if !model.relayConfirmed && !standaloneSelected {
                Text("应用后用中转实测确认出口 IP；若实测与 SOCKS5 地址不一致会提示。")
                    .font(GuardFont.meta)
                    .foregroundStyle(GuardInk.tertiary)
            }
        }
        .padding(16)
        .guardCard(radius: 16)
    }

    private var applyTitle: String {
        if model.vergeBusy { return "正在应用到 Clash" }
        if standaloneSelected {
            let name = model.verge?.standalone?.name ?? "GuardNook"
            return "已应用独立订阅「\(name)」"
        }
        return "尚未应用到 Clash"
    }

    private var applyDetail: String {
        if let feedback = model.applyFeedback, !feedback.failed { return feedback.text }
        if standaloneSelected { return model.vergeCaption ?? "原订阅仍在 Clash Verge 列表里" }
        return model.vergePrompt ?? "应用后会选中守护用的独立订阅，并保留原订阅"
    }

    private var manualImportCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("手动导入")
                .font(GuardFont.sectionTitle)
                .foregroundStyle(GuardInk.primary)
            Text("1 · 复制脚本，在 Clash Verge「订阅」里粘贴为扩展脚本。\n2 · 保存并重新激活订阅。\n3 · 回到这里，等下方检测项更新。")
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Button("复制脚本") { model.copyGeneratedScript() }
                    .buttonStyle(GuardPillButtonStyle())
                    .disabled(model.vergeBusy)
                if let path = model.generatedPath {
                    Button("显示生成的脚本") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                        .buttonStyle(GuardPillButtonStyle())
                }
                Spacer()
            }
            Text("脚本含出口和网关凭据，只在本机使用，不要分享。")
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
        }
        .padding(16)
        .guardCard(radius: 16)
    }

    private struct CheckItem: Identifiable {
        enum Fix { case openVerge, credentials, ipv6 }
        let id: String
        let title: String
        let detail: String
        let passed: Bool?
        var fix: (String, Fix)?
    }

    private var relayChecks: [CheckItem] {
        let status = model.finalStatus
        let relay = model.relayStatus?.relay
        let saved = GuardSettings.current?.relay
        let rules: Bool? = model.verge?.loaded
        let rulesDetail: String
        switch model.verge?.reason ?? "" {
            case _ where rules == true: rulesDetail = "规则已在最前面"
            case "rules-shadowed": rulesDetail = "被前面的 REJECT 规则挡住"
            case "rules-not-at-top": rulesDetail = "规则不在运行配置最前面"
            case "controller-unavailable": rulesDetail = "暂时连不上 Clash"
            default: rulesDetail = model.verge == nil ? "等待读取 Clash" : "待重新激活订阅"
        }
        let entry = relay?.stages["entry"]
        let exit = relay?.stages["exit"]
        let entryName = relay?.entry?.name
        let entryDetail = [entryName, (relay?.entry?.delay ?? entry?.durationMs).map { "\($0) ms" }]
            .compactMap { $0 }.joined(separator: " · ")
        let tun = status?.tunEnabled
        let ipv6Present = model.environment?.globalIPv6
        let openServices = (model.environment?.services ?? []).filter { $0.mode != "Off" }.map(\.name)
        return [
            CheckItem(id: "rules", title: "Clash 已载入守护规则", detail: rulesDetail, passed: rules,
                      fix: rules == false ? ("打开 Clash Verge", CheckItem.Fix.openVerge) : nil),
            CheckItem(id: "tun", title: "TUN 已开启",
                      detail: tun == true ? "已开启" : tun == false ? "未开启 · 重新应用会开启 TUN" : "等待守护状态",
                      passed: tun, fix: tun == false ? ("打开 Clash Verge", CheckItem.Fix.openVerge) : nil),
            CheckItem(id: "entry", title: "入口节点可达",
                      detail: entryDetail.isEmpty ? (entry == nil ? "等待前置步骤" : "—") : entryDetail,
                      passed: entry?.ok, fix: entry?.ok == false ? ("切换入口", CheckItem.Fix.openVerge) : nil),
            CheckItem(id: "exit", title: "SOCKS5 连接与认证",
                      detail: saved.map { "\($0.host):\($0.port)" } ?? "—",
                      passed: exit?.ok, fix: exit?.ok == false ? ("修改凭据", CheckItem.Fix.credentials) : nil),
            CheckItem(id: "ipv6", title: ipv6Present == true ? "IPv6 仍可出网" : "IPv6 未出网",
                      detail: ipv6Present == true ? (openServices.isEmpty ? "检测到可用 IPv6 出口" : openServices.joined(separator: "、"))
                          : ipv6Present == false ? "已关闭" : "等待检测",
                      passed: ipv6Present.map { !$0 }, fix: ipv6Present == true ? ("关闭 IPv6…", CheckItem.Fix.ipv6) : nil),
        ]
    }

    private var checklistCard: some View {
        let items = relayChecks
        return VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("检测项 · 持续更新")
                    .font(GuardFont.make(11, .medium))
                    .foregroundStyle(GuardInk.tertiary)
                Spacer()
                Button {
                    Task {
                        await model.recheckAcceptance()
                        await model.refreshHomeEnvironment()
                    }
                } label: {
                    if model.checkingClient || model.busy {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise")
                    }
                }
                .buttonStyle(GuardCircleButtonStyle(size: 24))
                .disabled(model.checkingClient || model.vergeBusy || model.busy)
                .help("重新检测")
                .accessibilityLabel("重新检测")
            }
            .padding(.vertical, 8)
            ForEach(items) { item in
                Rectangle().fill(GuardInk.hairline).frame(height: 1)
                checkRow(item)
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 4)
        .guardCard(radius: 16)
    }

    private func checkRow(_ item: CheckItem) -> some View {
        HStack(spacing: 10) {
            GuardCheckMark(passed: item.passed)
            Text(item.title)
                .font(GuardFont.make(12, .medium))
                .foregroundStyle(GuardInk.primary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(item.detail)
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            if let fix = item.fix {
                Button(fix.0) { runFix(fix.1) }
                    .buttonStyle(GuardPillButtonStyle(height: 26))
                    .disabled(model.busy || model.vergeBusy)
            }
        }
        .frame(minHeight: 38)
    }

    private func runFix(_ fix: CheckItem.Fix) {
        switch fix {
            case .openVerge: openVerge()
            case .credentials: goBackToInputs()
            case .ipv6:
                Task {
                    await model.disableIPv6()
                    await model.refreshHomeEnvironment()
                }
        }
    }

    private var checksPassed: Int { relayChecks.filter { $0.passed == true }.count }
    private var checksFailed: Bool { relayChecks.contains { $0.passed == false } }

    /// Next opens once Clash runs the standalone profile and no check has failed
    /// (a check still waiting for data does not hold it back).
    private var applyReady: Bool {
        model.canFinishSetup && !checksFailed && !model.vergeBusy
    }

    private var applyStatus: String {
        let count = "\(checksPassed) / \(relayChecks.count) 通过"
        if !standaloneSelected { return count + " · 先应用到 Clash" }
        if let failing = relayChecks.first(where: { $0.passed == false }) {
            switch failing.id {
                case "ipv6": return count + " · 关闭 IPv6 后继续"
                case "rules": return count + " · 重新激活订阅后继续"
                case "tun": return count + " · 开启 TUN 后继续"
                case "entry": return count + " · 切换入口后继续"
                default: return count + " · 修改凭据后继续"
            }
        }
        return count
    }

    /// Without a relay (existing fixed node), the old import-and-verify page.
    private var importStep: some View {
        let status = model.finalStatus
        return VStack(alignment: .leading, spacing: GuardMetrics.gap) {
            VStack(alignment: .leading, spacing: 10) {
                Text("1 · 显示生成的脚本，在代理客户端的扩展脚本中导入。\n2 · 保存并重载客户端配置。\n3 · 点「启用保护」，守护会连续验证出口。")
                    .font(GuardFont.body)
                    .foregroundStyle(GuardInk.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    if let path = model.generatedPath {
                        Button("显示生成的脚本") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                            .buttonStyle(GuardPillButtonStyle())
                    }
                    Button("启用保护") { Task { await model.verifyIntegration() } }
                        .buttonStyle(GuardPillButtonStyle(prominent: true))
                        .disabled(model.busy)
                    Spacer()
                }
            }
            .padding(16)
            .guardCard(radius: 16)
            VStack(alignment: .leading, spacing: 0) {
                checkRow(CheckItem(id: "prepared", title: "Clash 已载入守护规则",
                                   detail: status?.prepared == true ? "已载入" : "导入并重载后自动更新",
                                   passed: status?.prepared))
                Rectangle().fill(GuardInk.hairline).frame(height: 1)
                checkRow(CheckItem(id: "verified", title: "固定出口已验证",
                                   detail: status?.verifiedNow == true ? (status?.expectedIP ?? "已验证") : (status?.headline ?? "等待守护状态"),
                                   passed: status?.verifiedNow == true ? true : nil))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .guardCard(radius: 16)
            if let message = model.message { note(message) }
        }
    }

    // MARK: Step 4 · 确认出口

    private var awaitingConfirmation: Bool { model.finalStatus?.reason == "relay-awaiting-confirmation" }

    private var measuredIP: String? {
        if awaitingConfirmation { return model.finalStatus?.last?.ip }
        return model.finalClientProbe?.ip ?? model.finalStatus?.last?.ip
    }

    private var relayHostIPv4: String? {
        guard let host = GuardSettings.current?.relay?.host else { return nil }
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ Int($0).map { (0...255).contains($0) } == true }) else { return nil }
        return host
    }

    private var exitMismatch: Bool {
        guard let measured = measuredIP, let host = relayHostIPv4 else { return false }
        return measured != host
    }

    private var confirmStep: some View {
        let status = model.finalStatus
        let measured = measuredIP
        let mismatch = exitMismatch
        var detailParts: [String] = []
        if let successes = status?.successes, successes > 0 { detailParts.append("连续 \(successes) 次一致") }
        if let location = status?.last?.location, !location.isEmpty {
            detailParts.append(Locale(identifier: "zh_CN").localizedString(forRegionCode: location) ?? location)
        }
        if let entry = status?.relay?.entry?.name { detailParts.append("经 \(entry) → SOCKS5") }
        let systemIP = model.systemIPv4?.currentIP(now: .now)
        return VStack(alignment: .leading, spacing: GuardMetrics.gap) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 6) {
                    GuardStatusDot(color: measured == nil ? GuardInk.tertiary : mismatch ? GuardInk.failure : GuardInk.success)
                        .padding(-3)
                    Text("Claude 通道实测出口")
                        .font(GuardFont.make(12, .semibold))
                        .foregroundStyle(Color.white.opacity(0.95))
                }
                Spacer(minLength: 10)
                Text(measured ?? "等待实测…")
                    .font(GuardFont.number(40))
                    .foregroundStyle(Color.white.opacity(measured == nil ? 0.55 : 0.95))
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .textSelection(.enabled)
                Text(mismatch ? "与 SOCKS5 地址 \(relayHostIPv4 ?? "—") 不一致" : (detailParts.isEmpty ? "守护入口实测后显示" : detailParts.joined(separator: " · ")))
                    .font(GuardFont.meta)
                    .foregroundStyle(mismatch ? GuardInk.badText : Color.white.opacity(0.62))
                    .lineLimit(1)
                    .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, minHeight: 148, alignment: .topLeading)
            .padding(.vertical, 16)
            .padding(.horizontal, 18)
            .background {
                ZStack {
                    Color(guardHex: 0x1B1C21)
                    GuardFill.violet.gradient.opacity(mismatch ? 0.14 : 0.30)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: GuardMetrics.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: GuardMetrics.cardRadius, style: .continuous)
                    .strokeBorder(mismatch ? Color(guardHex: 0xFF6B63, opacity: 0.45) : GuardFill.violet.stroke, lineWidth: 1)
            }
            VStack(alignment: .leading, spacing: 0) {
                checkRow(CheckItem(id: "socks", title: "与 SOCKS5 地址一致",
                                   detail: relayHostIPv4 ?? "SOCKS5 地址为域名，以实测为准",
                                   passed: measured == nil || relayHostIPv4 == nil ? nil : !mismatch))
                if model.deviceWide {
                    Rectangle().fill(GuardInk.hairline).frame(height: 1)
                    checkRow(CheckItem(id: "system", title: "系统网络同出口",
                                       detail: systemIP == nil ? "保护生效后实测" : (systemIP == measured ? "整机固定出口已生效" : systemIP ?? "—"),
                                       passed: systemIP == nil || measured == nil ? nil : systemIP == measured))
                }
                Rectangle().fill(GuardInk.hairline).frame(height: 1)
                checkRow(CheckItem(id: "verified", title: "Claude 守护通道已验证",
                                   detail: status?.verifiedNow == true ? "保护已生效" : (status?.headline ?? "等待守护状态"),
                                   passed: status?.verifiedNow == true ? true : nil))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 4)
            .guardCard(radius: 16)
            if let message = model.message { note(message) }
        }
    }

    // MARK: Monitoring

    private var monitorDone: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("基础监测保留系统设置，不提供固定出口保护。可随时从设置重新打开向导，接入自己的节点。")
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let message = model.message { note(message) }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .guardCard(radius: 16)
    }

    // MARK: - Footer

    @ViewBuilder
    private var footer: some View {
        HStack(spacing: 10) {
            switch stage {
                case 0:
                    if GuardSettings.current == nil {
                        Button("稍后配置，仅观测") { startMonitoring() }
                            .buttonStyle(.plain)
                            .font(GuardFont.make(12, .medium))
                            .foregroundStyle(GuardInk.secondary)
                            .disabled(model.busy)
                    }
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    if model.personalRoutePresent && GuardSettings.current == nil {
                        Button("改为仅观测") { startMonitoring() }
                            .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
                            .disabled(model.busy)
                    } else {
                        Button { model.step = GuardSetupModel.exitStep } label: { nextLabel("下一步") }
                            .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
                            .disabled(!model.connectionReady || model.busy)
                    }
                case 1:
                    Button("上一步") {
                        model.step = 1
                        model.confirmChanges = false
                    }
                    .buttonStyle(GuardPillButtonStyle(height: 34))
                    footerStatus(exitBlocker ?? "保存后在下一步应用到 Clash")
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    Button {
                        Task {
                            model.confirmChanges = true
                            await model.save()
                            if !model.completed { model.confirmChanges = false }
                        }
                    } label: { nextLabel("保存，下一步") }
                    .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
                    .disabled(model.busy || exitBlocker != nil)
                    .keyboardShortcut(.defaultAction)
                case 2:
                    Button("上一步") { goBackToInputs() }
                        .buttonStyle(GuardPillButtonStyle(height: 34))
                        .disabled(model.vergeBusy)
                    footerStatus(model.relayID != nil ? applyStatus
                                 : (model.canFinishSetup ? "规则已载入" : "导入脚本并重载后继续"))
                    Spacer()
                    Button { confirming = true } label: { nextLabel("下一步") }
                        .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
                        .disabled(model.relayID != nil ? !applyReady : !model.canFinishSetup)
                case 3:
                    Button("上一步") { confirming = false }
                        .buttonStyle(GuardPillButtonStyle(height: 34))
                    footerStatus(model.finalStatus?.verifiedNow == true ? "保护已生效，守护会继续运行" : "确认前 Claude 保持阻断")
                    Spacer()
                    if model.busy { ProgressView().controlSize(.small) }
                    confirmActions
                default:
                    Spacer()
                    Button("完成") { finish() }
                        .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
                        .keyboardShortcut(.defaultAction)
            }
        }
    }

    @ViewBuilder
    private var confirmActions: some View {
        let status = model.finalStatus
        if awaitingConfirmation, let measured = measuredIP {
            if exitMismatch {
                Button("修改出口") { goBackToInputs() }
                    .buttonStyle(GuardPillButtonStyle(height: 34))
                    .disabled(model.busy)
            }
            Button(exitMismatch ? "仍以实测 IP 为准" : "确认并启用保护") {
                Task {
                    await model.confirmRelay(ip: measured)
                    if model.relayConfirmed { finish() }
                }
            }
            .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
            .disabled(model.busy)
            .keyboardShortcut(.defaultAction)
        } else if status?.manual == true || status?.reason == "ready-not-enabled" || status?.reason == "manual-block" {
            Button("启用保护") {
                Task {
                    await model.verifyIntegration()
                    finish()
                }
            }
            .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
            .disabled(model.busy)
        } else if model.relayConfirmed || status?.verifiedNow == true || model.relayID == nil {
            Button("完成") { finish() }
                .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
                .keyboardShortcut(.defaultAction)
        } else {
            Button("重新实测") { Task { await model.recheckAcceptance() } }
                .buttonStyle(GuardPillButtonStyle(height: 34))
                .disabled(model.busy || model.checkingClient)
            Button("确认并启用保护") {}
                .buttonStyle(GuardPillButtonStyle(prominent: true, height: 34))
                .disabled(true)
                .help("等待守护入口实测出口")
        }
    }

    private func footerStatus(_ text: String) -> some View {
        Text(text)
            .font(GuardFont.meta)
            .foregroundStyle(GuardInk.tertiary)
            .lineLimit(1)
            .truncationMode(.tail)
            .help(text)
    }

    private func nextLabel(_ title: String) -> some View {
        HStack(spacing: 5) {
            Text(title)
            Image(systemName: "arrow.right").font(GuardFont.make(10, .semibold))
        }
    }

    // MARK: - Pieces

    private func labeledField<Field: View>(_ label: String, invalid: Bool = false, @ViewBuilder field: () -> Field) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(GuardFont.meta)
                .foregroundStyle(GuardInk.tertiary)
                .fixedSize()
            field()
                .textFieldStyle(.plain)
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.primary)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: 32, maxHeight: 32, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.045)))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(invalid ? GuardInk.badText.opacity(0.7) : GuardInk.hairline, lineWidth: 1)
        )
    }

    private func checkboxRow(_ title: String, checked: Bool, _ toggle: @escaping (Bool) -> Void) -> some View {
        Button {
            toggle(!checked)
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(checked ? GuardInk.accentFill : Color.clear)
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(checked ? Color.clear : Color.white.opacity(0.24), lineWidth: 1.5)
                    if checked {
                        Image(systemName: "checkmark")
                            .font(GuardFont.make(9, .bold))
                            .foregroundStyle(GuardInk.accentText)
                    }
                }
                .frame(width: 16, height: 16)
                Text(title)
                    .font(GuardFont.body)
                    .foregroundStyle(GuardInk.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 32)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(checked ? .isSelected : [])
    }

    private func switchRow(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            Text(title)
                .font(GuardFont.body)
                .foregroundStyle(GuardInk.primary)
        }
        .toggleStyle(.switch)
        .controlSize(.small)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(GuardFont.meta)
            .foregroundStyle(GuardInk.secondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(.horizontal, 4)
    }

    // MARK: - Actions

    private func openVerge() {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.vergeBundleID) {
            NSWorkspace.shared.open(url)
        }
    }

    private func startMonitoring() {
        model.chooseMonitoring()
        Task { await model.saveMonitor() }
    }

    /// Back from 应用 / 确认 to the inputs: the old 「重新配置中转」.
    private func goBackToInputs() {
        confirming = false
        model.editRelay()
        Task {
            if !model.connectionReady { await model.readNodes(automatically: false) }
            if model.connectionReady { model.step = GuardSetupModel.exitStep }
        }
    }

    private func finish() {
        if let onFinish { onFinish() } else { NSApp.keyWindow?.performClose(nil) }
    }
}

@MainActor
enum GuardSetupWindow {
    private static var controller: NSWindowController?
    static func show(openExitSettings: Bool = false) {
        if openExitSettings, let previous = controller {
            previous.window?.close()
            controller = nil
        }
        if let controller { controller.showWindow(nil); controller.window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        let size = GuardMetrics.setupWindow
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height),
                              styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "配置固定出口"
        // Match the dark panel: title bar on the same solid #000000 as the content area.
        window.appearance = NSAppearance(named: .darkAqua)
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(srgbRed: 0, green: 0, blue: 0, alpha: 1)
        window.contentView = NSHostingView(rootView: GuardSetupView(onFinish: { [weak window] in
            window?.performClose(nil)
        }, openExitSettings: openExitSettings))
        window.setContentSize(size)
        window.isReleasedWhenClosed = false
        window.center()
        let controller = NSWindowController(window: window)
        Self.controller = controller
        controller.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
