// The files the clients share (docs/API.md): the contract is the app's copy (as android's ContractTest), and every
// example answer of the routes the app reads decodes with its models (as android's AnswersTest).
import XCTest
@testable import ChirkleCore

/// The repository's root, found from this file.
let repoRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()

func shared(_ path: String) throws -> [String: Any] {
    let data = try Data(contentsOf: repoRoot.appendingPathComponent("shared").appendingPathComponent(path))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

final class ContractTests: XCTestCase {
    func testFields() throws {
        let fields = try XCTUnwrap(try shared("contract.json")["fields"] as? [String: String])
        XCTAssertEqual(fields["message"], Contract.Fields.message)
        XCTAssertEqual(fields["room"], Contract.Fields.room)
        XCTAssertEqual(fields["user"], Contract.Fields.user)
        XCTAssertEqual(fields["roomRow"], Contract.Fields.roomRow)
        XCTAssertEqual(fields["activity"], Contract.Fields.activity)
        XCTAssertEqual(fields["collectionItem"], Contract.Fields.collectionItem)
    }

    func testLimits() throws {
        let l = try XCTUnwrap(try shared("contract.json")["limits"] as? [String: Any])
        XCTAssertEqual(l["messageText"] as? Int, Contract.Limits.messageText)
        XCTAssertEqual(l["userName"] as? Int, Contract.Limits.userName)
        XCTAssertEqual(l["roomName"] as? Int, Contract.Limits.roomName)
        XCTAssertEqual(l["passwordMin"] as? Int, Contract.Limits.passwordMin)
        XCTAssertEqual(l["passwordMaxBytes"] as? Int, Contract.Limits.passwordMaxBytes)
        XCTAssertEqual(l["avatarBytes"] as? Int, Contract.Limits.avatarBytes)
        XCTAssertEqual(l["avatarTypes"] as? [String], Contract.Limits.avatarTypes)
        XCTAssertEqual(l["attachments"] as? Int, Contract.Limits.attachments)
        XCTAssertEqual(l["attachmentBytes"] as? Int, Contract.Limits.attachmentBytes)
        XCTAssertEqual(l["roomMembers"] as? Int, Contract.Limits.roomMembers)
        XCTAssertEqual(l["maxSelected"] as? Int, Contract.Limits.maxSelected)
    }

    func testFileTypes() throws {
        let f = try XCTUnwrap(try shared("contract.json")["files"] as? [String: [String]])
        XCTAssertEqual(f["image"], Contract.Files.image)
        XCTAssertEqual(f["video"], Contract.Files.video)
        XCTAssertEqual(f["audio"], Contract.Files.audio)
    }
}

final class AnswersTests: XCTestCase {
    private func examples(_ route: String) throws -> [Data] {
        let routes = try XCTUnwrap(try shared("schema/answers.json")["routes"] as? [String: Any])
        let r = try XCTUnwrap(routes[route] as? [String: Any], route)
        let list = try XCTUnwrap(r["examples"] as? [Any], route)
        XCTAssertFalse(list.isEmpty, route)
        return try list.map { try JSONSerialization.data(withJSONObject: $0, options: [.fragmentsAllowed]) }
    }

    private func decodes<T: Decodable>(_ route: String, as _: T.Type) throws {
        for e in try examples(route) {
            XCTAssertNoThrow(try JSONDecoder().decode(T.self, from: e), route)
        }
    }

    func testEveryRouteTheAppReads() throws {
        try decodes("GET /api/chat/rooms", as: [Room].self)
        try decodes("GET /api/chat/rooms/{room}/messages", as: [Message].self)
        try decodes("GET /api/chat/unread", as: UnreadCounts.self)
        try decodes("GET /api/chat/unread/{room}", as: Cursor.self)
        try decodes("POST /api/chat/dms", as: Room.self)
        try decodes("GET /api/chat/users", as: [User].self)
        try decodes("POST /api/chat/reactions", as: Message.self)
    }

    func testAMessageAsItsExampleHasIt() throws {
        let m = try JSONDecoder().decode([Message].self, from: try examples("GET /api/chat/rooms/{room}/messages")[0])[0]
        XCTAssertEqual(m.authorUser?.name, "Ada")
        XCTAssertEqual(m.quoted?.authorUser?.name, "Bob")
        XCTAssertEqual(m.quoted?.text, "a cat?")
        XCTAssertEqual(m.attachmentName("cat_cani1ag7yw.png"), "cat.png")
        XCTAssertEqual(m.fileDims["cat_cani1ag7yw.png"], [640, 480])
        XCTAssertEqual(m.reactions.first?.emoji, "👍")
    }

    func testADmsTitleIsTheOtherMember() throws {
        let rooms = try JSONDecoder().decode([Room].self, from: try examples("GET /api/chat/rooms")[0])
        XCTAssertEqual(rooms[0].title("u00000000000001"), "#general")
        XCTAssertNil(rooms[0].shared) // null in the answer
        XCTAssertEqual(rooms[1].title("u00000000000001"), "Bob")
        XCTAssertEqual(rooms[1].shared?.home, "chat.example.org")
    }

    func testNullsAndOtherTypesGiveTheDefaults() throws {
        let json = #"{"id":"m1","room":null,"files":null,"reactions":"x","deleted":1,"expand":null}"#
        let m = try JSONDecoder().decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(m.room, "")
        XCTAssertEqual(m.files, [])
        XCTAssertEqual(m.reactions, [])
        XCTAssertFalse(m.deleted)
        XCTAssertNil(m.authorUser)
    }
}
