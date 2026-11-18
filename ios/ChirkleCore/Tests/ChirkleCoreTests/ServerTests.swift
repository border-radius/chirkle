// Against a real, throwaway server (docs/IOS.md §7), as android's TestServer: the repository's bin/chirkle-server with
// its migrations and hooks, on a free port with a temporary data dir. Skipped when there is no server binary (run
// `npm run setup` in the repository first); CI builds it.
import XCTest
@testable import ChirkleCore

#if os(macOS)
enum TestServer {
    static let adminEmail = "admin@test.local"
    static let adminPassword = "test-password-123"
    static let password = "password-123"

    nonisolated(unsafe) private static var started: URL?
    nonisolated(unsafe) private static var process: Process?
    private static let lock = NSLock()

    static var binary: URL { repoRoot.appendingPathComponent("bin/chirkle-server") }

    static func url() throws -> URL {
        lock.lock()
        defer { lock.unlock() }
        if let started { return started }
        guard FileManager.default.isExecutableFile(atPath: binary.path) else {
            throw XCTSkip("No server at \(binary.path): run `npm run setup` first")
        }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("chirkle-ios-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp.appendingPathComponent("pb_public"), withIntermediateDirectories: true)
        let dirs = [
            "--dir=\(tmp.appendingPathComponent("pb_data").path)",
            "--migrationsDir=\(repoRoot.appendingPathComponent("pb_migrations").path)",
            "--hooksDir=\(repoRoot.appendingPathComponent("pb_hooks").path)",
            "--automigrate=false",
        ]
        let upsert = Process()
        upsert.executableURL = binary
        upsert.arguments = ["superuser", "upsert", adminEmail, adminPassword] + dirs
        upsert.standardOutput = FileHandle.nullDevice
        try upsert.run()
        upsert.waitUntilExit()
        guard upsert.terminationStatus == 0 else { throw NSError(domain: "TestServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "superuser upsert failed"]) }

        let port = Int.random(in: 20000 ..< 60000)
        let url = URL(string: "http://127.0.0.1:\(port)")!
        let p = Process()
        p.executableURL = binary
        p.arguments = ["serve", "--http=127.0.0.1:\(port)", "--publicDir=\(tmp.appendingPathComponent("pb_public").path)", "--hooksWatch=false", "--hooksPool=50"] + dirs
        var env = ProcessInfo.processInfo.environment.filter { !$0.key.hasPrefix("TELEGRAM_") }
        env["LINK_PREVIEWS"] = "off"
        p.environment = env
        let log = tmp.appendingPathComponent("pb.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        p.standardOutput = try FileHandle(forWritingTo: log)
        p.standardError = p.standardOutput
        try p.run()
        process = p
        atexit { TestServer.process?.terminate() }

        let deadline = Date().addingTimeInterval(20)
        while true {
            if !p.isRunning { throw NSError(domain: "TestServer", code: 2, userInfo: [NSLocalizedDescriptionKey: (try? String(contentsOf: log)) ?? "exited"]) }
            if request(URLRequest(url: url.appendingPathComponent("api/health"))).status == 200 { break }
            if Date() > deadline { throw NSError(domain: "TestServer", code: 3, userInfo: [NSLocalizedDescriptionKey: "not healthy"]) }
            Thread.sleep(forTimeInterval: 0.05)
        }
        // Every test client connects from 127.0.0.1: limits meant for real users would trip across tests.
        var login = URLRequest(url: url.appendingPathComponent("api/collections/_superusers/auth-with-password"))
        login.httpMethod = "POST"
        login.setValue("application/json", forHTTPHeaderField: "Content-Type")
        login.httpBody = try JSONSerialization.data(withJSONObject: ["identity": adminEmail, "password": adminPassword])
        let answer = request(login).data
        let token = try XCTUnwrap((try JSONSerialization.jsonObject(with: answer) as? [String: Any])?["token"] as? String)
        var settings = URLRequest(url: url.appendingPathComponent("api/settings"))
        settings.httpMethod = "PATCH"
        settings.setValue(token, forHTTPHeaderField: "Authorization")
        settings.setValue("application/json", forHTTPHeaderField: "Content-Type")
        settings.httpBody = Data(#"{"rateLimits":{"enabled":false}}"#.utf8)
        XCTAssertEqual(request(settings).status, 200)
        started = url
        return url
    }

    /// A request made synchronously, for start-up only: on URLSession's own queue, never blocking on a Task (which
    /// could wait for the very thread it blocks). Status 0 for no answer.
    static func request(_ req: URLRequest) -> (status: Int, data: Data) {
        final class Box: @unchecked Sendable {
            var status = 0
            var data = Data()
        }
        let box = Box()
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, response, _ in
            box.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            box.data = data ?? Data()
            sem.signal()
        }.resume()
        sem.wait()
        return (box.status, box.data)
    }

    static func uniq() -> String { String(newId().prefix(8)) }

    static func newUser() async throws -> (ChirkleAPI, User) {
        let api = ChirkleAPI(server: try url(), authStore: MemoryAuthStore())
        let name = "user-\(uniq())"
        let user = try await api.signUp(email: "\(name)@test.local", password: password, name: name)
        return (api, user)
    }
}

final class ServerTests: XCTestCase {
    func testSignUpLogInAndRenew() async throws {
        let (api, user) = try await TestServer.newUser()
        XCTAssertEqual(api.currentUser?.id, user.id)
        let renewed = try await api.refreshAuth()
        XCTAssertEqual(renewed.id, user.id)
        await api.logOut()
        XCTAssertNil(api.currentUser)
    }

    func testAWrongPasswordSaysSo() async throws {
        let api = ChirkleAPI(server: try TestServer.url(), authStore: MemoryAuthStore())
        do {
            _ = try await api.logIn(email: "nobody-\(TestServer.uniq())@test.local", password: "wrong-password")
            XCTFail("logged in")
        } catch let e as APIError {
            XCTAssertEqual(e.status, 400)
        }
    }

    func testSendPageEditDeleteAndReact() async throws {
        let (api, _) = try await TestServer.newUser()
        let room = try await api.createRoom(name: "ios-\(TestServer.uniq())")
        let rooms = try await api.listRooms()
        XCTAssertTrue(rooms.contains { $0.id == room.id })
        var sent: [Message] = []
        for i in 0 ..< 3 {
            sent.append(try await api.send(id: newId(), room: room.id, text: "m\(i)"))
        }
        let reply = try await api.send(id: newId(), room: room.id, text: "reply", replyTo: sent[0].id)
        XCTAssertEqual(reply.quoted?.text, "m0")

        let latest = try await api.page(.latest(room.id))
        XCTAssertEqual(latest.map(\.text), ["reply", "m2", "m1", "m0"])
        let older = try await api.page(.older(room.id, latest[1].cursor))
        XCTAssertEqual(older.map(\.text), ["m1", "m0"])

        let edited = try await api.edit(sent[1].id, text: "m1!")
        XCTAssertFalse(edited.editedAt.isEmpty)
        let reacted = try await api.react(sent[1].id, emoji: "👍", on: true)
        XCTAssertEqual(reacted.reactions.first?.emoji, "👍")
        let deleted = try await api.softDelete(sent[2].id)
        XCTAssertTrue(deleted.deleted)
    }

    func testARetriedSendMakesNoDuplicate() async throws {
        let (api, _) = try await TestServer.newUser()
        let room = try await api.createRoom(name: "ios-\(TestServer.uniq())")
        let id = newId()
        _ = try await api.send(id: id, room: room.id, text: "once")
        do {
            _ = try await api.send(id: id, room: room.id, text: "once")
        } catch let e as APIError {
            XCTAssertEqual(e.status, 400)
        }
        let page = try await api.page(.latest(room.id))
        XCTAssertEqual(page.count, 1)
    }

    func testLiveMessagesAndUnreadCounts() async throws {
        let (ada, _) = try await TestServer.newUser()
        let (bob, bobUser) = try await TestServer.newUser()
        let room = try await ada.createRoom(name: "ios-\(TestServer.uniq())")

        let got = expectation(description: "live message")
        let sub = await bob.subscribeMessages(room: room.id) { c in
            if c.action == .create, c.record.text == "hello" { got.fulfill() }
        }
        let m = try await ada.send(id: newId(), room: room.id, text: "hello")
        await fulfillment(of: [got], timeout: 10)
        await bob.realtime.unsubscribe(sub)

        let before = try await bob.unreadCounts()
        XCTAssertEqual(before.rooms[room.id], 1)
        let first = try await bob.firstUnread(room.id)
        XCTAssertEqual(first.id, m.id)
        try await bob.markRead(room.id, at: m.created)
        let after = try await bob.unreadCounts()
        XCTAssertEqual(after.rooms[room.id] ?? 0, 0)

        let dm = try await ada.openDm(bobUser.id)
        XCTAssertTrue(dm.isDm)
        XCTAssertEqual(dm.title(ada.currentUser?.id), bobUser.name)
    }
}
#endif
