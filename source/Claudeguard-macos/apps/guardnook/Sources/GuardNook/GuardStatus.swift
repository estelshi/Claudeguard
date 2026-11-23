import Foundation

/// The read-only snapshot served by the local Claude Guard service.
struct GuardStatus: Decodable, Sendable {
    struct RelayStage: Decodable, Sendable {
        var ok: Bool
        var durationMs: Int?
    }
    struct RelayStatus: Decodable, Sendable {
        struct Entry: Decodable, Sendable {
            var name: String
            var delay: Int?
        }
        var entry: Entry?
        var id: String
        var confirmed: Bool
        var stages: [String: RelayStage]
    }
    struct Remedy: Decodable, Sendable {
        var text: String
        var action: String
        var retry: Bool?
    }
    struct LastCheck: Decodable, Sendable {
        var ip: String?
        var location: String?
        var colo: String?
        var chains: [String]?
        var sampledAt: Double?
        var verifiedAt: Double?
    }

    struct Sample: Decodable, Sendable {
        var at: Double?
        var ok: Bool?
        var reason: String?
        var durationMs: Double?
        var ip: String?
    }

    struct Gateway: Decodable, Sendable {
        var open: Bool?
        var expiresAt: Double?
        var connections: Int?
        var clientGatewayPort: Int?
    }

    struct ConnEvent: Decodable, Sendable {
        var host: String?
        var proto: String?
        var at: Double?

        private enum CodingKeys: String, CodingKey {
            case host, at
            case proto = "protocol"
        }
    }

    struct ConnectionLog: Decodable, Sendable {
        struct Connection: Decodable, Sendable, Identifiable {
            var id: String
            var host: String?
            var at: Double?
            var timeSource: String?
            var process: String?
            var processPath: String?
            var sourceIP: String?
            var sourcePort: Int?
            var network: String?
            var active: Bool?

            /// An app name comes only from the process path reported by Clash.
            var applicationName: String? {
                guard let path = processPath, let app = path.range(of: ".app/") else { return nil }
                return URL(fileURLWithPath: String(path[..<app.lowerBound])).lastPathComponent
            }

            var sourceAddress: String? {
                guard let ip = sourceIP else { return nil }
                let host = ip.contains(":") ? "[\(ip)]" : ip
                return sourcePort.map { "\(host):\($0)" } ?? host
            }

            var sourceLabel: String? {
                if let application = applicationName {
                    if let process, !process.isEmpty, process != application { return "\(application) · \(process)" }
                    return application
                }
                if let process, !process.isEmpty { return process }
                if let path = processPath, !path.isEmpty { return URL(fileURLWithPath: path).lastPathComponent }
                return sourceAddress
            }

            var sourceDetail: String {
                var parts: [String] = []
                if let application = applicationName { parts.append("应用：\(application)") }
                if let process, !process.isEmpty { parts.append("进程：\(process)") }
                if let path = processPath, !path.isEmpty { parts.append("路径：\(path)") }
                if let address = sourceAddress { parts.append("连接来源：\(address)") }
                if process == nil && processPath == nil { parts.append("这条连接尚未取得进程信息。") }
                parts.append("来源：Clash 连接记录；可能包含守护自动探测。")
                return parts.joined(separator: "\n")
            }
        }

        var events: [Connection]
        var checkedAt: Double?
        var available: Bool?

        var fresh: Bool {
            guard available == true, let checkedAt else { return false }
            return Date.now.timeIntervalSince1970 * 1000 - checkedAt < 5000
        }
    }

    var state: String
    var reason: String?
    var phase: String?
    var relay: RelayStatus?
    var remedy: Remedy?
    var enabled: Bool?
    var manual: Bool?
    var prepared: Bool?
    var requireTun: Bool?
    var deviceWide: Bool?
    var tunEnabled: Bool?
    var expectedIP: String?
    var pinnedProxy: String?
    var policyGroup: String?
    var last: LastCheck?
    var successes: Int?
    var recoverySamples: Int?
    var leaseMs: Double?
    var intervalMs: Double?
    var gateway: Gateway?
    var events: [ConnEvent]?
    var samples: [Sample]?
    var connectionLog: ConnectionLog?
}

enum GuardClient {
    /// Local control APIs must not enter a system proxy or PAC and loop back
    /// through Clash. Internet probes keep their separate current-path sessions.
    static let localSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [
            "HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0,
            "ProxyAutoConfigEnable": 0, "ProxyAutoDiscoveryEnable": 0,
        ]
        return URLSession(configuration: configuration)
    }()
    static var statusURL: URL { URL(string: GuardSettings.origin + "/api/claude-guard/status")! }

    static func fetchStatus() async throws -> GuardStatus {
        var request = URLRequest(url: statusURL)
        request.timeoutInterval = 4
        let (data, response) = try await localSession.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        let result = try JSONDecoder().decode(GuardStatus.self, from: data)
        if FileManager.default.fileExists(atPath: GuardSettings.configURL.path) {
            guard let settings = GuardSettings.current, result.expectedIP == settings.expectedIP else { throw URLError(.badServerResponse) }
            guard result.policyGroup == settings.policyGroup, result.pinnedProxy == settings.pinnedProxy
            else { throw URLError(.badServerResponse) }
        }
        return result
    }

    /// The local Clash mixed port, read from the guard service's read-only proxy of
    /// the controller. nil when the controller is unreachable.
    static func fetchMihomoMixedPort() async -> Int? {
        guard GuardSettings.current != nil else { return nil }
        guard let url = URL(string: GuardSettings.origin + "/api/mihomo/configs") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 4
        guard let (data, response) = try? await localSession.data(for: request),
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let port = dictionary["mixed-port"] as? Int, port > 0
        else { return nil }
        return port
    }
}
