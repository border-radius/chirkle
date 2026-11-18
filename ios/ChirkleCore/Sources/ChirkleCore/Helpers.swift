// Pure helpers shared with the other clients: ids (android lib/Ids.kt), links (lib/Links.kt, web lib/links.ts),
// attachments (lib/Files.kt), rooms (lib/Rooms.kt) and the user-visible strings the data layer makes.
import Foundation

public enum Strings {
    public static let somethingWentWrong = "Something went wrong."
    public static let cantReachServer = "Can't reach the server. Check your connection."
    public static let cantReachThatServer = "Can't reach that server. Check the address and your connection."
    public static let tooManyAttempts = "Too many attempts. Wait a few seconds and try again."
    public static let notLoggedIn = "Not logged in."
    public static let unreadable = "The server's answer couldn't be read."
    public static let unknown = "Unknown"
}

// MARK: - Ids (DESIGN.md §7.5, §17.4)

private let idAlphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")

/// A client-made record id in PocketBase's format: 15 characters of [a-z0-9]. A retried send reuses its id, so the
/// server never makes a duplicate.
public func newId() -> String {
    var g = SystemRandomNumberGenerator()
    return String((0 ..< 15).map { _ in idAlphabet[Int(g.next(upperBound: UInt(idAlphabet.count)))] })
}

/// Now as a PocketBase datetime ("2026-10-10 12:34:56.789Z"), for a message not on the server yet.
public func pbNow(_ date: Date = Date()) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS'Z'"
    return f.string(from: date)
}

/// A PocketBase datetime as a Date.
public func pbDate(_ s: String) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(identifier: "UTC")
    for format in ["yyyy-MM-dd HH:mm:ss.SSS'Z'", "yyyy-MM-dd HH:mm:ss'Z'"] {
        f.dateFormat = format
        if let d = f.date(from: s) { return d }
    }
    return nil
}

// MARK: - Links (DESIGN.md §7.6.3)

/// A piece of message text: plain, or a link with where it goes.
public enum TextPart: Hashable, Sendable {
    case plain(String)
    case link(text: String, href: URL)
}

/// JavaScript's `\s`, spelled out, so the web's rules are the ones matched.
private let jsSpace = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
private let candidate = try! NSRegularExpression(pattern: "(?<![A-Za-z0-9_])(?:[hH][tT][tT][pP][sS]?://|[wW][wW][wW]\\.)[^\(jsSpace)<>\"]+")
private let trailing = try! NSRegularExpression(pattern: "^[.,:;!?'\"*_…。\\p{Pi}\\p{Pf}]$")
private let opening: [Character: Character] = [")": "(", "]": "["]

/// Split `text` into plain runs and links. Only http(s) URLs become links (`www.example.com` → https); trailing
/// punctuation stays text, and so does a closing bracket the link didn't open.
public func linkify(_ text: String) -> [TextPart] {
    var out: [TextPart] = []
    let ns = text as NSString
    var at = 0
    for match in candidate.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
        var url = ns.substring(with: match.range)
        while let last = url.last {
            let s = String(last)
            let isTrailing = trailing.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil
            var unopened = false
            if let open = opening[last] {
                unopened = url.filter { $0 == open }.count < url.filter { $0 == last }.count
            }
            if !isTrailing && !unopened { break }
            url.removeLast()
        }
        let start = match.range.location
        let www = url.lowercased().hasPrefix("www.")
        // Not the www. inside an email address or a longer host name.
        if www && start > 0 && "@.-".contains(ns.substring(with: NSRange(location: start - 1, length: 1))) { continue }
        guard let href = normalizedURL(www ? "https://" + url : url) else { continue }
        if start > at { out.append(.plain(ns.substring(with: NSRange(location: at, length: start - at)))) }
        out.append(.link(text: url, href: href))
        at = start + (url as NSString).length
    }
    if at < ns.length { out.append(.plain(ns.substring(from: at))) }
    return out
}

/// An http(s) URL as the other clients write it (OkHttp's HttpUrl, the browser's URL): the host in lower case and
/// an empty path as "/". Nil for one without a host.
func normalizedURL(_ s: String) -> URL? {
    guard var c = URLComponents(string: s), let host = c.host, !host.isEmpty,
          let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https"
    else { return nil }
    c.scheme = scheme
    c.host = host.lowercased()
    if c.path.isEmpty { c.path = "/" }
    return c.url
}

// MARK: - Attachments (DESIGN.md §17)

private func ext(_ name: String) -> String {
    guard let dot = name.lastIndex(of: ".") else { return "" }
    return name[name.index(after: dot)...].lowercased()
}

public func isImage(_ name: String) -> Bool { Contract.Files.image.contains(ext(name)) }
public func isGif(_ name: String) -> Bool { ext(name) == "gif" }
public func isVideo(_ name: String) -> Bool { Contract.Files.video.contains(ext(name)) }
public func isAudio(_ name: String) -> Bool { Contract.Files.audio.contains(ext(name)) }

private let storedSuffix = try! NSRegularExpression(pattern: "_[a-zA-Z0-9]{10}(\\.[^.]*)?$")

/// "report_k3j2h1g0f9.pdf" → "report.pdf": PocketBase adds "_" and 10 random characters to stored names.
public func displayName(_ stored: String) -> String {
    let ns = stored as NSString
    return storedSuffix.stringByReplacingMatches(in: stored, range: NSRange(location: 0, length: ns.length), withTemplate: "$1")
}

extension Message {
    /// What to call an attachment: its original upload name when the server recorded it (QA BUG-28).
    public func attachmentName(_ stored: String) -> String {
        if let n = fileNames[stored], !n.isEmpty { return n }
        return displayName(stored)
    }
}

// MARK: - Rooms (DESIGN.md §16.5, §23)

extension Room {
    /// Can `me` post in a room they see (§23.6)? Guests never can; the creator always can.
    public func canPost(_ me: String?) -> Bool {
        guard let me, !me.isEmpty, !archived else { return false }
        return posting != "selected" || createdBy == me || writers.contains(me)
    }

    /// The other member of a DM, if known.
    public func otherMember(_ me: String?) -> User? {
        guard isDm, let other = members.first(where: { $0 != me }) else { return nil }
        return memberUsers.first(where: { $0.id == other }) ?? User(id: other, name: Strings.unknown)
    }

    /// What to call a room: "#name", or the other member's name for a DM.
    public func title(_ me: String?) -> String {
        isDm ? (otherMember(me)?.name ?? Strings.unknown) : "#" + name
    }

    /// Why a DM takes no new messages (§16.7); "" while it takes them.
    public func dmClosed(_ me: User?) -> String {
        guard let me, isDm else { return "" }
        if me.noDms { return "You've turned off direct messages." }
        if let other = otherMember(me.id), other.noDms { return "\(other.name) doesn't take direct messages." }
        return ""
    }
}

/// The room list's order: rooms by name, then DMs by their latest message, newest first (§5, §16.5).
public func sortedRooms(_ rooms: [Room], me: String?) -> (rooms: [Room], dms: [Room]) {
    let plain = rooms.filter { !$0.isDm }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    let dms = rooms.filter(\.isDm).sorted {
        $0.lastMessageAt != $1.lastMessageAt ? $0.lastMessageAt > $1.lastMessageAt : $0.title(me) < $1.title(me)
    }
    return (plain, dms)
}
