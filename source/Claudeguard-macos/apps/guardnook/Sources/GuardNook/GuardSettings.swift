import Foundation

struct GuardSettings: Decodable, Sendable {
    struct Relay: Decodable, Sendable {
        var id: String
        var host: String
        var port: Int
        var auth: Bool
        var confirmed: Bool
        var keyword: String
        var nodes: [String]
    }
    var clientID: String?
    var requireTun: Bool?
    var deviceWide: Bool?
    var expectedIP: String?
    var selectedProxy: String?
    var policyGroup: String?
    var gatewayProxy: String?
    var pinnedProxy: String?
    var serviceMode: String?
    var controllerSocket: String?
    var controllerURL: String?
    var controllerSecret: String?
    var upstreamChain: [String]?
    var frozenSources: [String]?
    var serverPort: Int?
    var clientPort: Int?
    var probePort: Int?
    var gatewayPort: Int?
    var startProtected: Bool?
    var allowUURemote: Bool?
    var relay: Relay?

    static let serverPortDefault = 19791
    static let clientPortDefault = 19901
    static let probePortDefault = 19903
    static let gatewayPortDefault = 19904

    static var directory: URL {
        #if DEBUG
        if let home = ProcessInfo.processInfo.environment["GUARDNOOK_FIXTURE_HOME"] {
            return URL(fileURLWithPath: home).appendingPathComponent("Library/Application Support/GuardNook Share", isDirectory: true)
        }
        #endif
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/GuardNook Share", isDirectory: true)
    }
    static var configURL: URL { directory.appendingPathComponent("config.json") }
    static var current: Self? {
        guard let data = try? Data(contentsOf: configURL) else { return nil }
        guard let settings = try? JSONDecoder().decode(Self.self, from: data),
              settings.serviceMode == nil, settings.policyGroup == "GuardNookShare-Claude",
              settings.gatewayProxy == "GuardNookShare-Gateway", settings.pinnedProxy == "GuardNookShare-Pinned",
              let port = settings.serverPort, (1024...65535).contains(port),
              ![7901, 17891, 17903, 17904, 18791, 18901, 18903, 18904].contains(port)
        else { return nil }
        return settings
    }
    static var isMonitoring: Bool { !FileManager.default.fileExists(atPath: configURL.path) && FileManager.default.fileExists(atPath: directory.appendingPathComponent("monitor.json").path) }
    static var isConfigured: Bool { FileManager.default.fileExists(atPath: configURL.path) || isMonitoring }
    static var origin: String {
        let candidate = current?.serverPort ?? serverPortDefault
        let port = (1024...65535).contains(candidate) ? candidate : serverPortDefault
        return "http://127.0.0.1:\(port)"
    }
}

