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
    @Published var deviceWide = false
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
                && (relayUsername.isEmpty == relayPassword.isEmpty)
                && (!relayUsername.isEmpty || relayCredentialsSaved)
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
            // Historical whole-machine mode must not be offered again.
            deviceWide = false
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
            message = "未能连接 Clash。请先启动 Clash；如已启动，在下方「控制接口」检查地址和密钥，再点「连接」。"
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
                let typed = !relayUsername.isEmpty && !relayPassword.isEmpty
                guard typed || (relayUsername.isEmpty && relayPassword.isEmpty && relayCredentialsSaved) else {
                    throw SetupFailure(message: "请填写 SOCKS5 用户名和密码。")
                }
                let reusedID = relayCredentialsSaved ? savedRelay?.id : nil
                let id = relayID ?? reusedID ?? UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
                let credentials: RelayCredentials
                if typed {
                    credentials = RelayCredentials(username: relayUsername, password: relayPassword)
                } else {
                    guard let data = await Task.detached(operation: { RelayKeychain.load(id: id) }).value,
                          let loaded = try? JSONDecoder().decode(RelayCredentials.self, from: data),
                          !loaded.username.isEmpty, !loaded.password.isEmpty else {
                        throw SetupFailure(message: "请重新填写 SOCKS5 用户名和密码，或允许读取钥匙串中已保存的凭据。")
                    }
                    credentials = loaded
                }
                request["relayID"] = id
                request["deviceWide"] = deviceWide
                request["exit"] = ["host": relayHost, "port": Int(relayPort) ?? 0, "username": credentials.username, "password": credentials.password]
                request["entry"] = relayUseKeyword ? ["keyword": relayKeyword] : ["nodes": relayNodes.sorted()]
                let payload = request
                let wroteKeychain = typed
                let isNewItem = typed && (reusedID != id || !RelayKeychain.contains(id: id))
                reply = try await Task.detached {
                    if wroteKeychain { try RelayKeychain.save(credentials, id: id) }
                    do { return try GuardRuntime.helper(payload) }
                    catch {
                        if isNewItem { RelayKeychain.remove(id: id) }
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
            applyFeedback = ("还没有生成脚本。请回到上一步点「保存，下一步」，再回来应用。", true)
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
            applyFeedback = ("请先打开 Clash Verge，再点「应用并重启 Clash」。", true)
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
            guard let relay = GuardSettings.current?.relay else {
                applyFeedback = ("请先保存 SOCKS5 中转配置，并填写用户名和密码。", true)
                return
            }
            if relay.auth != true {
                applyFeedback = ("当前中转未启用认证，请回到上一步重新填写 SOCKS5 用户名和密码。", true)
                return
            }
            let id = relay.id
            guard let data = await Task.detached(operation: { RelayKeychain.load(id: id) }).value,
                  let credentials = try? JSONDecoder().decode(RelayCredentials.self, from: data),
                  !credentials.username.isEmpty, !credentials.password.isEmpty else {
                applyFeedback = ("请允许 ClaudeGuard 读取钥匙串中的中转凭据，或重新填写用户名和密码后再应用。", true)
                return
            }
            request["relayCredentials"] = ["username": credentials.username, "password": credentials.password]
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
                deviceWide = false
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
