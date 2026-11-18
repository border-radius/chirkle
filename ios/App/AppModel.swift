// The app's state (docs/IOS.md §5): the server, who is signed in, the site, the room list and its unread counts,
// kept live by realtime. The room's own state is RoomModel.
import ChirkleCore
import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    private(set) var server: URL?
    private(set) var api: ChirkleAPI?
    private(set) var user: User?
    private(set) var site = Site()
    private(set) var rooms: [Room] = []
    private(set) var unread: [String: Int] = [:]
    private(set) var loaded = false
    var error: String?
    /// The room on screen: its messages are read as they come, so they are not counted.
    var openRoom: String?

    @ObservationIgnored private var subs: [Subscription] = []
    @ObservationIgnored private var connectHandler: UUID?
    @ObservationIgnored private var unreadTask: Task<Void, Never>?

    private static let serverKey = "server"

    init() {
        if let s = UserDefaults.standard.string(forKey: Self.serverKey), let url = URL(string: s) {
            use(url)
        }
    }

    var signedIn: Bool { user != nil }

    private func use(_ url: URL) {
        server = url
        let api = ChirkleAPI(server: url, authStore: KeychainAuthStore(server: url))
        self.api = api
        user = api.currentUser
        if user != nil { Task { await start() } }
        Task { site = (try? await api.site()) ?? Site() }
    }

    /// The address as typed ("chat.example.org") as a server URL, checked to answer as one.
    func setServer(_ text: String) async throws {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasSuffix("/") { t.removeLast() }
        if !t.contains("://") { t = "https://" + t }
        guard let url = URL(string: t), url.host != nil, url.scheme == "https" || url.scheme == "http" else {
            throw APIError(status: 0, message: Strings.cantReachThatServer)
        }
        let probe = ChirkleAPI(server: url, authStore: MemoryAuthStore())
        do {
            try await probe.health()
        } catch {
            throw APIError(status: 400, message: Strings.cantReachThatServer)
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        use(url)
    }

    func forgetServer() {
        Task { await stop() }
        UserDefaults.standard.removeObject(forKey: Self.serverKey)
        server = nil
        api = nil
        user = nil
        site = Site()
    }

    func logIn(email: String, password: String) async throws {
        guard let api else { return }
        user = try await api.logIn(email: email, password: password)
        await start()
    }

    func signUp(email: String, password: String, name: String, inviteCode: String) async throws {
        guard let api else { return }
        user = try await api.signUp(email: email, password: password, name: name, inviteCode: inviteCode)
        await start()
    }

    func logOut() async {
        await stop()
        await api?.logOut()
        user = nil
        rooms = []
        unread = [:]
        loaded = false
    }

    // MARK: - Live room list

    private func start() async {
        guard let api else { return }
        await stop()
        // The session is renewed off the critical path; one refused (revoked, banned, expired) logs out.
        Task {
            do {
                user = try await api.refreshAuth()
            } catch let e as APIError where e.status == 401 || e.status == 403 || e.status == 404 {
                await logOut()
            } catch {}
        }
        subs.append(await api.subscribeActivity { [weak self] c in
            Task { @MainActor in self?.activity(c) }
        })
        subs.append(await api.subscribeRooms { [weak self] c in
            Task { @MainActor in self?.roomChanged(c) }
        })
        subs.append(await api.subscribeReads { [weak self] in
            Task { @MainActor in self?.refreshUnreadSoon() }
        })
        connectHandler = await api.realtime.onConnect { [weak self] missed in
            if missed { Task { @MainActor in await self?.reload() } }
        }
        await reload()
    }

    private func stop() async {
        unreadTask?.cancel()
        guard let api else { return }
        for s in subs { await api.realtime.unsubscribe(s) }
        subs = []
        if let h = connectHandler { await api.realtime.removeConnectHandler(h) }
        connectHandler = nil
    }

    func reload() async {
        guard let api, user != nil else { return }
        do {
            async let r = api.listRooms()
            async let u = api.unreadCounts()
            rooms = try await r
            unread = try await u.rooms
            error = nil
        } catch let e as APIError {
            error = e.errorDescription
        } catch {}
        loaded = true
    }

    private func activity(_ c: Change<Activity>) {
        guard c.action == .create, c.record.author != user?.id else { return }
        if c.record.room == openRoom { return }
        refreshUnreadSoon()
    }

    private func roomChanged(_ c: Change<Room>) {
        switch c.action {
        case .delete:
            rooms.removeAll { $0.id == c.record.id }
        case .create, .update:
            if let i = rooms.firstIndex(where: { $0.id == c.record.id }) {
                rooms[i] = c.record
            } else {
                rooms.append(c.record)
            }
        }
    }

    /// The counts again, once a burst of events is over.
    func refreshUnreadSoon() {
        unreadTask?.cancel()
        unreadTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled, let api else { return }
            if let u = try? await api.unreadCounts() { unread = u.rooms }
        }
    }

    /// A room read on this device: its count goes at once.
    func markedRead(_ room: String) {
        unread[room] = nil
    }

    func room(_ id: String) -> Room? { rooms.first { $0.id == id } }

    func upsert(_ room: Room) {
        roomChanged(Change(action: .update, record: room))
    }

    // MARK: - App lifecycle

    func background() {
        guard let api else { return }
        Task { await api.realtime.pause() }
    }

    func foreground() {
        guard let api else { return }
        Task { await api.realtime.resume() }
    }
}
