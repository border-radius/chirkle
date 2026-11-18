// One open room (docs/IOS.md §5; the web's room controller, android's RoomController, cut down): the latest page,
// older pages on scrolling up, live messages, sends that show at once and can be retried with the same id, and the
// read position moved to the newest message on screen.
import ChirkleCore
import Foundation
import Observation

@MainActor
@Observable
final class RoomModel {
    let api: ChirkleAPI
    let roomId: String
    let me: String

    /// Oldest first.
    private(set) var messages: [Message] = []
    private(set) var loading = true
    private(set) var loadingOlder = false
    private(set) var reachedStart = false
    var error: String?

    /// Kept per room as typed (§22.3): saveDraft() on each change.
    var draft: String
    var replyTo: Message?
    var editing: Message?

    @ObservationIgnored private var sub: Subscription?
    @ObservationIgnored private var connectHandler: UUID?
    @ObservationIgnored private var readAt = ""
    private let onRead: @MainActor (String) -> Void

    private var draftKey: String { "draft." + roomId }

    func saveDraft() {
        UserDefaults.standard.set(draft, forKey: draftKey)
    }

    init(api: ChirkleAPI, roomId: String, me: String, onRead: @escaping @MainActor (String) -> Void) {
        self.api = api
        self.roomId = roomId
        self.me = me
        self.onRead = onRead
        draft = UserDefaults.standard.string(forKey: "draft." + roomId) ?? ""
    }

    func open() async {
        let room = roomId
        sub = await api.subscribeMessages(room: room) { [weak self] c in
            Task { @MainActor in self?.apply(c) }
        }
        connectHandler = await api.realtime.onConnect { [weak self] missed in
            if missed { Task { @MainActor in await self?.catchUp() } }
        }
        await loadLatest()
    }

    func close() async {
        if let sub { await api.realtime.unsubscribe(sub) }
        if let connectHandler { await api.realtime.removeConnectHandler(connectHandler) }
        sub = nil
        connectHandler = nil
    }

    private func loadLatest() async {
        do {
            let page = try await api.page(.latest(roomId))
            merge(page)
            reachedStart = page.count < ChirkleAPI.pageSize
            error = nil
        } catch let e as APIError {
            error = e.errorDescription
        } catch {}
        loading = false
        markRead()
    }

    /// After a lost connection: what came meanwhile, and the latest state of what is on screen.
    private func catchUp() async {
        guard let page = try? await api.page(.latest(roomId)) else { return }
        // A gap between the page and what we had: start again from the latest, rather than show a hole.
        if let oldest = page.last, let newest = messages.last(where: { $0.status == nil }), oldest.cursor > newest.cursor,
           page.count >= ChirkleAPI.pageSize
        {
            messages = messages.filter { $0.status != nil }
            reachedStart = false
        }
        merge(page)
        markRead()
    }

    func loadOlder() async {
        guard !loadingOlder, !reachedStart, let first = messages.first(where: { $0.status == nil }) else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await api.page(.older(roomId, first.cursor))
            merge(page)
            if page.count < ChirkleAPI.pageSize { reachedStart = true }
        } catch let e as APIError {
            error = e.errorDescription
        } catch {}
    }

    /// Put messages into the window by id, in (created, id) order; ones still sending stay last.
    private func merge(_ list: [Message]) {
        var byId = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for var m in list {
            if m.quoted == nil, !m.replyTo.isEmpty {
                if let kept = byId[m.id]?.quoted {
                    m.quoted = kept
                } else if let q = byId[m.replyTo] {
                    m.quoted = Quoted(of: q)
                }
            }
            byId[m.id] = m
        }
        messages = byId.values.sorted { a, b in
            switch (a.status == nil, b.status == nil) {
            case (true, false): return true
            case (false, true): return false
            default: return a.cursor < b.cursor
            }
        }
    }

    private func apply(_ c: Change<Message>) {
        switch c.action {
        case .delete:
            messages.removeAll { $0.id == c.record.id }
        case .create, .update:
            var m = c.record
            // Live events don't carry the message a reply answers (PERF.md §2.3): from the window, or fetched.
            if m.quoted == nil, !m.replyTo.isEmpty {
                if let old = messages.first(where: { $0.id == m.id }), let q = old.quoted {
                    m.quoted = q
                } else if let q = messages.first(where: { $0.id == m.replyTo }) {
                    m.quoted = Quoted(of: q)
                } else {
                    let id = m.id
                    Task {
                        if let full = try? await api.getMessage(id) { merge([full]) }
                    }
                }
            }
            // Only a message already in the window, or a new one at its end: not one far back while paging.
            if c.action == .create || messages.contains(where: { $0.id == m.id }) {
                merge([m])
            }
            // Quotes of it follow its edit and delete (QA BUG-181, BUG-182).
            for i in messages.indices where messages[i].replyTo == m.id {
                messages[i].quoted = Quoted(of: m)
            }
            if c.action == .create { markRead() }
        }
    }

    // MARK: - Reading

    /// You have read up to the newest message (§18): sent once, and only forward.
    func markRead() {
        guard let newest = messages.last(where: { $0.status == nil }), newest.created > readAt else { return }
        readAt = newest.created
        let room = roomId
        let at = newest.created
        onRead(room)
        Task { try? await api.markRead(room, at: at) }
    }

    // MARK: - Writing

    var canSend: Bool {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && t.count <= Contract.Limits.messageText
    }

    func submit() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        if let editing {
            self.editing = nil
            draft = ""
            do {
                merge([try await api.edit(editing.id, text: text)])
            } catch let e as APIError {
                error = e.reason
                draft = text
                self.editing = editing
            } catch {}
            return
        }
        var m = Message(id: newId(), room: roomId, author: me, text: text, created: pbNow(), replyTo: replyTo?.id ?? "", status: .pending)
        m.authorUser = api.currentUser
        if let r = replyTo { m.quoted = Quoted(of: r) }
        replyTo = nil
        draft = ""
        messages.append(m)
        await deliver(m)
    }

    func retry(_ m: Message) async {
        guard let i = messages.firstIndex(where: { $0.id == m.id }) else { return }
        messages[i].status = .pending
        await deliver(messages[i])
    }

    func discard(_ m: Message) {
        messages.removeAll { $0.id == m.id && $0.status != nil }
    }

    /// Send with the message's own id: a retry after a send that did reach the server is refused (400), not doubled.
    private func deliver(_ m: Message) async {
        do {
            let saved = try await api.send(id: m.id, room: m.room, text: m.text, replyTo: m.replyTo)
            messages.removeAll { $0.id == m.id }
            merge([saved])
            markRead()
        } catch let e as APIError {
            if e.status == 400, let saved = try? await api.getMessage(m.id) {
                messages.removeAll { $0.id == m.id }
                merge([saved])
                return
            }
            if let i = messages.firstIndex(where: { $0.id == m.id }) { messages[i].status = .failed }
            error = e.reason
        } catch {}
    }

    func startEdit(_ m: Message) {
        replyTo = nil
        editing = m
        draft = m.text
    }

    func cancelCompose() {
        if editing != nil { draft = "" }
        editing = nil
        replyTo = nil
    }

    func delete(_ m: Message) async {
        do {
            merge([try await api.softDelete(m.id)])
        } catch let e as APIError {
            error = e.reason
        } catch {}
    }

    func toggle(_ emoji: String, on m: Message) async {
        let on = !(m.reactions.first { $0.emoji == emoji }?.users.contains(me) ?? false)
        do {
            merge([try await api.react(m.id, emoji: emoji, on: on)])
        } catch let e as APIError {
            error = e.reason
        } catch {}
    }
}
