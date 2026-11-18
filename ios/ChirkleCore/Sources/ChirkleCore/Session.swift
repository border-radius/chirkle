// A signed-in session and where it is kept (android's pb/AuthStore.kt). The app keeps it in the Keychain
// (App/KeychainAuthStore.swift); tests in memory.
import Foundation

/// A session: the token and the user PocketBase answered with.
public struct Session: Codable, Hashable, Sendable {
    public var token: String
    public var user: User

    public init(token: String, user: User) {
        self.token = token
        self.user = user
    }

    /// When the token expires, nil when it can't be read.
    public var expiresAt: Date? { tokenExp(token) }

    public func isValid(now: Date = Date()) -> Bool {
        guard let exp = expiresAt else { return false }
        return !token.isEmpty && exp > now
    }
}

/// The JWT's `exp`, or nil when it can't be read.
func tokenExp(_ token: String) -> Date? {
    let parts = token.split(separator: ".")
    guard parts.count >= 2 else { return nil }
    var b64 = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while b64.count % 4 != 0 { b64 += "=" }
    guard let data = Data(base64Encoded: b64),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let exp = obj["exp"] as? Double
    else { return nil }
    return Date(timeIntervalSince1970: exp)
}

/// Where the session lives. Called from any thread.
public protocol AuthStore: AnyObject, Sendable {
    var session: Session? { get }
    func save(_ session: Session?)
}

/// In memory only: tests, and previews.
public final class MemoryAuthStore: AuthStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Session?

    public init(_ initial: Session? = nil) {
        value = initial
    }

    public var session: Session? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    public func save(_ session: Session?) {
        lock.lock()
        value = session
        lock.unlock()
    }
}
