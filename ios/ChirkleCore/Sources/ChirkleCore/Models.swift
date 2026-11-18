// Records as the app sees them (DESIGN.md §5, §6), decoded from PocketBase's JSON: the shapes of android's
// model/Models.kt and web/src/lib/types.ts. Decoding is lenient, as the Android app's PbJson is: a missing key, a
// `null` (PocketBase's empty JSON) or a value of another type gives the default, never a failed decode.
import Foundation

extension KeyedDecodingContainer {
    /// The value at `key`, or `fallback` when it is missing, null or of another type.
    func v<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }

    func opt<T: Decodable>(_ key: Key) -> T? {
        try? decodeIfPresent(T.self, forKey: key)
    }
}

public struct User: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    /// Avatar filename (§15); "" when the user has none.
    public var avatar: String
    /// Doesn't take direct messages (§16.7).
    public var noDms: Bool
    /// Someone on a linked instance (§33.4): its host. "" for this server's own people.
    public var instance: String
    /// Only said of the signed-in user (DESIGN.md §36).
    public var moderator: Bool
    /// What "@handle" names (DESIGN.md §41), without the "@".
    public var handle: String

    enum CodingKeys: String, CodingKey {
        case id, name, avatar, instance, moderator, handle
        case noDms = "no_dms"
    }

    public init(id: String, name: String = "", avatar: String = "", noDms: Bool = false, instance: String = "", moderator: Bool = false, handle: String = "") {
        self.id = id
        self.name = name
        self.avatar = avatar
        self.noDms = noDms
        self.instance = instance
        self.moderator = moderator
        self.handle = handle
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.v(.name, "")
        avatar = c.v(.avatar, "")
        noDms = c.v(.noDms, false)
        instance = c.v(.instance, "")
        moderator = c.v(.moderator, false)
        handle = c.v(.handle, "")
    }
}

/// Who else holds a shared room (§33.10).
public struct Shared: Codable, Hashable, Sendable {
    public var home: String
    public var with: [String]
    public var down: Bool

    enum CodingKeys: String, CodingKey { case home, with, down }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        home = c.v(.home, "")
        with = c.v(.with, [])
        down = c.v(.down, false)
    }
}

public struct Room: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    /// "" for a DM: its title is the other member's name.
    public var name: String
    public var archived: Bool
    public var createdBy: String
    /// "dm" for a direct message; anything else is a room (§16.1).
    public var kind: String
    /// "private", "public" or "open" (§23.1); "" = public.
    public var visibility: String
    public var members: [String]
    /// "everyone" or "selected" (§23.6); "" = everyone.
    public var posting: String
    public var writers: [String]
    public var lastMessageAt: String
    public var created: String
    public var shared: Shared?
    public var memberUsers: [User]
    public var writerUsers: [User]

    public var isDm: Bool { kind == "dm" }

    enum CodingKeys: String, CodingKey {
        case id, name, archived, kind, visibility, members, posting, writers, created, shared, expand
        case createdBy = "created_by"
        case lastMessageAt = "last_message_at"
    }

    enum ExpandKeys: String, CodingKey { case members, writers }

    public init(id: String, name: String = "", kind: String = "", members: [String] = [], memberUsers: [User] = []) {
        self.id = id
        self.name = name
        archived = false
        createdBy = ""
        self.kind = kind
        visibility = ""
        self.members = members
        posting = ""
        writers = []
        lastMessageAt = ""
        created = ""
        shared = nil
        self.memberUsers = memberUsers
        writerUsers = []
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.v(.name, "")
        archived = c.v(.archived, false)
        createdBy = c.v(.createdBy, "")
        kind = c.v(.kind, "")
        visibility = c.v(.visibility, "")
        members = c.v(.members, [])
        posting = c.v(.posting, "")
        writers = c.v(.writers, [])
        lastMessageAt = c.v(.lastMessageAt, "")
        created = c.v(.created, "")
        shared = c.opt(.shared)
        let e = try? c.nestedContainer(keyedBy: ExpandKeys.self, forKey: .expand)
        memberUsers = e?.v(.members, [User]()) ?? []
        writerUsers = e?.v(.writers, [User]()) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(name, forKey: .name)
        try c.encode(archived, forKey: .archived)
        try c.encode(createdBy, forKey: .createdBy)
        try c.encode(kind, forKey: .kind)
        try c.encode(visibility, forKey: .visibility)
        try c.encode(members, forKey: .members)
        try c.encode(posting, forKey: .posting)
        try c.encode(writers, forKey: .writers)
        try c.encode(lastMessageAt, forKey: .lastMessageAt)
        try c.encode(created, forKey: .created)
        try c.encodeIfPresent(shared, forKey: .shared)
        var e = c.nestedContainer(keyedBy: ExpandKeys.self, forKey: .expand)
        try e.encode(memberUsers, forKey: .members)
        try e.encode(writerUsers, forKey: .writers)
    }
}

/// One emoji on a message and who reacted with it (§20.1).
public struct Reaction: Codable, Hashable, Sendable {
    public var emoji: String
    public var users: [String]

    enum CodingKeys: String, CodingKey { case emoji, users }

    public init(emoji: String, users: [String]) {
        self.emoji = emoji
        self.users = users
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        emoji = c.v(.emoji, "")
        users = c.v(.users, [])
    }
}

/// A link's line under a message (§28).
public struct LinkPreview: Codable, Hashable, Sendable {
    public var url: String
    public var title: String
    /// A data: URL, "" without one.
    public var icon: String

    enum CodingKeys: String, CodingKey { case url, title, icon }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        url = c.v(.url, "")
        title = c.v(.title, "")
        icon = c.v(.icon, "")
    }
}

/// What a reply shows of the message it answers (§19).
public struct Quoted: Codable, Hashable, Sendable {
    public var id: String
    public var author: String
    public var text: String
    public var deleted: Bool
    public var files: [String]
    public var authorUser: User?

    enum CodingKeys: String, CodingKey { case id, author, text, deleted, files, expand }
    enum ExpandKeys: String, CodingKey { case author }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        author = c.v(.author, "")
        text = c.v(.text, "")
        deleted = c.v(.deleted, false)
        files = c.v(.files, [])
        let e = try? c.nestedContainer(keyedBy: ExpandKeys.self, forKey: .expand)
        authorUser = e?.opt(.author)
    }

    public init(of m: Message) {
        id = m.id
        author = m.author
        text = m.text
        deleted = m.deleted
        files = m.files
        authorUser = m.authorUser
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(author, forKey: .author)
        try c.encode(text, forKey: .text)
        try c.encode(deleted, forKey: .deleted)
        try c.encode(files, forKey: .files)
        var e = c.nestedContainer(keyedBy: ExpandKeys.self, forKey: .expand)
        try e.encodeIfPresent(authorUser, forKey: .author)
    }
}

/// Client only: a message not on the server yet (§7.5).
public enum SendStatus: Hashable, Sendable {
    case pending
    case failed
}

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var room: String
    /// "" for a service message (§5.3).
    public var author: String
    public var text: String
    /// PocketBase datetime, e.g. "2026-10-10 12:34:56.789Z": fixed width, so string order is time order.
    public var created: String
    public var updated: String
    /// "" when never edited.
    public var editedAt: String
    public var deleted: Bool
    public var files: [String]
    public var fileNames: [String: String]
    public var replyTo: String
    public var reactions: [Reaction]
    public var forwardedFrom: String
    public var forwardOf: String
    public var previews: [LinkPreview]
    public var mentions: [String]
    public var fileDims: [String: [Int]]
    public var authorUser: User?
    public var quoted: Quoted?
    public var forwardedFromUser: User?
    /// Client only: never sent, never decoded.
    public var status: SendStatus?

    public var isService: Bool { author.isEmpty }
    public var cursor: Cursor { Cursor(created: created, id: id) }

    enum CodingKeys: String, CodingKey {
        case id, room, author, text, created, updated, deleted, files, reactions, previews, mentions, expand
        case editedAt = "edited_at"
        case fileNames = "file_names"
        case replyTo = "reply_to"
        case forwardedFrom = "forwarded_from"
        case forwardOf = "forward_of"
        case fileDims = "file_dims"
    }

    enum ExpandKeys: String, CodingKey {
        case author
        case replyTo = "reply_to"
        case forwardedFrom = "forwarded_from"
    }

    public init(id: String, room: String, author: String, text: String, created: String, replyTo: String = "", status: SendStatus? = nil) {
        self.id = id
        self.room = room
        self.author = author
        self.text = text
        self.created = created
        updated = created
        editedAt = ""
        deleted = false
        files = []
        fileNames = [:]
        self.replyTo = replyTo
        reactions = []
        forwardedFrom = ""
        forwardOf = ""
        previews = []
        mentions = []
        fileDims = [:]
        authorUser = nil
        quoted = nil
        forwardedFromUser = nil
        self.status = status
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        room = c.v(.room, "")
        author = c.v(.author, "")
        text = c.v(.text, "")
        created = c.v(.created, "")
        updated = c.v(.updated, "")
        editedAt = c.v(.editedAt, "")
        deleted = c.v(.deleted, false)
        files = c.v(.files, [])
        fileNames = c.v(.fileNames, [:])
        replyTo = c.v(.replyTo, "")
        reactions = c.v(.reactions, [])
        forwardedFrom = c.v(.forwardedFrom, "")
        forwardOf = c.v(.forwardOf, "")
        previews = c.v(.previews, [])
        mentions = c.v(.mentions, [])
        fileDims = c.v(.fileDims, [:])
        let e = try? c.nestedContainer(keyedBy: ExpandKeys.self, forKey: .expand)
        authorUser = e?.opt(.author)
        quoted = e?.opt(.replyTo)
        forwardedFromUser = e?.opt(.forwardedFrom)
        status = nil
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(room, forKey: .room)
        try c.encode(author, forKey: .author)
        try c.encode(text, forKey: .text)
        try c.encode(created, forKey: .created)
        try c.encode(updated, forKey: .updated)
        try c.encode(editedAt, forKey: .editedAt)
        try c.encode(deleted, forKey: .deleted)
        try c.encode(files, forKey: .files)
        try c.encode(fileNames, forKey: .fileNames)
        try c.encode(replyTo, forKey: .replyTo)
        try c.encode(reactions, forKey: .reactions)
        try c.encode(forwardedFrom, forKey: .forwardedFrom)
        try c.encode(forwardOf, forKey: .forwardOf)
        try c.encode(previews, forKey: .previews)
        try c.encode(mentions, forKey: .mentions)
        try c.encode(fileDims, forKey: .fileDims)
        var e = c.nestedContainer(keyedBy: ExpandKeys.self, forKey: .expand)
        try e.encodeIfPresent(authorUser, forKey: .author)
        try e.encodeIfPresent(quoted, forKey: .replyTo)
        try e.encodeIfPresent(forwardedFromUser, forKey: .forwardedFrom)
    }
}

/// A position in a room's history, ordered by (created, id) (§6). Both "" for none.
public struct Cursor: Codable, Hashable, Comparable, Sendable {
    public var created: String
    public var id: String

    enum CodingKeys: String, CodingKey { case created, id }

    public init(created: String, id: String) {
        self.created = created
        self.id = id
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        created = c.v(.created, "")
        id = c.v(.id, "")
    }

    public static func < (a: Cursor, b: Cursor) -> Bool {
        a.created != b.created ? a.created < b.created : a.id < b.id
    }
}

/// Unread messages per room id, as of `at` (server time, §18.2).
public struct UnreadCounts: Codable, Hashable, Sendable {
    public var at: String
    public var rooms: [String: Int]
    public var ids: [String]
    public var inbox: Int
    public var mentions: [String: Int]

    enum CodingKeys: String, CodingKey { case at, rooms, ids, inbox, mentions }

    public init() {
        at = ""
        rooms = [:]
        ids = []
        inbox = 0
        mentions = [:]
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        at = c.v(.at, "")
        rooms = c.v(.rooms, [:])
        ids = c.v(.ids, [])
        inbox = c.v(.inbox, 0)
        mentions = c.v(.mentions, [:])
    }
}

/// The site's branding and signup policy (§24).
public struct Site: Hashable, Sendable {
    public var title: String = "Chirkle"
    /// URL of the logo, nil without one.
    public var logo: URL?
    public var inviteOnly: Bool = false
    public var passwordReset: Bool = false

    public init() {}
}

/// A realtime record event's action.
public enum Action: String, Sendable {
    case create, update, delete
}

/// A realtime record event.
public struct Change<T: Sendable>: Sendable {
    public var action: Action
    public var record: T

    public init(action: Action, record: T) {
        self.action = action
        self.record = record
    }
}

/// A message event in any room, without its text (§18.3).
public struct Activity: Codable, Hashable, Sendable {
    public var id: String
    public var room: String
    public var author: String
    public var deleted: Bool

    enum CodingKeys: String, CodingKey { case id, room, author, deleted }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        room = c.v(.room, "")
        author = c.v(.author, "")
        deleted = c.v(.deleted, false)
    }
}
