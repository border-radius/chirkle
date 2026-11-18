// The server's API as the app uses it (docs/API.md; android's api/ChirkleApi.kt). It needs a server with the list
// routes (GET /api/chat/rooms, …/messages, 2026-10-29) and live messages (chat/messages, 2026-11-09): unlike the
// Android app it has no records-API fallback for older servers (docs/IOS.md §3).
import Foundation

/// A page of a room's history (android's PageQuery): `latest` and `older` come back newest first, the others oldest
/// first.
public struct PageQuery: Hashable, Sendable {
    public var room: String
    public var kind: String
    public var args: [(String, String)]
    public var q: String

    public static func latest(_ room: String) -> PageQuery { PageQuery(room: room, kind: "latest", args: [], q: "") }
    public static func older(_ room: String, _ c: Cursor) -> PageQuery {
        PageQuery(room: room, kind: "older", args: [("created", c.created), ("id", c.id)], q: "")
    }
    public static func newer(_ room: String, _ c: Cursor) -> PageQuery {
        PageQuery(room: room, kind: "newer", args: [("created", c.created), ("id", c.id)], q: "")
    }
    public static func search(_ room: String, _ words: String) -> PageQuery { PageQuery(room: room, kind: "latest", args: [], q: words) }

    public var descending: Bool { kind == "latest" || kind == "older" }

    public static func == (a: PageQuery, b: PageQuery) -> Bool {
        a.room == b.room && a.kind == b.kind && a.q == b.q && a.args.map { $0.0 + "=" + $0.1 } == b.args.map { $0.0 + "=" + $0.1 }
    }

    public func hash(into h: inout Hasher) {
        h.combine(room)
        h.combine(kind)
        h.combine(q)
        for (k, v) in args {
            h.combine(k)
            h.combine(v)
        }
    }
}

/// A realtime record event as PocketBase sends it.
private struct RecordEvent<R: Decodable>: Decodable {
    var action: String
    var record: R
}

public final class ChirkleAPI: Sendable {
    public let pb: PBClient
    public let realtime: Realtime

    public static let pageSize = 50
    static let msgOpts: [(String, String)] = [("expand", "author,reply_to.author,forwarded_from"), ("fields", Contract.Fields.message)]
    static let roomOpts: [(String, String)] = [("expand", "members,writers"), ("fields", Contract.Fields.room)]
    static let liveTopic = "chat/messages"

    public init(pb: PBClient) {
        self.pb = pb
        realtime = Realtime(pb: pb)
    }

    public convenience init(server: URL, authStore: AuthStore) {
        self.init(pb: PBClient(baseURL: server, authStore: authStore))
    }

    /// The one who is logged in, or nil (an expired session is none).
    public var currentUser: User? {
        guard let s = pb.authStore.session, s.isValid() else { return nil }
        return s.user
    }

    private func me() throws -> String {
        guard let u = currentUser else { throw APIError(status: 401, message: Strings.notLoggedIn) }
        return u.id
    }

    private static let decoder = JSONDecoder()

    private func get<T: Decodable>(_ path: String, _ query: [(String, String)] = []) async throws -> T {
        try decode(try await pb.send(path, query: query))
    }

    private func decode<T: Decodable>(_ data: Data?) throws -> T {
        do {
            return try Self.decoder.decode(T.self, from: data ?? Data("{}".utf8))
        } catch {
            throw APIError(status: 0, message: Strings.unreadable)
        }
    }

    private static func seg(_ s: String) -> String { PBClient.segment(s) }
    private static func records(_ c: String) -> String { "/api/collections/\(c)/records" }
    private static func record(_ c: String, _ id: String) -> String { "/api/collections/\(c)/records/\(seg(id))" }

    // MARK: - Auth (§22, §24.2)

    private struct AuthAnswer: Decodable {
        var token: String
        var record: User
    }

    /// Log in, or renew `renewing` (a token: saved only over that same session, not one ended or changed meanwhile).
    private func auth(_ path: String, _ body: [String: JSONValue], renewing: String? = nil) async throws -> User {
        let a: AuthAnswer = try decode(try await pb.send(path, method: "POST", body: .json(body)))
        if renewing == nil || pb.authStore.session?.token == renewing {
            pb.authStore.save(Session(token: a.token, user: a.record))
            await realtime.restart()
        }
        return a.record
    }

    public func logIn(email: String, password: String) async throws -> User {
        try await auth("/api/collections/users/auth-with-password", ["identity": .string(email), "password": .string(password)])
    }

    public func signUp(email: String, password: String, name: String, inviteCode: String = "") async throws -> User {
        var body: [String: JSONValue] = [
            "email": .string(email), "password": .string(password), "passwordConfirm": .string(password), "name": .string(name),
        ]
        if !inviteCode.isEmpty { body["invite_code"] = .string(inviteCode) }
        try await pb.send(Self.records("users"), method: "POST", body: .json(body))
        return try await logIn(email: email, password: password)
    }

    /// Email a link to set a new password (§39); the same answer whether or not the address has an account.
    public func requestPasswordReset(email: String) async throws {
        let e = email.trimmingCharacters(in: .whitespaces).lowercased()
        try await pb.send("/api/collections/users/request-password-reset", method: "POST", body: .json(["email": .string(e)]))
    }

    /// Re-validate the stored session, which renews it. Throws when it is no longer valid.
    @discardableResult
    public func refreshAuth() async throws -> User {
        guard currentUser != nil else { throw APIError(status: 401, message: Strings.notLoggedIn) }
        return try await auth("/api/collections/users/auth-refresh", [:], renewing: pb.authStore.session?.token)
    }

    public func logOut() async {
        pb.authStore.save(nil)
        await realtime.unsubscribeAll()
    }

    // MARK: - Site (§24)

    public func health() async throws {
        try await pb.send("/api/health")
    }

    public func site() async throws -> Site {
        let data = try await pb.send(Self.records("site"), query: [
            ("page", "1"), ("perPage", "1"), ("sort", "created"), ("skipTotal", "true"),
            ("fields", "id,title,logo,invite_only,password_reset"),
        ])
        var site = Site()
        guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let row = (obj["items"] as? [[String: Any]])?.first
        else { return site }
        if let t = row["title"] as? String, !t.isEmpty { site.title = t }
        if let logo = row["logo"] as? String, !logo.isEmpty, let id = row["id"] as? String {
            site.logo = pb.fileURL("site", id, logo)
        }
        site.inviteOnly = row["invite_only"] as? Bool ?? false
        site.passwordReset = row["password_reset"] as? Bool ?? false
        return site
    }

    // MARK: - Profile (§15)

    public func avatarURL(_ user: User, size: Int) -> URL? {
        user.avatar.isEmpty ? nil : pb.fileURL("users", user.id, user.avatar, query: [("thumb", "\(size)x\(size)")])
    }

    public func rename(_ name: String) async throws -> User {
        let id = try me()
        let u: User = try decode(try await pb.send(Self.record("users", id), method: "PATCH", query: [("fields", Contract.Fields.user)], body: .json(["name": .string(name)])))
        if var s = pb.authStore.session, s.user.id == id {
            s.user.name = u.name
            pb.authStore.save(s)
        }
        return u
    }

    // MARK: - Rooms (§5, §16, §23)

    public func listRooms() async throws -> [Room] { try await get("/api/chat/rooms", Self.roomOpts) }

    public func getRoom(_ id: String) async throws -> Room { try await get(Self.record("rooms", id), Self.roomOpts) }

    public func createRoom(name: String, visibility: String = "public") async throws -> Room {
        try decode(try await pb.send(Self.records("rooms"), method: "POST", query: Self.roomOpts, body: .json([
            "name": .string(name), "created_by": .string(try me()), "visibility": .string(visibility),
        ])))
    }

    /// The DM with `user`, made or reopened (§16).
    public func openDm(_ user: String) async throws -> Room {
        try decode(try await pb.send("/api/chat/dms", method: "POST", body: .json(["user": .string(user)])))
    }

    /// People by name, for a new DM.
    public func searchUsers(_ query: String) async throws -> [User] {
        _ = try me()
        return try await get("/api/chat/users", [("q", query)])
    }

    // MARK: - Unread (§18)

    public func unreadCounts() async throws -> UnreadCounts { try await get("/api/chat/unread") }

    /// The oldest unread message in a room; its id is "" when there is none.
    public func firstUnread(_ room: String) async throws -> Cursor { try await get("/api/chat/unread/\(Self.seg(room))") }

    /// You have read `room` up to `at` (a message's `created`). The server never moves it back.
    public func markRead(_ room: String, at: String) async throws {
        try await pb.send("/api/chat/reads", method: "POST", body: .json(["room": .string(room), "at": .string(at)]))
    }

    // MARK: - Messages (§6, §7)

    /// A page of a room (GET /api/chat/rooms/{room}/messages); with `q`, search results (§29).
    public func page(_ q: PageQuery, size: Int = ChirkleAPI.pageSize) async throws -> [Message] {
        var query: [(String, String)] = [("kind", q.kind)] + q.args
        if !q.q.isEmpty { query.append(("q", q.q)) }
        query += [("limit", String(size)), ("page", "1")] + Self.msgOpts
        return try await get("/api/chat/rooms/\(Self.seg(q.room))/messages", query)
    }

    public func getMessage(_ id: String) async throws -> Message { try await get(Self.record("messages", id), Self.msgOpts) }

    /// Send a message with its client-made id, so a retry can't duplicate it (§17.4).
    public func send(id: String, room: String, text: String, replyTo: String = "", files: [UploadFile] = []) async throws -> Message {
        let author = try me()
        var fields = ["id": id, "room": room, "author": author, "text": text]
        if !replyTo.isEmpty { fields["reply_to"] = replyTo }
        let body: Body = files.isEmpty ? .json(fields.mapValues { .string($0) }) : .multipart(fields: fields, files: ["files": files])
        return try decode(try await pb.send(Self.records("messages"), method: "POST", query: Self.msgOpts, body: body))
    }

    public func edit(_ id: String, text: String) async throws -> Message {
        try decode(try await pb.send(Self.record("messages", id), method: "PATCH", query: Self.msgOpts, body: .json(["text": .string(text)])))
    }

    public func softDelete(_ id: String) async throws -> Message {
        try decode(try await pb.send(Self.record("messages", id), method: "PATCH", query: Self.msgOpts, body: .json(["deleted": true])))
    }

    /// Add or take back a reaction (§20).
    public func react(_ id: String, emoji: String, on: Bool) async throws -> Message {
        try decode(try await pb.send("/api/chat/reactions", method: "POST", query: Self.msgOpts, body: .json([
            "message": .string(id), "emoji": .string(emoji), "on": .bool(on),
        ])))
    }

    /// An attachment's URL (a forward's files are its original's); `thumb` like "480x0".
    public func fileURL(_ m: Message, _ file: String, thumb: String? = nil) -> URL {
        pb.fileURL("messages", m.forwardOf.isEmpty ? m.id : m.forwardOf, file, query: thumb.map { [("thumb", $0)] } ?? [])
    }

    // MARK: - Realtime

    private static func change<T: Decodable & Sendable>(_ data: Data, _: T.Type) -> Change<T>? {
        guard let e = try? decoder.decode(RecordEvent<T>.self, from: data), let a = Action(rawValue: e.action) else { return nil }
        return Change(action: a, record: e.record)
    }

    /// Message events in `room`: created, updated (edits, reactions) and deleted.
    public func subscribeMessages(room: String, _ fn: @escaping @Sendable (Change<Message>) -> Void) async -> Subscription {
        await realtime.subscribe(Self.liveTopic) { data in
            guard let c = Self.change(data, Message.self), c.record.room == room else { return }
            fn(c)
        }
    }

    /// Every message event in every room you can see, for the unread counts (§18.3).
    public func subscribeActivity(_ fn: @escaping @Sendable (Change<Activity>) -> Void) async -> Subscription {
        await realtime.subscribe(Self.liveTopic) { data in
            if let c = Self.change(data, Activity.self) { fn(c) }
        }
    }

    /// Rooms made, changed and deleted.
    public func subscribeRooms(_ fn: @escaping @Sendable (Change<Room>) -> Void) async -> Subscription {
        let opts = Dictionary(uniqueKeysWithValues: Self.roomOpts)
        return await realtime.subscribe("rooms/*", query: opts) { data in
            if let c = Self.change(data, Room.self) { fn(c) }
        }
    }

    /// Your read positions, e.g. moved on another device (§18.3).
    public func subscribeReads(_ fn: @escaping @Sendable () -> Void) async -> Subscription {
        await realtime.subscribe("room_reads/*", query: ["fields": Contract.Fields.roomRow]) { _ in fn() }
    }
}
