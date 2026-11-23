import Foundation
import Security

struct RelayCredentials: Codable, Sendable {
    var username: String
    var password: String
}

enum RelayKeychain {
    private static func query(_ id: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "local.guardnook.share.socks5",
            kSecAttrAccount as String: id,
        ]
    }

    static func save(_ credentials: RelayCredentials, id: String) throws {
        var item = query(id)
        item[kSecValueData as String] = try JSONEncoder().encode(credentials)
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            throw SetupFailure(message: "无法把 SOCKS5 凭据写入 ClaudeGuard 的钥匙串。未生成脚本。")
        }
    }

    static func load(id: String) -> Data? {
        var item = query(id)
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &value) == errSecSuccess else { return nil }
        return value as? Data
    }

    static func remove(id: String) {
        SecItemDelete(query(id) as CFDictionary)
    }
}
