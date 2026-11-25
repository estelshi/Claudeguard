import AppKit
import Foundation
import SwiftUI

struct SetupNode: Decodable, Sendable, Identifiable {
    var name: String
    var type: String
    var upstreamChain: [String]?
    var upstreamBindings: [String: String]?
    var chainError: String?
    var id: String { name }
}
struct SetupMeasurement: Decodable, Sendable {
    var id: String
    var at: Double
    var ip: String
    var country: String
    var samples: Int
}
struct SetupReply: Decodable, Sendable {
    struct SOCKSExit: Decodable, Sendable {
        var host: String
        var port: Int
        var username: String
        var password: String
    }
    var clientID: String?
    var clientTitle: String?
    var version: String?
    var measured: SetupMeasurement?
    var monitoring: Bool?
    var nodes: [SetupNode]?
    var controllerSocket: String?
    var controllerURL: String?
    var scriptPath: String?
    var error: String?
    var personalRoutePresent: Bool?
    var personalScript: String?
    var relayID: String?
    var exit: SOCKSExit?
    var environment: SetupEnvironment?
    var plan: [EnvironmentPlan]?
    var planToken: String?
    var note: String?
    var verge: SetupVerge?
}
struct SetupVerge: Decodable, Sendable {
    struct Profile: Decodable, Sendable {
        var uid: String?
        var name: String?
        var type: String?
    }
    struct Standalone: Decodable, Sendable {
        var uid: String?
        var name: String?
        var current: String?
        var installed: Bool?
        var selected: Bool?
    }
    var version: String?
    var name: String?
    var scriptPath: String?
    var scriptExists: Bool?
    var scriptSize: Int?
    var scriptSHA256: String?
    var currentProfile: Profile?
    var standalone: Standalone?
    var loaded: Bool?
    var entry: Bool?
    var exit: Bool?
    var guardRule: Bool?
    var atTop: Bool?
    var blockIndex: Int?
    var shadowCount: Int?
    var shadow: [String]?
    var reason: String?
    var backupPath: String?
    var applied: Bool?
    var unchanged: Bool?
    var restored: Bool?
}
struct SetupEnvironment: Decodable, Sendable {
    struct Service: Decodable, Identifiable, Sendable {
        var name: String
        var active: Bool
        var mode: String?
        var id: String { name }
    }
    var controllerOnline: Bool?
    var tunEnabled: Bool?
    var globalIPv6: Bool?
    var timezone: String
    var locale: String?
    var language: String?
    var services: [Service]
}
struct SetupFailure: LocalizedError, Sendable {
    var message: String
    var personalRoutePresent = false
    var personalScript: String?
    var errorDescription: String? { message }
}

@MainActor
final class GuardRuntime: ObservableObject {
    static let shared = GuardRuntime()
    @Published var note: String?
    private var service: Process?
    private var quitObserver: NSObjectProtocol?

    private init() {
        quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { Self.shared.stop() }
        }
    }
    nonisolated static var serviceDirectory: URL {
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent("GuardCore"),
            cwd.appendingPathComponent("packages/guard-core"),
            cwd.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("packages/guard-core"),
        ].compactMap { $0 }
        return candidates.first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("main.mjs").path) }
            ?? cwd.appendingPathComponent("packages/guard-core")
    }
    nonisolated static func nodeProcess() throws -> Process {
        let process = Process()
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x64"
        #endif
        if let resources = Bundle.main.resourceURL {
            let node = resources.appendingPathComponent("Runtime/\(arch)/node")
            if FileManager.default.isExecutableFile(atPath: node.path) { process.executableURL = node }
        }
        if process.executableURL == nil {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["node"] // source builds only; release apps include both runtimes
        }
        var environment = ProcessInfo.processInfo.environment
        #if DEBUG
        if let home = environment["GUARDNOOK_FIXTURE_HOME"] { environment["HOME"] = home }
        #endif
        environment["NODE_OPTIONS"] = ""
        environment["NODE_EXTRA_CA_CERTS"] = ""
        process.environment = environment
        return process
    }
    nonisolated static func helper(_ input: [String: Any]) throws -> SetupReply {
        let process = try nodeProcess()
        process.arguments = (process.arguments ?? []) + [serviceDirectory.appendingPathComponent("setup.mjs").path]
        let stdin = Pipe(), stdout = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = FileHandle.nullDevice
        try process.run()
        try stdin.fileHandleForWriting.write(contentsOf: JSONSerialization.data(withJSONObject: input))
        try stdin.fileHandleForWriting.close()
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard let reply = try? JSONDecoder().decode(SetupReply.self, from: data) else {
            throw SetupFailure(message: "配置助手没有返回有效结果，请重新启动应用后重试。")
        }
        if let error = reply.error {
            throw SetupFailure(message: error, personalRoutePresent: reply.personalRoutePresent == true, personalScript: reply.personalScript)
        }
        guard process.terminationStatus == 0 else { throw SetupFailure(message: "配置助手未完成，请检查运行环境。") }
        return reply
    }
    func startIfConfigured() {
        guard service == nil, FileManager.default.fileExists(atPath: GuardSettings.configURL.path) else { return }
        guard let settings = GuardSettings.current else { note = "配置文件不可读，请重新配置；尚未启用保护。"; return }
        guard let relay = settings.relay, relay.auth else {
            launch(settings: settings, credentials: nil)
            return
        }
        // Reading the keychain can wait on a system prompt. Keep it off the main
        // thread so the panel and its status polling stay responsive meanwhile.
        Task.detached(priority: .userInitiated) { [self] in
            let credentials = RelayKeychain.load(id: relay.id)
            await MainActor.run { launch(settings: settings, credentials: credentials) }
        }
    }
    private func launch(settings: GuardSettings, credentials: Data?) {
        guard service == nil else { return }
        do {
            let process = try Self.nodeProcess()
            let directory = Self.serviceDirectory
            process.arguments = (process.arguments ?? []) + [directory.appendingPathComponent("main.mjs").path, "--parent-pid", String(ProcessInfo.processInfo.processIdentifier), "--config", GuardSettings.configURL.path]
            if settings.startProtected == true { process.arguments?.append("--enforce") }
            var credentialPipe: Pipe?
            if credentials != nil {
                let pipe = Pipe()
                credentialPipe = pipe
                process.standardInput = pipe
                process.arguments?.append("--relay-credentials-stdin")
            }
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.service === process else { return }
                    self.service = nil
                    self.note = "守护服务已停止。请检查 Clash 接口或端口占用；尚未确认保护。"
                    GuardLogModel.shared.record(.application, .error, "应用管理的守护服务已停止", detail: self.note ?? "")
                }
            }
            try process.run()
            if let pipe = credentialPipe, let credentials {
                try? pipe.fileHandleForWriting.write(contentsOf: credentials)
                try? pipe.fileHandleForWriting.close()
            }
            service = process
            note = nil
        } catch {
            note = "守护服务未能启动，请检查本地运行环境。"
            GuardLogModel.shared.record(.application, .error, "守护服务启动失败", detail: note ?? "")
        }
    }
    func stop() {
        let previous = service
        service = nil
        if previous?.isRunning == true { previous?.terminate() }
    }
    func restart() async {
        let previous = service
        stop()
        for _ in 0..<50 {
            if previous?.isRunning != true { break }
            try? await Task.sleep(for: .milliseconds(100))
        }
        if previous?.isRunning == true { note = "旧服务尚未退出，未启动新服务。"; return }
        startIfConfigured()
    }
}

@MainActor
final class GuardSetupModel: ObservableObject {
    static let environmentStep = 2
    static let exitStep = 3
    static let previewStep = 4
    @Published var step = 0
    @Published var mode = "guard"
    @Published var clientID = "verge"
    @Published var clientTitle = "尚未连接"
    @Published var measurement: SetupMeasurement?
    @Published var manualExit = false
    @Published var confirmManualExit = false
    @Published var confirmChanges = false
    @Published var requireTun = true
    @Published var completed = false
    @Published var endpointKind = 0
    @Published var socket = "/tmp/verge/verge-mihomo.sock"
    @Published var address = "http://127.0.0.1:9090"
    @Published var secret = ""
    @Published var nodes: [SetupNode] = []
    @Published var selected = ""
    @Published var fixedUpstream = ""
    @Published var expectedIP = ""
    @Published var chain = ""
    @Published var serverPort = String(GuardSettings.serverPortDefault)
    @Published var clientPort = String(GuardSettings.clientPortDefault)
    @Published var probePort = String(GuardSettings.probePortDefault)
    @Published var gatewayPort = String(GuardSettings.gatewayPortDefault)
    @Published var startProtected = false
    @Published var busy = false
    @Published var message: String?
    @Published var originalScript = ""
    @Published var scriptName = "无原脚本时使用默认透传脚本"
    @Published var generatedPath: String?
    @Published var advanced = false
    @Published private(set) var personalRoutePresent = false
    @Published private(set) var personalScript: String?
    @Published var relayMode = false
    @Published var deviceWide = true
    @Published var relayLink = ""
    @Published var relayHost = ""
    @Published var relayPort = ""
    @Published var relayUsername = ""
    @Published var relayPassword = ""
    @Published var relayUseKeyword = false
    @Published var relayKeyword = ""
    @Published var relayNodes: Set<String> = []
    @Published private(set) var relayID: String?
    @Published private var savedRelay: GuardSettings.Relay?
    @Published private(set) var finalClientProbe: ClaudeProbe?
    @Published private(set) var systemIPv4: NetworkExitProbe?
    @Published private(set) var systemCloudflare: NetworkExitProbe?
    @Published private(set) var checkingClient = false
    @Published private(set) var environment: SetupEnvironment?
    @Published private(set) var preferencePlan: [EnvironmentPlan] = []
    @Published private(set) var finalStatus: GuardStatus?
    @Published private(set) var finalDiagnostics: GuardDiagnostics?
    @Published private(set) var verge: SetupVerge?
    @Published private(set) var vergeBusy = false
    @Published private(set) var applyFeedback: (text: String, failed: Bool)?
    private var nextClientCheck = Date.distantPast
    var relayStatus: GuardStatus? {
        guard let relayID, finalStatus?.relay?.id == relayID else { return nil }
        return finalStatus
    }
    var canFinishSetup: Bool {
        if mode == "monitor" { return true }
        if relayID != nil { return verge?.standalone?.selected == true }
        return finalStatus?.prepared == true || acceptanceReady
    }
    var acceptanceReady: Bool {
        guard let finalStatus, finalStatus.verifiedNow, let finalClientProbe,
              finalClientProbe.ok, let ip = finalClientProbe.ip, ip == finalStatus.expectedIP else { return false }
        if deviceWide && relayID != nil {
            guard finalStatus.deviceWide == true, systemIPv4?.currentIP(now: .now) == ip,
                  systemCloudflare?.currentIP(now: .now) == ip else { return false }
        }
        return Date.now.timeIntervalSince(finalClientProbe.at) < 35
    }
    private var preferencePlanToken: String?
    private var plannedPreferences: [String] = []
    var readyForExit: Bool { environment != nil && (!requireTun || environment?.tunEnabled == true || clientID == "verge") }
    var eastUSPreferenceChanges: [String] {
        guard let environment else { return [] }
        return [
            environment.timezone == "America/New_York" ? nil : "timezone",
            environment.locale == "en_US" ? nil : "locale",
            environment.language == "en-US" ? nil : "language",
        ].compactMap { $0 }
    }
    var relayCandidates: [SetupNode] {
        nodes.filter { $0.chainError == nil && ($0.upstreamChain ?? []).isEmpty }
    }
    var relayCredentialsSaved: Bool {
        guard let savedRelay else { return false }
        return relayHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == savedRelay.host
            && Int(relayPort) == savedRelay.port
    }

    private func updateSavedRelay(_ relay: GuardSettings.Relay?) {
        savedRelay = relay.flatMap { $0.auth && RelayKeychain.contains(id: $0.id) ? $0 : nil }
    }
    private var loadedEndpoint: String?
    var selectedNode: SetupNode? { nodes.first(where: { $0.name == selected }) }
    var upstreamGroup: String? { selectedNode?.upstreamBindings?.keys.sorted().first }
    var connectionSummary: String { clientTitle }
    var endpointFingerprint: String { "\(clientID)|\(endpointKind)|\(socket)|\(address)|\(secret)" }
    var connectionReady: Bool { !personalRoutePresent && !nodes.isEmpty && loadedEndpoint == endpointFingerprint }
    var exitReady: Bool {
        if relayMode {
            let keyword = relayKeyword.trimmingCharacters(in: .whitespacesAndNewlines)
            return connectionReady && !relayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && Int(relayPort).map { (1...65535).contains($0) } == true
                && relayUsername.isEmpty == relayPassword.isEmpty
                && (relayUseKeyword ? (!keyword.isEmpty && relayCandidates.contains { $0.name.localizedCaseInsensitiveContains(keyword) }) : !relayNodes.isEmpty)
        }
        return selectedNode != nil && selectedNode?.chainError == nil && !expectedIP.isEmpty &&
        (manualExit ? confirmManualExit : measurement?.ip == expectedIP && Date.now.timeIntervalSince1970 * 1000 - (measurement?.at ?? 0) < 300_000)
    }
    var canSave: Bool { !busy && connectionReady && exitReady && confirmChanges }
    init() {
        guard let c = GuardSettings.current else { return }
        clientID = c.clientID ?? "verge"
        requireTun = c.requireTun ?? false
        manualExit = true
        socket = c.controllerSocket ?? socket
        if let url = c.controllerURL, !url.isEmpty { address = url; endpointKind = 1 }
        secret = c.controllerSecret ?? ""
        selected = c.selectedProxy ?? ""
        fixedUpstream = c.frozenSources?.dropFirst().first ?? ""
        expectedIP = c.expectedIP ?? ""
        chain = (c.frozenSources.map { Array($0.dropFirst()) } ?? c.upstreamChain ?? []).joined(separator: ", ")
        serverPort = String(c.serverPort ?? GuardSettings.serverPortDefault)
        clientPort = String(c.clientPort ?? GuardSettings.clientPortDefault)
        probePort = String(c.probePort ?? GuardSettings.probePortDefault)
        gatewayPort = String(c.gatewayPort ?? GuardSettings.gatewayPortDefault)
        startProtected = c.startProtected ?? false
        if let relay = c.relay {
            updateSavedRelay(relay)
            relayMode = true
            deviceWide = c.deviceWide == true
            relayID = relay.id
            relayHost = relay.host
            relayPort = String(relay.port)
            relayUseKeyword = !relay.keyword.isEmpty
            relayKeyword = relay.keyword
            relayNodes = Set(relay.nodes)
            completed = true
            step = Self.previewStep
        }
        // Reuse the original pre-guard script, never wrap a generated file twice.
        if let data = try? Data(contentsOf: GuardSettings.directory.appendingPathComponent("SETUP.json")),
           let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = manifest["originalPath"] as? String,
           let text = try? String(contentsOfFile: path, encoding: .utf8) {
            originalScript = text
            scriptName = "已保存的原始脚本"
            generatedPath = manifest["scriptPath"] as? String
        }
    }
    private func input(operation: String) throws -> [String: Any] {
        var values: [String: Any] = ["operation": operation, "controllerSocket": socket.trimmingCharacters(in: .whitespacesAndNewlines), "controllerURL": endpointKind == 1 ? address.trimmingCharacters(in: .whitespacesAndNewlines) : "", "controllerSecret": secret, "expectedIP": expectedIP.trimmingCharacters(in: .whitespacesAndNewlines), "selectedProxy": selected, "upstreamChain": chain.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }, "originalScript": originalScript, "startProtected": startProtected, "requireTun": requireTun, "clientID": clientID, "setupVersion": 2, "confirmChanges": confirmChanges, "manualExit": manualExit, "confirmManualExit": confirmManualExit]
        if let measurement { values["probeID"] = measurement.id }
        if let upstreamGroup, !fixedUpstream.isEmpty { values["fixedUpstreams"] = [upstreamGroup: fixedUpstream] }
        for (name, text) in [("serverPort", serverPort), ("clientPort", clientPort), ("probePort", probePort), ("gatewayPort", gatewayPort)] {
            guard let number = Int(text), (1024...65535).contains(number) else { throw SetupFailure(message: "端口应为 1024 到 65535 的整数。") }
            values[name] = number
        }
        return values
    }
    func selectClient(_ id: String) {
        guard clientID != id else { return }
        clientID = id; secret = ""; nodes = []; selected = ""; fixedUpstream = ""; chain = ""
        measurement = nil; confirmChanges = false; loadedEndpoint = nil; clientTitle = "尚未连接"
        personalRoutePresent = false
        personalScript = nil
        endpointKind = id == "verge" ? 0 : 1
    }
    // A fixed upstream inherited from a previous configuration (or another node) may
    // reference a node that the subscription no longer provides; only keep values the
    // currently selected node actually offers, and otherwise re-derive the binding.
    func reconcileFixedUpstream() {
        guard let group = upstreamGroup, let binding = selectedNode?.upstreamBindings?[group], !binding.isEmpty else { fixedUpstream = ""; return }
        if fixedUpstream != binding { fixedUpstream = binding }
    }
    func readNodes(automatically: Bool = false) async {
        busy = true; message = nil
        environment = nil
        defer { busy = false }
        do {
            let request = try input(operation: automatically ? "discover" : "catalogue")
            let endpoint = endpointFingerprint
            let reply = try await Task.detached { try GuardRuntime.helper(request) }.value
            guard endpoint == endpointFingerprint else { return }
            if automatically {
                if let value = reply.controllerSocket, !value.isEmpty { socket = value; endpointKind = 0 }
                if let value = reply.controllerURL, !value.isEmpty { address = value; endpointKind = 1 }
            }
            clientID = reply.clientID ?? clientID
            clientTitle = (reply.clientTitle ?? (endpointKind == 0 ? "Clash Verge Rev" : "Mihomo 本机接口")) + (reply.version.map { " · " + $0 } ?? "")
            personalRoutePresent = reply.personalRoutePresent == true
            personalScript = reply.personalScript
            nodes = reply.nodes ?? []
            relayNodes.formIntersection(Set(relayCandidates.map(\.name)))
            if !selected.isEmpty && !nodes.contains(where: { $0.name == selected }) { selected = "" }
            reconcileFixedUpstream()
            loadedEndpoint = endpointFingerprint
            measurement = nil; confirmChanges = false
            message = nodes.isEmpty && !personalRoutePresent ? "没有读到可选的具体节点，请检查 Clash 已载入订阅。" : nil
        } catch {
            nodes = []; loadedEndpoint = nil; advanced = true
            message = "未能连接 Clash。请先启动 Clash；如已启动，在高级设置中检查接口地址和密钥，再点重新读取。"
        }
    }
    func chooseMonitoring() {
        step = 0
        mode = "monitor"
        message = nil
    }
    private func showFailure(_ error: Error) {
        if let failure = error as? SetupFailure, failure.personalRoutePresent {
            personalRoutePresent = true
            personalScript = failure.personalScript
            confirmChanges = false
            step = 1
        } else {
            message = error.localizedDescription
        }
    }
    func parseRelayLink() async {
        guard !busy else { return }
        let link = relayLink
        busy = true; message = nil
        defer { busy = false }
        do {
            let reply = try await Task.detached { try GuardRuntime.helper(["operation": "parse-socks5", "link": link]) }.value
            guard let exit = reply.exit else { throw SetupFailure(message: "未读到 SOCKS5 地址。") }
            relayHost = exit.host; relayPort = String(exit.port)
            relayUsername = exit.username; relayPassword = exit.password
            relayLink = ""
        } catch { showFailure(error) }
    }
    func inspectEnvironment() async {
        guard !busy, connectionReady else { return }
        clearPreferencePlan()
        busy = true; message = nil
        defer { busy = false }
        do { try await readEnvironment() }
        catch { environment = nil; showFailure(error) }
    }
    func refreshHomeEnvironment() async {
        do {
            environment = try await Task.detached {
                try GuardRuntime.helper(["operation": "home-environment"]).environment
            }.value
        } catch { environment = nil }
    }
    private func readEnvironment() async throws {
        let request = try input(operation: "wizard-environment")
        environment = try await Task.detached { try GuardRuntime.helper(request) }.value.environment
    }
    func disableIPv6() async {
        guard !busy else { return }
        busy = true; message = nil
        defer { busy = false }
        do {
            let request = try input(operation: "wizard-ipv6-disable-all").merging(["confirmed": true]) { _, value in value }
            let reply = try await Task.detached { try GuardRuntime.helper(request) }.value
            message = reply.note
            GuardLogModel.shared.record(.environment, .info, "IPv6 设置操作返回", detail: reply.note ?? "请查看重新检测的结果。")
            try await readEnvironment()
        } catch { showFailure(error) }
    }
    func clearPreferencePlan() {
        preferencePlan = []; preferencePlanToken = nil; plannedPreferences = []
    }
    func previewPreferences(only selected: Set<String>? = nil) async {
        let ids = eastUSPreferenceChanges.filter { selected?.contains($0) ?? true }
        guard !busy, !ids.isEmpty else { return }
        busy = true; message = nil
        defer { busy = false }
        clearPreferencePlan()
        do {
            let request = try input(operation: "wizard-preferences-preview").merging([
                "preset": "us-east", "preferenceIDs": ids,
            ]) { _, value in value }
            let reply = try await Task.detached { try GuardRuntime.helper(request) }.value
            preferencePlan = reply.plan ?? []
            preferencePlanToken = reply.planToken
            plannedPreferences = ids
        } catch { showFailure(error) }
    }
    func applyPreferences() async {
        guard !busy, let token = preferencePlanToken, !plannedPreferences.isEmpty else { return }
        let ids = plannedPreferences
        busy = true; message = nil
        defer { busy = false }
        clearPreferencePlan()
        do {
            let request = try input(operation: "wizard-preferences-apply").merging([
                "preset": "us-east", "preferenceIDs": ids, "confirmed": true, "planToken": token,
            ]) { _, value in value }
            let reply = try await Task.detached { try GuardRuntime.helper(request) }.value
            message = reply.note
            GuardLogModel.shared.record(.environment, .info, "系统偏好设置操作返回", detail: reply.note ?? "请查看重新检测的结果。")
            try await readEnvironment()
        } catch { showFailure(error) }
    }
    func refreshFinalChecks() async {
        async let status = try? GuardClient.fetchStatus()
        async let diagnostics = try? GuardClient.fetchDiagnostics()
        let result = await (status, diagnostics)
        if completed {
            let status = result.0
            finalStatus = relayID == nil || status?.relay?.id == relayID ? status : nil
            finalDiagnostics = result.1
            if finalStatus?.verifiedNow != true { finalClientProbe = nil; systemIPv4 = nil; systemCloudflare = nil; nextClientCheck = .distantPast }
            else if Date.now >= nextClientCheck { scheduleClientCheck() }
        }
    }

    private func scheduleClientCheck() {
        guard !checkingClient, let settings = GuardSettings.current else { return }
        checkingClient = true
        nextClientCheck = .now.addingTimeInterval(15)
        Task {
            defer { checkingClient = false }
            async let claude = LocalEnvProbe.probeClaude(settings: settings)
            async let ipv4 = settings.deviceWide == true ? LocalEnvProbe.probeSystemIPv4() : nil
            async let cloudflare = settings.deviceWide == true ? LocalEnvProbe.probeCloudflare() : nil
            let result = await (claude, ipv4, cloudflare)
            if completed, finalStatus?.verifiedNow == true,
               GuardSettings.current?.expectedIP == settings.expectedIP,
               GuardSettings.current?.relay?.id == settings.relay?.id {
                finalClientProbe = result.0
                systemIPv4 = result.1
                systemCloudflare = result.2
            }
        }
    }

    func recheckAcceptance() async {
        guard !busy else { return }
        busy = true; message = nil
        defer { busy = false }
        await refreshVerge()
        do { try await GuardClient.perform(.inspect, token: GuardClient.fetchToken()) }
        catch { message = "暂时无法要求守护服务重测；请检查 Clash 和守护服务是否正在运行。" }
        nextClientCheck = .distantPast
        finalClientProbe = nil; systemIPv4 = nil; systemCloudflare = nil
        await refreshFinalChecks()
    }
    func editRelay() {
        relayID = nil; systemIPv4 = nil; systemCloudflare = nil; finalStatus = nil; finalClientProbe = nil; completed = false; confirmChanges = false; step = 1
    }
    func confirmRelay(ip: String) async {
        guard !busy, let id = relayID else { return }
        busy = true; message = nil
        defer { busy = false }
        do {
            _ = try await Task.detached {
                try GuardRuntime.helper(["operation": "confirm-relay", "relayID": id, "expectedIP": ip])
            }.value
            await GuardRuntime.shared.restart()
            await refreshFinalChecks()
            message = "已确认预期 IPv4。连续验证通过后才会放行。"
        } catch { showFailure(error) }
    }
    func save() async {
        guard canSave else { return }
        busy = true; message = nil
        defer { busy = false }
        GuardLogModel.shared.record(.configuration, .info, "开始保存节点配置")
        do {
            let reply: SetupReply
            if relayMode {
                var request = try input(operation: "save-relay")
                let id = relayID ?? UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
                let credentials = RelayCredentials(username: relayUsername, password: relayPassword)
                request["relayID"] = id
                request["deviceWide"] = deviceWide
                request["exit"] = ["host": relayHost, "port": Int(relayPort) ?? 0, "username": credentials.username, "password": credentials.password]
                request["entry"] = relayUseKeyword ? ["keyword": relayKeyword] : ["nodes": relayNodes.sorted()]
                let payload = request
                reply = try await Task.detached {
                    if !credentials.username.isEmpty { try RelayKeychain.save(credentials, id: id) }
                    do { return try GuardRuntime.helper(payload) }
                    catch {
                        if !credentials.username.isEmpty { RelayKeychain.remove(id: id) }
                        throw error
                    }
                }.value
                relayID = reply.relayID
                updateSavedRelay(GuardSettings.current?.relay)
                relayUsername = ""; relayPassword = ""; relayLink = ""
            } else {
                let request = try input(operation: "save")
                reply = try await Task.detached { try GuardRuntime.helper(request) }.value
            }
            generatedPath = reply.scriptPath
            completed = true
            await GuardRuntime.shared.restart()
            message = relayMode ? nil : "配置已生成。请在专门用于分享版测试的 Clash 配置中导入脚本并重载，再验证接入。当前尚未保护。"
            GuardLogModel.shared.record(.configuration, .success, "节点配置已保存", detail: message ?? "")
        } catch {
            showFailure(error)
            GuardLogModel.shared.record(.configuration, .error, "节点配置保存失败", detail: error.localizedDescription)
        }
    }
    func measure() async {
        guard !busy, connectionReady, selectedNode != nil else { return }
        busy = true; message = nil; measurement = nil; confirmChanges = false
        defer { busy = false }
        do {
            let request = try input(operation: "measure")
            let result = try await Task.detached { try GuardRuntime.helper(request) }.value
            measurement = result.measured
            if let measurement { expectedIP = measurement.ip; message = "连续三次实测一致；确认后将固定这个出口，后续不会自动跟随变化。" }
        } catch { showFailure(error) }
    }
    func saveMonitor() async {
        busy = true; defer { busy = false }
        do {
            _ = try await Task.detached { try GuardRuntime.helper(["operation": "monitor"]) }.value
            completed = true
            message = "已启用基础监测。此模式仅显示本机网络，不修改分流，也不提供固定出口保护。"
            GuardLogModel.shared.record(.configuration, .info, "基础监测已启用")
        } catch { message = error.localizedDescription }
    }
    func verifyIntegration() async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        do {
            let token = try await GuardClient.fetchToken()
            try await GuardClient.perform(.enable, token: token)
            let status = try await GuardClient.fetchStatus()
            message = status.verifiedNow ? "规则与实时出口已验证，保护已生效。" : "已请求连续验证：" + (status.reasonText ?? status.headline)
        } catch { message = "尚未验证接入。请检查已在客户端导入生成的脚本并重载，随后重新验证。" }
    }
    var relayConfirmed: Bool { GuardSettings.current?.relay?.confirmed == true }
    var vergeCaption: String? {        guard let verge, verge.restored != true else { return nil }
        let version = verge.version.map { "Clash Verge Rev \($0)" } ?? "Clash Verge Rev"
        if let standalone = verge.standalone, standalone.installed == true, let name = standalone.name {
            let state = standalone.selected == true ? "已选中" : "未选中"
            return version + " · 独立订阅「\(name)」\(state)"
        }
        return version + (verge.currentProfile?.name.map { " · 当前订阅「\($0)」" } ?? "")
    }
    var vergePrompt: String? {
        guard let verge else { return nil }
        if verge.restored == true { return "已恢复原脚本（SHA-256 已校验）。重新激活订阅后生效。" }
        if verge.loaded == true { return "Clash 已载入规则。实际出口以守护入口实测为准。" }
        if verge.reason == "rules-shadowed" {
            let count = verge.shadowCount ?? 0
            let first = verge.shadow?.first.map { "，最前面是 \($0)" } ?? ""
            return "脚本已载入，但守护规则被前面的 \(count) 条 REJECT 规则挡住\(first)。这通常是个人版 ClaudeGuard 守护仍在抢占规则；分享版无法在它运行时完成验收。"
        }
        if verge.reason == "rules-not-at-top" {
            return "脚本已载入，但守护规则不在运行配置最前面，Claude 流量不会进入分享版守护。请在 Clash Verge 里重新激活当前订阅。"
        }
        if verge.reason == "controller-unavailable" {
            return "暂时连不上 Clash。请打开 Clash Verge，然后点「重新检测」。"
        }
        return "Clash 尚未载入新规则。请在 Clash Verge 重新激活「\(verge.currentProfile?.name ?? "当前订阅")」，然后点「重新检测」。"
    }
    func refreshVerge() async {
        guard !vergeBusy else { return }
        vergeBusy = true; defer { vergeBusy = false }
        do { verge = try await Task.detached { try GuardRuntime.helper(["operation": "verge-status"]) }.value.verge }
        catch { verge = nil }
    }
    func applyDeviceExit() async {
        guard !vergeBusy else { return }
        GuardLogModel.shared.record(.configuration, .info, "开始生成独立订阅")
        message = nil
        applyFeedback = nil
        guard let path = generatedPath ?? Self.manifestScriptPath() else {
            applyFeedback = ("还没有生成脚本。请回到上一步点「确认并保存」，再回来应用。", true)
            GuardLogModel.shared.record(.configuration, .error, "独立订阅未生成", detail: "缺少生成的脚本路径")
            return
        }
        generatedPath = path
        vergeBusy = true
        applyFeedback = ("正在检查 Clash 配置…", false)
        defer { vergeBusy = false }
        let bundleID = "io.github.clash-verge-rev.clash-verge-rev"
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID).first,
              let url = app.bundleURL else {
            applyFeedback = ("请先打开 Clash Verge，再点「一键应用」。", true)
            return
        }
        var request: [String: Any] = ["operation": "profile-apply"]
        do {
            // A new relay cannot be measured before its GuardNook groups exist, so the
            // first apply trusts the relay address and verifies the real exit after the
            // restart. Later applies keep the previously confirmed exit.
            if GuardSettings.current?.relay?.confirmed != true {
                let host = GuardSettings.current?.relay?.host.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let parts = host.split(separator: ".", omittingEmptySubsequences: false)
                guard parts.count == 4, parts.allSatisfy({ part in Int(part).map { (0...255).contains($0) } == true }) else {
                    GuardLogModel.shared.record(.configuration, .error, "独立订阅未生成", detail: "中转出口不是 IPv4 地址")
                    applyFeedback = ("中转出口地址不是 IPv4，请回到上一步重新填写 SOCKS5 信息。", true)
                    return
                }
                request["expectedIP"] = host
                GuardLogModel.shared.record(.configuration, .info, "按中转地址生成订阅", detail: host)
            }
            _ = try await Task.detached { try GuardRuntime.helper(["operation": "device-prepare"]) }.value
            if let relay = GuardSettings.current?.relay, relay.auth {
                let id = relay.id
                guard let data = await Task.detached(operation: { RelayKeychain.load(id: id) }).value,
                      let credentials = try? JSONDecoder().decode(RelayCredentials.self, from: data) else {
                    applyFeedback = ("请允许 ClaudeGuard 读取钥匙串中的中转凭据，再点「一键应用」。", true)
                    return
                }
                request["relayCredentials"] = ["username": credentials.username, "password": credentials.password]
            }
            applyFeedback = ("正在生成独立订阅并重启 Clash…", false)
            finalClientProbe = nil; systemIPv4 = nil; systemCloudflare = nil
            guard app.terminate() else { throw SetupFailure(message: "Clash 未能退出，请重试。") }
            for _ in 0..<60 {
                if app.isTerminated { break }
                try await Task.sleep(for: .milliseconds(200))
            }
            guard app.isTerminated else { throw SetupFailure(message: "Clash 正在退出，请等待它退出后打开再重试。") }
            let payload = request
            let reply: SetupReply
            do {
                reply = try await Task.detached { try GuardRuntime.helper(payload) }.value
                deviceWide = true
            } catch {
                NSWorkspace.shared.open(url)
                throw error
            }
            let launch = NSWorkspace.OpenConfiguration()
            launch.activates = false
            launch.environment = ["HTTP_PROXY": "", "HTTPS_PROXY": "", "ALL_PROXY": "",
                                  "http_proxy": "", "https_proxy": "", "all_proxy": ""]
            _ = try await NSWorkspace.shared.openApplication(at: url, configuration: launch)
            await GuardRuntime.shared.restart()
            nextClientCheck = .distantPast
            let name = reply.verge?.name
            let result = name.map { "已生成并选中独立订阅「\($0)」。原订阅仍在 Clash Verge 列表里。" }
                ?? "已生成并选中独立订阅。原订阅仍在 Clash Verge 列表里。"
            applyFeedback = (result, false)
            GuardLogModel.shared.record(.configuration, .success, "已生成独立订阅", detail: name ?? "")
            vergeBusy = false
            await refreshVerge()
        } catch {
            GuardLogModel.shared.record(.configuration, .error, "独立订阅生成失败", detail: error.localizedDescription)
            if let failure = error as? SetupFailure, failure.personalRoutePresent {
                let location = failure.personalScript ?? "全局扩展脚本和当前订阅的扩展脚本"
                applyFeedback = ("Clash 仍载入个人版守护规则。若要用这套 Clash 切换到分享版，请到 Clash Verge 的「订阅」，将\(location)恢复为加入个人版之前的版本，重载订阅后再试。", true)
            } else {
                applyFeedback = (error.localizedDescription, true)
            }
        }
    }
    static func manifestScriptPath() -> String? {
        guard let data = try? Data(contentsOf: GuardSettings.directory.appendingPathComponent("SETUP.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let path = manifest["scriptPath"] as? String,
              FileManager.default.fileExists(atPath: path) else { return nil }
        return path
    }

    func copyGeneratedScript() {
        guard let path = generatedPath, let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            message = "生成的脚本无法读取。"
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        message = "脚本已复制到剪贴板。"
    }
    func restoreGlobalScript() async {
        if vergeBusy {
            message = "上一个 Clash 操作还在进行，请稍候再试。"
            return
        }
        vergeBusy = true; message = "正在恢复 Clash 原全局扩展脚本…"
        defer { vergeBusy = false }
        do {
            let reply = try await Task.detached { try GuardRuntime.helper(["operation": "verge-restore"]) }.value
            verge = reply.verge
            message = "已恢复 Clash 原全局扩展脚本。请在 Clash Verge 里重新激活当前订阅使其生效。"
            GuardLogModel.shared.record(.configuration, .success, "Clash 全局扩展脚本已恢复")
        } catch {
            showFailure(error)
            GuardLogModel.shared.record(.configuration, .error, "恢复 Clash 全局扩展脚本失败", detail: error.localizedDescription)
        }
    }
    func chooseScript() {
        let picker = NSOpenPanel()
        picker.canChooseDirectories = false; picker.allowsMultipleSelection = false
        picker.title = "选择现有的 Clash 原始全局扩展脚本"
        if picker.runModal() == .OK, let url = picker.url {
            do { originalScript = try String(contentsOf: url, encoding: .utf8); scriptName = url.lastPathComponent }
            catch { message = "原始脚本无法读取。" }
        }
    }
}

struct GuardSetupView: View {
    @StateObject private var model = GuardSetupModel()
    @State private var confirmingDeviceExit = false
    var onFinish: (() -> Void)? = nil
    var openExitSettings = false
    private let steps = ["使用方式", "连接客户端", "检查环境", "选择出口", "导入与验收"]
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("设置 ClaudeGuard").font(.system(size: 20, weight: .semibold))
            HStack(spacing: 12) {
                ForEach(Array(steps.enumerated()), id: \.offset) { index, title in
                    Text("\(index + 1) · \(title)")
                        .font(.system(size: 11, weight: index == model.step ? .semibold : .regular))
                        .foregroundStyle(index == model.step ? Color.accentColor : .secondary)
                }
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if model.completed { completion }
                    else if model.step == 0 { modePage }
                    else if model.step == 1 { connectionPage }
                    else if model.step == GuardSetupModel.environmentStep { environmentPage }
                    else if model.step == GuardSetupModel.exitStep { exitPage }
                    else { previewPage }
                    if let message = model.message { Text(message).font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            // Keep the native focus ring inside the scroll view's clipping bounds.
            .contentMargins(.all, 6, for: .scrollContent)
            Divider()
            HStack {
                if model.step > 0 && !model.completed { Button("上一步") { model.step -= 1; model.confirmChanges = false } }
                Spacer()
                if model.busy { ProgressView().controlSize(.small) }
                if !model.completed {
                    if model.step == 0 && model.mode == "monitor" {
                        Button("开始基础监测") { Task { await model.saveMonitor() } }.buttonStyle(.borderedProminent)
                    } else if model.step < GuardSetupModel.previewStep {
                        Button("下一步") { model.step += 1 }
                            .buttonStyle(.borderedProminent)
                            .disabled(model.step == 1 && !model.connectionReady
                                      || model.step == GuardSetupModel.environmentStep && !model.readyForExit
                                      || model.step == GuardSetupModel.exitStep && !model.exitReady)
                    } else {
                        Button("确认并保存") { Task { await model.save() } }.buttonStyle(.borderedProminent).disabled(!model.canSave)
                    }
                } else {
                    if model.relayID != nil {
                        Button("重新配置中转") { model.editRelay() }
                            .buttonStyle(.bordered)
                            .disabled(model.vergeBusy)
                    }
                    Button(model.canFinishSetup ? "完成" : "稍后继续") {
                        if let onFinish { onFinish() } else { NSApp.keyWindow?.performClose(nil) }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.vergeBusy)
                }
            }
        }
        .padding(24).frame(minWidth: 600, minHeight: 520)
        .disabled(model.busy)
        .task {
            if GuardSettings.current == nil { model.mode = "monitor" }
            else if openExitSettings, model.relayID != nil {
                model.editRelay()
                await model.readNodes(automatically: false)
                if model.connectionReady { model.step = GuardSetupModel.exitStep }
            } else if !model.completed { await model.readNodes(automatically: false) }
        }
        .task(id: model.step) {
            if model.step == GuardSetupModel.environmentStep && !model.completed { await model.inspectEnvironment() }
        }
        .task(id: model.completed) {
            guard model.completed, model.mode == "guard" else { return }
            await model.refreshVerge()
            while !Task.isCancelled {
                await model.refreshFinalChecks()
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
    private var modePage: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("选择适合你的使用方式").font(.headline)
            Picker("使用方式", selection: $model.mode) {
                Text("基础监测").tag("monitor")
                Text("固定出口守护").tag("guard")
            }.pickerStyle(.segmented).disabled(GuardSettings.current != nil)
            Text(model.mode == "monitor" ? "查看 Claude、Codex 与本机网络的实际可达性。保留现有系统设置，此模式不启用保护网关。" : "为 Claude 固定节点与出口，持续验证规则和链路。异常时关闭受保护通道；需要接入自己的代理客户端。")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            if GuardSettings.current != nil { Text("已配置的守护会保留。需要撤销时，请到设置中的“维护与恢复”按步骤处理。").font(.caption).foregroundStyle(.secondary) }
            Text("ClaudeGuard 不提供节点或订阅。向导会先检查网络；修改 IPv6 前需要你确认。").font(.caption).foregroundStyle(.secondary)
        }
    }
    private var connectionPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("连接已有的代理客户端").font(.headline)
            Picker("客户端", selection: Binding(get: { model.clientID }, set: { model.selectClient($0) })) {
                Text("Clash Verge Rev · 本机适配").tag("verge")
                Text("其他 Mihomo 客户端 · 标准接口").tag("mihomo")
            }
            HStack {
                Text(model.connectionSummary).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button(model.personalRoutePresent ? "重新检查" : "自动识别并读取") {
                    Task { await model.readNodes(automatically: !model.personalRoutePresent) }
                }
            }
            if model.personalRoutePresent {
                VStack(alignment: .leading, spacing: 8) {
                    Label("检测到个人版守护规则，不能在这里接入", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 13, weight: .semibold))
                    Text(model.personalScript.map {
                        "在\($0)中发现个人版规则。请保留现在的个人配置；只在独立测试环境中恢复这个脚本的原始版本，再重载 Clash。"
                    } ?? "请保留现在的个人配置。在独立测试环境中，检查「订阅」里的全局扩展脚本和当前订阅的扩展脚本，恢复注入个人版规则之前的脚本。控制接口无法确定具体来源。")
                        .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
                    if GuardSettings.current == nil {
                        Button("改用基础监测") { model.chooseMonitoring() }
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityIdentifier("guard.setup.personal-route-conflict")
            }
            Text("仅尝试已知本机接口，不扫描网络，不读取其他客户端的密码。自定义接口或已设置密钥时，请在高级设置中填写。").font(.caption).foregroundStyle(.secondary)
            advanced
        }
    }
    private var environmentPage: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("检查并配置本机环境").font(.headline)
                Spacer()
                Button("重新检查") { Task { await model.inspectEnvironment() } }
            }
            if let environment = model.environment {
                VStack(alignment: .leading, spacing: 7) {
                    checkRow("开启 TUN", detail: environment.tunEnabled.map { $0 ? "已开启" : "需要开启" } ?? "未确认",
                             passed: environment.tunEnabled)
                    Toggle("固定出口保护要求开启 TUN（推荐）", isOn: $model.requireTun)
                    if environment.tunEnabled != true {
                        Text("在独立测试环境的 Clash 中打开 TUN，再点「重新检查」。分享版不改写 Clash 的全局设置。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                Divider()
                VStack(alignment: .leading, spacing: 7) {
                    checkRow("关闭 IPv6",
                             detail: environment.globalIPv6.map { $0 ? "仍能从 IPv6 出网，需要关闭" : "已关闭" } ?? "未确认",
                             passed: environment.globalIPv6.map { !$0 })
                    Text(ipv6Guidance(environment))
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if environment.services.isEmpty {
                        Text("没有找到可配置的 macOS 网络服务。").font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(environment.services) { service in
                            LabeledContent(service.name, value: ipv6ModeLabel(service.mode)).font(.callout)
                        }
                        let allOff = environment.services.allSatisfy { $0.mode == "Off" }
                        let unreadable = environment.services.contains(where: { $0.mode == nil })
                        if unreadable {
                            Text("有设置无法读取，不能安全备份。请重新检查后再试。")
                                .font(.caption).foregroundStyle(.secondary)
                        } else if allOff {
                            Text("这些网络服务的 IPv6 都已关闭。").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text("一次关闭上面尚未关闭的网络服务，包括未连接的网桥和 USB。需要 macOS 管理员授权；会先备份，之后可以恢复。不更改 VPN 或 Clash 的 TUN。")
                                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        if allOff {
                            Button("一键关闭 IPv6…") { Task { await model.disableIPv6() } }
                                .buttonStyle(.bordered)
                                .disabled(model.busy || unreadable)
                        } else {
                            Button("一键关闭 IPv6…") { Task { await model.disableIPv6() } }
                                .buttonStyle(.borderedProminent)
                                .disabled(model.busy || unreadable)
                        }
                    }
                }
                Divider()
                DisclosureGroup("可选：地区、时区和 Claude 语言") {
                    VStack(alignment: .leading, spacing: 6) {
                        LabeledContent("时区", value: environment.timezone)
                        LabeledContent("地区", value: environment.locale ?? "未确认")
                        LabeledContent("Claude 语言", value: environment.language ?? "沿用系统或未确认")
                        Text("这些偏好不影响固定出口守护。可保留现状，也可一次改成美国地区、纽约时区和美式英语。")
                            .font(.caption).foregroundStyle(.secondary)
                        if model.preferencePlan.isEmpty {
                            HStack {
                                Button("预览美国东部预设…") { Task { await model.previewPreferences() } }
                                    .disabled(model.eastUSPreferenceChanges.isEmpty)
                                Button("打开系统设置") {
                                    if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.systempreferences") {
                                        NSWorkspace.shared.open(app)
                                    }
                                }
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(model.preferencePlan) { item in
                                    LabeledContent(item.title, value: "\(item.before) → \(item.after)")
                                }
                                Text("地区和时区会影响整个系统，修改时区需要管理员授权。Claude 语言可能需要重启 Claude；原值可在「维护与恢复」中找回。")
                                    .font(.caption)
                                HStack {
                                    Button("取消") { model.clearPreferencePlan() }
                                    Button("应用预设") { Task { await model.applyPreferences() } }.buttonStyle(.borderedProminent)
                                }
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                        }
                    }.padding(.top, 6)
                }
                .disclosureGroupStyle(WholeRowDisclosureStyle(identifier: "guardnook.environment-preferences"))
            } else if !model.busy {
                Text("没有取得检查结果。请确认已连接测试用 Clash，然后重新检查。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private func ipv6Guidance(_ environment: SetupEnvironment) -> String {
        guard let present = environment.globalIPv6 else {
            return "未取得 IPv6 出口检查结果，可以点「重新检查」。"
        }
        if present {
            return "已确认本机能在守护通道外用 IPv6 出网。先关闭这些网络服务的 IPv6，再重新验证。"
        }
        return "未检测到可用的 IPv6 出口。仍建议在所有网络服务上关闭 IPv6，避免以后接入新网络时绕过固定出口。这个结果只代表本次本机检查，不代替浏览器 WebRTC 自检。"
    }
    private func ipv6ModeLabel(_ mode: String?) -> String {
        switch mode {
        case "Off": "已关闭"
        case "Automatic": "自动"
        case "Link-local only": "仅链路本地"
        case "Manual": "手动"
        default: "未确认"
        }
    }
    private func checkRow(_ title: String, detail: String, passed: Bool?) -> some View {
        HStack {
            Label(title, systemImage: passed.map { $0 ? "checkmark.circle.fill" : "exclamationmark.circle.fill" } ?? "questionmark.circle")
                .foregroundStyle(passed.map { $0 ? Color.green : Color.orange } ?? .secondary)
            Spacer()
            Text(detail).foregroundStyle(.secondary)
        }
    }
    private var exitPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("选择并确认固定出口").font(.headline)
            Picker("出口方式", selection: $model.relayMode) {
                Text("使用已有固定出口节点").tag(false)
                Text("在 ClaudeGuard 里配置中转").tag(true)
            }
            .pickerStyle(.segmented)
            .onChange(of: model.relayMode) { _, _ in model.confirmChanges = false }
            if model.relayMode {
                Toggle("整机固定出口", isOn: $model.deviceWide)
                    .onChange(of: model.deviceWide) { _, _ in model.confirmChanges = false }
                Text(model.deviceWide ? "应用时会自动重开 Clash 并启用 TUN。浏览器和普通应用与 Claude 共用固定出口，接管的 UDP 会被阻断。"
                     : "固定出口仅用于已接入 Claude 守护的流量。")
                    .font(.caption).foregroundStyle(.secondary)
                relayForm
            } else { existingExitFields }
            Text("保护只覆盖确实进入 Clash 守护规则的流量，未进入规则的请求不受保护。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
    private var existingExitFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Claude 节点", selection: $model.selected) {
                Text("请选择具体节点").tag("")
                ForEach(model.nodes) { Text("\($0.name) · \($0.type)").tag($0.name) }
            }
            .onChange(of: model.selected) { _, _ in model.measurement = nil; model.confirmChanges = false; model.reconcileFixedUpstream() }
            if let error = model.selectedNode?.chainError { Text(error).font(.caption).foregroundStyle(.orange) }
            if let chain = model.selectedNode?.upstreamChain, !chain.isEmpty { Text("已识别链路：" + chain.joined(separator: " → ")).font(.caption).foregroundStyle(.secondary) }
            Button("实测当前路径并校验所选节点（3 次）") { Task { await model.measure() } }.disabled(model.selectedNode == nil || model.manualExit)
            Text("请先在代理客户端把 Claude 流量指向所选节点。检测会验证连接确实经过它；向导不会改动你现有的代理组选择。").font(.caption).foregroundStyle(.secondary)
            if let measured = model.measurement { Text("实测出口：\(measured.ip) · \(measured.country) · \(measured.samples) 次一致").font(.system(size: 12, weight: .medium)) }
            Toggle("手动填写出口（未由本向导实测）", isOn: $model.manualExit)
            if model.manualExit {
                TextField("你已确认的固定出口 IPv4", text: $model.expectedIP).textFieldStyle(.roundedBorder)
                Toggle("我确认这个 IP 来自所选节点；保存后仍需实时验证才会放行", isOn: $model.confirmManualExit).font(.caption)
            }
        }
    }
    private var relayForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SOCKS5 固定出口").font(.headline)
            HStack {
                SecureField("粘贴 socks5:// 链接", text: $model.relayLink)
                Button("拆分链接") { Task { await model.parseRelayLink() } }.disabled(model.relayLink.isEmpty)
            }
            HStack {
                TextField("服务器域名或 IPv4", text: $model.relayHost)
                TextField("端口", text: $model.relayPort).frame(width: 100)
            }
            HStack {
                TextField("用户名（可选）", text: $model.relayUsername)
                SecureField("密码（可选）", text: $model.relayPassword)
            }
            if model.relayCredentialsSaved {
                Label("账号和密码已保存到钥匙串", systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text("预期公网 IPv4 只用来核对，不用来连接。导入中转脚本后会实测并预填，确认前不放行。")
                .font(.caption).foregroundStyle(.secondary)
            Text("Clash 入口节点").font(.headline)
            Picker("选择入口", selection: $model.relayUseKeyword) {
                Text("选择多个节点").tag(false)
                Text("按名称关键词匹配").tag(true)
            }.pickerStyle(.segmented)
            if model.relayUseKeyword {
                TextField("例如：香港", text: $model.relayKeyword)
                let text = model.relayKeyword.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    Text("匹配 \(model.relayCandidates.filter { $0.name.localizedCaseInsensitiveContains(text) }.count) 个入口节点")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    Toggle("全选", isOn: Binding(
                        get: { !model.relayCandidates.isEmpty && model.relayCandidates.allSatisfy { model.relayNodes.contains($0.name) } },
                        set: { selected in
                            if selected { model.relayNodes = Set(model.relayCandidates.map(\.name)) }
                            else { model.relayNodes.removeAll() }
                        }
                    )).toggleStyle(.checkbox)
                    Spacer()
                    Text("已选 \(model.relayNodes.count) / \(model.relayCandidates.count)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(model.relayCandidates) { node in
                    Toggle(node.name, isOn: Binding(get: { model.relayNodes.contains(node.name) }, set: { selected in
                        if selected { model.relayNodes.insert(node.name) }
                        else { model.relayNodes.remove(node.name) }
                    })).toggleStyle(.checkbox)
                }
            }
            if model.relayCandidates.isEmpty {
                Text("没有可用的独立入口节点。请回到上一步刷新 Clash 节点。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .textFieldStyle(.roundedBorder)
    }
    private var previewPage: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("预览本次配置").font(.headline)
            Text(model.relayMode
                 ? "客户端：\(model.connectionSummary)\n入口：\(model.relayUseKeyword ? model.relayKeyword : model.relayNodes.sorted().joined(separator: "、"))\nSOCKS5 出口：\(model.relayHost):\(model.relayPort)\n预期公网 IPv4：导入后实测\nTUN 要求：\(model.requireTun ? "开启" : "未强制")"
                 : "客户端：\(model.connectionSummary)\n节点：\(model.selected)\n固定出口：\(model.expectedIP)\nTUN 要求：\(model.requireTun ? "开启" : "未强制")")
                .font(.system(size: 12)).textSelection(.enabled)
            Text(model.relayMode && model.deviceWide ? "应用时会新建独立订阅并设为当前订阅，原订阅保留；Clash 会短暂重启，系统网络可能暂时中断。应用前会备份原设置。" : "将创建 ClaudeGuard 专用规则、固定节点组和本机网关，并保存配置快照。普通网络继续使用原有分流。").font(.caption).foregroundStyle(.secondary)
            HStack { Button("选择已有的原始扩展脚本…") { model.chooseScript() }; Text(model.scriptName).font(.caption).foregroundStyle(.secondary) }
            Text("已有扩展脚本时请选择加入 ClaudeGuard 之前的原始版本，以保留内网和其他应用规则。").font(.caption).foregroundStyle(.secondary)
            Toggle(model.relayMode ? "我已确认入口节点与固定出口" : "我已确认节点、固定出口与上述更改", isOn: $model.confirmChanges)
            advanced
        }
    }
    private var completion: some View {
        VStack(alignment: .leading, spacing: 16) {
            if model.relayID != nil { relayCompletion }
            else { standardCompletion }
            if model.mode == "guard" {
                Divider()
                finalChecks
            }
        }
    }
    private var finalChecks: some View {
        VStack(alignment: .leading, spacing: 8) {
            let status = model.finalStatus
            let waitingForIP = status?.reason == "relay-awaiting-confirmation"
            let coreReady = status?.verifiedNow == true
            let selected = model.verge?.standalone?.selected == true
            let issue = acceptanceIssue(status, selected: selected)
            Text("固定出口检测（持续更新）").font(.headline)
            Text(model.relayID != nil
                 ? "Clash 选中订阅后即可点「完成」，无需等下方检测全部通过。只要 ClaudeGuard 仍在运行，关闭向导后也会继续检测。"
                 : "Clash 载入规则后即可点「完成」。只要 ClaudeGuard 仍在运行，关闭向导后也会继续检测。")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Label(issue.title, systemImage: model.acceptanceReady ? "checkmark.seal.fill" : "shield.lefthalf.filled")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(model.acceptanceReady ? Color.green : Color.primary)
            if model.relayID != nil {
                LabeledContent("TUN", value: status?.tunEnabled == true ? "已开启" : status?.tunEnabled == false ? "未开启" : "待确认")
            }
            Text(issue.detail).font(.callout).fixedSize(horizontal: false, vertical: true)
            if !waitingForIP, let expected = status?.expectedIP, status?.relay?.confirmed != false {
                LabeledContent("目标固定 IP", value: expected).font(.callout).textSelection(.enabled)
            }
            if coreReady {
                LabeledContent("Claude 守护入口实测", value: model.finalClientProbe?.ip ?? (model.checkingClient ? "检测中…" : "未取得"))
                    .font(.callout).textSelection(.enabled)
            } else if ["egress_mismatch", "exit-ip-mismatch"].contains(status?.reason ?? ""), let measured = status?.last?.ip {
                LabeledContent("探测到的出口（未放行）", value: measured).font(.callout).textSelection(.enabled)
            }
            if model.deviceWide && model.relayID != nil && coreReady {
                LabeledContent("系统 IPv4 实测", value: model.systemIPv4?.ip ?? (model.checkingClient ? "检测中…" : "未取得"))
                LabeledContent("系统 Cloudflare 实测", value: model.systemCloudflare?.ip ?? (model.checkingClient ? "检测中…" : "未取得"))
            }
            HStack {
                if waitingForIP, let measured = status?.last?.ip {
                    Button("确认 \(measured) 并启用保护") { Task { await model.confirmRelay(ip: measured) } }.buttonStyle(.borderedProminent)
                } else if status?.manual == true || status?.reason == "ready-not-enabled" {
                    Button("启用保护") { Task { await model.verifyIntegration() } }.buttonStyle(.borderedProminent)
                }
                if issue.openClash {
                    Button("打开 Clash Verge") {
                        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "io.github.clash-verge-rev.clash-verge-rev") {
                            NSWorkspace.shared.open(url)
                        }
                    }.buttonStyle(.bordered)
                }
                Button(model.checkingClient ? "检测中…" : "重新检测") {
                    Task { await model.recheckAcceptance() }
                }.disabled(model.checkingClient || model.vergeBusy)
            }
            if let environment = model.environment, !environment.services.isEmpty {
                Divider()
                ipv6SummaryRow(environment)
            }
            DisclosureGroup("查看检测明细（DNS 与 WebRTC 为补充检查）") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("这些检查用于定位规则、节点和连接问题。")
                        .font(.caption).foregroundStyle(.secondary)
                    checkRow("Clash 守护规则", detail: model.verge?.loaded == true ? "已载入" : "待确认", passed: model.verge?.loaded)
                    if model.relayID != nil {
                        ForEach([("entry", "入口可达"), ("exit", "SOCKS5 连接与认证"), ("egress", "固定出口探测")], id: \.0) { key, label in
                            let stage = model.relayStatus?.relay?.stages[key]
                            checkRow(label, detail: stage.map { item in
                                (item.ok ? "通过" : "未通过") + (item.durationMs.map { " · \($0) ms" } ?? "")
                            } ?? "未测：等待前置步骤", passed: stage?.ok)
                        }
                    }
                    let audit = model.finalDiagnostics
                    let dns = audit?.auditFresh == true ? audit?.dns : nil
                    checkRow("Claude DNS 配置", detail: dns?.state == "configured" ? "配置已核对" : "未确认",
                             passed: dns?.state == "configured" ? true : nil)
                    Text("DNS 配置和匿名 HTTPS 探测不验证浏览器旁路、账号登录或 API 权限。DNS / WebRTC 请在实际使用的浏览器里另行测试。")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(.top, 6)
            }
            .disclosureGroupStyle(WholeRowDisclosureStyle(identifier: "guardnook.check-details"))
        }
    }
    private func acceptanceIssue(_ status: GuardStatus?, selected: Bool) -> (title: String, detail: String, openClash: Bool) {
        if model.acceptanceReady {
            return (model.deviceWide && model.relayID != nil ? "整机出口实测通过" : "保护已生效",
                    "实测出口均与目标一致。点「完成」关闭向导，守护会继续运行。", false)
        }
        if model.vergeBusy { return ("正在应用配置", "等待 Clash 重启并载入独立订阅。", false) }
        if status?.verifiedNow == true {
            if model.checkingClient || model.finalClientProbe == nil {
                return ("正在验收实际出口", "守护已放行，正在实测 Claude 入口和所需的系统网络出口。", false)
            }
            return ("出口验收未通过", model.finalClientProbe?.reason
                    ?? "系统实测未确认与目标一致。请检查 Clash TUN 和其他 VPN，再点「重新检测」。", true)
        }
        switch status?.reason {
        case "entry_unavailable":
            return ("入口检查未通过 · Claude 已阻断", "在 Clash 的「入口选择」里切换另一个节点，再回来点「重新检测」。要更换候选节点，点底部「重新配置中转」。", true)
        case "exit_auth_failed", "relay_credentials_unavailable":
            return ("SOCKS5 凭据检查未通过", "点底部「重新配置中转」，核对 SOCKS5 账号和密码后重新应用。", false)
        case "exit_unreachable":
            return ("无法连接 SOCKS5 出口", "先在 Clash 切换另一个入口再重测。若仍失败，点「重新配置中转」核对地址和端口。", true)
        case "egress_mismatch", "exit-ip-mismatch":
            return ("实测出口与目标不一致", "请核对 SOCKS5 出口。换了固定出口时，点底部「重新配置中转」。", false)
        case "tun-required", "device-tun-coverage":
            return ("TUN 接管未通过", "在上方重新应用到 Clash Verge 会开启 TUN。如果系统弹出授权，请允许后再点「重新检测」。", false)
        case "global_ipv6_present":
            return ("检测到可用的 IPv6 出口", "回到「检查环境」关闭可用的 IPv6 出口，再回到这里点「重新检测」。", false)
        case "relay-awaiting-confirmation":
            return ("请确认实测出口", "确认下方实测 IPv4 后，守护将连续检测再放行。", false)
        case "confirming-exit":
            return ("正在连续验证固定出口", "检测通过后会自动放行，无需操作。", false)
        case "ready-not-enabled", "manual-block":
            return ("Claude 尚未放行", "点「启用保护」开始验证固定出口。", false)
        default:
            if model.relayID != nil, !selected {
                return ("尚未完成 Clash 接入", "点上方「一键应用到 Clash Verge」生成并选中独立订阅。", false)
            }
            return (status?.headline ?? "等待守护状态", status?.reasonText
                    ?? "确认 Clash 正在运行，然后点「重新检测」。", true)
        }
    }

    private func ipv6SummaryRow(_ environment: SetupEnvironment) -> some View {
        let allOff = environment.services.allSatisfy { $0.mode == "Off" }
        let unreadable = environment.services.contains { $0.mode == nil }
        let detail = allOff ? "所有网络服务已关闭"
            : environment.globalIPv6 == true ? "仍能绕过固定出口出网，需要关闭"
            : environment.globalIPv6 == nil ? "未确认" : "已关闭"
        return VStack(alignment: .leading, spacing: 6) {
            checkRow("关闭 IPv6", detail: detail, passed: allOff ? true : environment.globalIPv6.map { !$0 })
            if allOff {
                Text("IPv6 已全部关闭，本机不会从 IPv6 绕过固定出口。").font(.caption).foregroundStyle(.secondary)
            } else if unreadable {
                Text("有设置无法读取，请回到「检查环境」重新检查后再操作。").font(.caption).foregroundStyle(.secondary)
            } else {
                Text("IPv6 可以让流量绕开固定出口。建议一次关闭这些网络服务的 IPv6；需要管理员授权，会先备份，可在「维护与恢复」里还原。")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if allOff {
                Button("一键关闭 IPv6…") { Task { await model.disableIPv6() } }
                    .buttonStyle(.bordered)
                    .disabled(model.busy || unreadable)
            } else {
                Button("一键关闭 IPv6…") { Task { await model.disableIPv6() } }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || unreadable)
            }
        }
    }
    private var relayCompletion: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Clash 订阅配置").font(.headline)
            let selected = model.verge?.standalone?.selected == true
            if selected {
                Label("独立订阅已选中 · 配置完成", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
            if let path = model.generatedPath {
                HStack(spacing: 10) {
                    Group {
                        if selected {
                            Button("重新应用到 Clash Verge") { confirmingDeviceExit = true }
                        } else {
                            Button("一键应用到 Clash Verge") { confirmingDeviceExit = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                    .disabled(model.vergeBusy)
                    .confirmationDialog("生成并选中独立订阅", isPresented: $confirmingDeviceExit, titleVisibility: .visible) {
                        Button("生成并重启 Clash") { Task { await model.applyDeviceExit() } }
                        Button("取消", role: .cancel) {}
                    } message: {
                        Text("会新建「GuardNook：出口 IP」独立订阅并设为当前订阅，原订阅保留在列表里。入口组包含上一步选中的全部入口节点。ClaudeGuard 会开启 Clash TUN 并重启 Clash，然后实测系统和 Claude 的出口。接管后的公网 TCP 使用固定 IPv4，UDP 会被阻断。")
                    }
                    Button("复制脚本") { model.copyGeneratedScript() }
                        .disabled(model.vergeBusy)
                    Button("显示生成的脚本") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
                }
                if let feedback = model.applyFeedback {
                    HStack(alignment: .top, spacing: 8) {
                        if model.vergeBusy { ProgressView().controlSize(.small) }
                        else if feedback.failed { Image(systemName: "exclamationmark.triangle.fill") }
                        Text(feedback.text)
                            .font(.system(size: 12))
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    .foregroundStyle(feedback.failed ? Color.orange : Color.secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(feedback.failed ? Color.orange.opacity(0.12) : Color.secondary.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: 8))
                }
                if !selected {
                    Text("应用后会选中守护用的独立订阅，并保留原订阅。")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                if !model.relayConfirmed {
                    Text("应用会先写入独立订阅并重启 Clash，随后用中转实测确认出口 IP；若实测与中转地址不一致会提示。")
                        .font(.system(size: 12)).foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if model.vergeBusy && model.applyFeedback == nil { ProgressView().controlSize(.small) }
                if let caption = model.vergeCaption { Text(caption).font(.caption).foregroundStyle(.secondary) }
                Text("脚本含出口和网关凭据，只在本机使用，不要分享。").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
    private var standardCompletion: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.mode == "monitor" ? "基础监测已就绪" : "配置已保存，继续完成接入").font(.headline)
            if let path = model.generatedPath {
                Text("1 · 显示生成的脚本，在代理客户端的扩展脚本中导入。\n2 · 保存并重载客户端配置。\n3 · 点击下方按钮启用保护并检查实时结果。").font(.system(size: 12))
                Button("显示生成的脚本") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
            }
            Text(model.mode == "monitor" ? "基础监测保留系统设置，不提供固定出口保护。可随时重新打开向导接入自己的节点。" : "保存配置与保护生效是两个步骤。实际状态以守护页的实时验证为准。").font(.caption).foregroundStyle(.secondary)
        }
    }
    private var advanced: some View {
        DisclosureGroup("高级连接与端口", isExpanded: $model.advanced) {
            VStack(alignment: .leading, spacing: 10) {
                Picker("控制接口", selection: $model.endpointKind) { Text("本机 Socket").tag(0); Text("本机 HTTP").tag(1) }.pickerStyle(.segmented)
                if model.endpointKind == 0 { TextField("Socket 路径", text: $model.socket) }
                else { TextField("http://127.0.0.1:9090", text: $model.address) }
                SecureField("控制接口密钥", text: $model.secret)
                Button("连接填写的接口") { Task { await model.readNodes() } }
                TextField("补充固定上游名称（英文逗号分隔）", text: $model.chain)
                HStack { port("面板", $model.serverPort); port("客户端", $model.clientPort) }
                HStack { port("探测", $model.probePort); port("网关", $model.gatewayPort) }
                Toggle("启动时开始验证并启用保护", isOn: $model.startProtected)
            }.padding(.top, 8).textFieldStyle(.roundedBorder)
        }.disclosureGroupStyle(WholeRowDisclosureStyle(identifier: "guardnook.advanced-settings"))
    }
    private func port(_ title: String, _ value: Binding<String>) -> some View { HStack { Text(title); TextField("端口", text: value).frame(width: 76) } }
}

private struct WholeRowDisclosureStyle: DisclosureGroupStyle {
    let identifier: String
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    configuration.isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    configuration.label
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(configuration.isExpanded ? "已展开" : "已收起")
            .accessibilityIdentifier(identifier)
            if configuration.isExpanded { configuration.content }
        }
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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 560), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "ClaudeGuard · 连接与保护"
        // Match the dark nook panel.
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = NSHostingView(rootView: GuardSetupView(onFinish: { [weak window] in
            window?.performClose(nil)
        }, openExitSettings: openExitSettings))
        window.isReleasedWhenClosed = false
        window.center()
        let controller = NSWindowController(window: window)
        Self.controller = controller
        controller.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
