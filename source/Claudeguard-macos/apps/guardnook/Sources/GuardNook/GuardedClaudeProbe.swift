import Foundation

struct GuardedTraceResponse: Sendable {
    var code: Int
    var body: String
}
struct GuardedClientExit: Decodable, Sendable {
    var state: String
    var clientPort: Int?
    var ip: String?
}

extension LocalEnvProbe {
    /// Measure the client gateway, never the private probe listener (which can
    /// be reachable while admission is closed). No system-path fallback exists.
    static func probeClaude(
        settings: GuardSettings? = GuardSettings.current,
        fetchStatus: () async throws -> GuardStatus = { try await GuardClient.fetchStatus() },
        fetchTrace: (Int) async throws -> GuardedTraceResponse = { port in
            try await Task.detached(priority: .utility) { try guardedTrace(port: port) }.value
        },
        fetchClientExit: () async throws -> GuardedClientExit = { try await GuardClient.fetchClientExit() }
    ) async -> ClaudeProbe {
        let started = Date()
        let endpoint = settings?.clientPort.map { "127.0.0.1:\($0)" }
        func result(_ ok: Bool, fields: [String: String] = [:], reason: String? = nil) -> ClaudeProbe {
            ClaudeProbe(at: Date(), ok: ok, durationMs: Int(Date().timeIntervalSince(started) * 1000),
                        ip: fields["ip"], loc: fields["loc"], colo: fields["colo"],
                        reason: reason, viaProxy: endpoint, viaGuard: true)
        }
        guard let settings, let port = settings.clientPort, (1024...65535).contains(port),
              let expected = settings.expectedIP, validIP(expected),
              settings.policyGroup != nil, settings.pinnedProxy != nil else {
            return result(false, reason: "尚未配置守护通道")
        }
        func admitted(_ status: GuardStatus) -> Bool {
            status.enabled == true && status.manual != true && status.verifiedNow
                && status.expectedIP == expected && status.policyGroup == settings.policyGroup
                && status.pinnedProxy == settings.pinnedProxy
                && (status.gateway?.clientGatewayPort == nil || status.gateway?.clientGatewayPort == port)
                && status.requireTun == settings.requireTun
        }
        do {
            let before = try await fetchStatus()
            guard admitted(before) else { return result(false, reason: "未放行：\(before.reasonText ?? "守护通道未验证")") }
            if before.gateway?.clientGatewayPort == nil {
                let measured = try await fetchClientExit()
                guard admitted(try await fetchStatus()) else { return result(false, reason: "检测期间守护通道已关闭") }
                guard measured.state == "verified" || measured.state == "mismatch",
                      measured.clientPort == port, let ip = measured.ip, validIP(ip) else {
                    return result(false, reason: measured.state == "needs-review"
                                  ? "请求未确认经过守护规则，请检查 Clash 规则后重测。" : "未取得守护入口出口，请重新检测。")
                }
                guard ip == expected, measured.state == "verified" else {
                    return result(false, fields: ["ip": ip], reason: "实测出口与固定出口不符")
                }
                return result(true, fields: ["ip": ip])
            }
            let trace = try await fetchTrace(port)
            // Revoke even a completed response if the guard closed meanwhile.
            let after = try await fetchStatus()
            guard admitted(after) else { return result(false, reason: "未放行：检测期间守护通道已关闭") }
            guard trace.code == 200 else { return result(false, reason: "守护通道出口检测 HTTP \(trace.code)") }
            guard trace.body.utf8.count <= 4096 else { return result(false, reason: "出口检测响应异常") }
            let fields = traceFields(trace.body)
            guard let ip = fields["ip"], validIP(ip) else { return result(false, reason: "响应缺少有效出口 IP") }
            guard ip == expected else { return result(false, fields: fields, reason: "实测出口与固定出口不符") }
            return result(true, fields: fields)
        } catch {
            // No partial or previous IP survives a connection/control failure.
            return result(false, reason: "守护通道检测失败：\(shortReason(error))")
        }
    }

    /// OS sandbox is a second boundary if curl/proxy settings ever regress.
    /// curlrc, environment proxies, redirects, credentials and cookies are unused.
    static func guardedTraceArguments(port: Int) -> [String] {
        let profile = "(version 1) (allow default) (deny network*) (allow network-outbound (remote ip \"localhost:\(port)\"))"
        return ["-p", profile, "/usr/bin/curl", "-q", "--silent", "--show-error", "--http1.1",
                "--proxy", "http://127.0.0.1:\(port)", "--noproxy", "", "--proto", "=https",
                "--connect-timeout", "6", "--max-time", "25", "--max-filesize", "4096",
                "--write-out", "\n%{http_code}", "https://claude.ai/cdn-cgi/trace"]
    }

    private static func guardedTrace(port: Int) throws -> GuardedTraceResponse {
        guard (1024...65535).contains(port) else { throw URLError(.badURL) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        process.arguments = guardedTraceArguments(port: port)
        process.environment = ["PATH": "/usr/bin:/bin"]
        let output = Pipe()
        process.standardOutput = output
        process.standardInput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        let stop = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: stop)
        defer { stop.cancel(); if process.isRunning { process.terminate() } }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0, data.count < 8192,
              let text = String(data: data, encoding: .utf8), let newline = text.lastIndex(of: "\n"),
              let code = Int(text[text.index(after: newline)...].trimmingCharacters(in: .whitespaces)) else {
            throw URLError(.cannotConnectToHost)
        }
        return GuardedTraceResponse(code: code, body: String(text[..<newline]))
    }
}
