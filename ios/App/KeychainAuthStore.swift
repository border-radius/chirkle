// The session in the Keychain, one per server (docs/IOS.md §5): readable after the first unlock, never synced or
// backed up to another device (ThisDeviceOnly), as android keeps it encrypted with a Keystore key.
import ChirkleCore
import Foundation
import Security

final class KeychainAuthStore: AuthStore, @unchecked Sendable {
    private let account: String
    private let lock = NSLock()
    private var cached: Session??

    private static let service = "chirkle.session"

    init(server: URL) {
        account = server.absoluteString
    }

    var session: Session? {
        lock.lock()
        defer { lock.unlock() }
        if let cached { return cached }
        let s = read()
        cached = .some(s)
        return s
    }

    func save(_ session: Session?) {
        lock.lock()
        defer { lock.unlock() }
        cached = .some(session)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        guard let session, let data = try? JSONEncoder().encode(session) else { return }
        var add = query
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }

    private func read() -> Session? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(Session.self, from: data)
    }
}
