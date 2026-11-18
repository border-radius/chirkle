// PocketBase realtime (android's pb/Realtime.kt, web/src/pb.ts): one SSE stream whose PB_CONNECT event carries the
// client id; the set of subscriptions (topic plus its options) is POSTed to /api/realtime whenever it changes, and
// again after a reconnect. All state lives on the actor.
import Foundation

/// What `subscribe` returns: pass it to `unsubscribe`.
public struct Subscription: Hashable, Sendable {
    let key: String
    let id: UUID
}

public actor Realtime {
    private let pb: PBClient
    /// The stream never ends: no per-request timeout, but one longer than the server's 3-minute keepalive for a
    /// connection that went quiet without closing.
    private let stream: URLSession

    /// Subscription key → listeners, keys in the order first subscribed. A key is the topic plus its options, and the
    /// event name the server sends its events under.
    private var subs: [String: [UUID: @Sendable (Data) -> Void]] = [:]
    private var order: [String] = []
    private var connectHandlers: [UUID: @Sendable (Bool) -> Void] = [:]

    private var loop: Task<Void, Never>?
    private var clientId = ""
    private var lastSent: [String] = []
    private var submitChain: Task<Void, Error>?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var everConnected = false
    private var lost = false
    private var paused = false

    private static let backoff: [UInt64] = [200, 300, 500, 1000, 1200, 1500, 2000, 5000, 10000, 30000]

    public init(pb: PBClient) {
        self.pb = pb
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 240
        config.timeoutIntervalForResource = .infinity
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        stream = URLSession(configuration: config)
    }

    public var isConnected: Bool { !clientId.isEmpty }

    /// Listen to `topic` ("chat/messages", or a collection's "rooms/*"), with `query` (fields, expand, filter) applied
    /// to its events. Returns once the server has it, or the first connect failed (the reconnects go on and send it).
    /// `listener` gets each event's JSON; it runs on the actor and must not block.
    public func subscribe(_ topic: String, query: [String: String]? = nil, _ listener: @escaping @Sendable (Data) -> Void) async -> Subscription {
        let key = Self.key(topic, query)
        let id = UUID()
        if subs[key] == nil {
            subs[key] = [:]
            order.append(key)
        }
        subs[key]![id] = listener
        if !paused {
            if loop == nil {
                start()
                await withCheckedContinuation { waiters.append($0) }
            } else if !clientId.isEmpty {
                try? await submit()
            }
        }
        return Subscription(key: key, id: id)
    }

    public func unsubscribe(_ s: Subscription) async {
        subs[s.key]?[s.id] = nil
        if subs[s.key]?.isEmpty == true {
            subs[s.key] = nil
            order.removeAll { $0 == s.key }
        }
        if subs.isEmpty {
            stop()
        } else {
            try? await submit()
        }
    }

    /// Hear every (re)connect, once its subscriptions are in: `true` when events may have been missed before it.
    @discardableResult
    public func onConnect(_ fn: @escaping @Sendable (Bool) -> Void) -> UUID {
        let id = UUID()
        connectHandlers[id] = fn
        return id
    }

    public func removeConnectHandler(_ id: UUID) {
        connectHandlers[id] = nil
    }

    /// Close the connection while the app is in the background; `resume` opens it again.
    public func pause() {
        guard !paused else { return }
        paused = true
        stop()
    }

    public func resume() {
        guard paused else { return }
        paused = false
        if !subs.isEmpty {
            lost = true
            start()
        }
    }

    /// A new session (log in, log out, another account): the server knows a client by the token its subscriptions
    /// were sent with, so the connection is made again (QA BUG-52, BUG-66).
    public func restart() {
        guard loop != nil else { return }
        stop()
        lost = true
        start()
    }

    /// Drop every subscription and close the connection.
    public func unsubscribeAll() {
        subs = [:]
        order = []
        stop()
    }

    // MARK: - Connection

    private func start() {
        guard loop == nil, !paused else { return }
        loop = Task { await self.run() }
    }

    private func stop() {
        loop?.cancel()
        loop = nil
        submitChain?.cancel()
        submitChain = nil
        clientId = ""
        lastSent = []
        wakeWaiters()
    }

    private func wakeWaiters() {
        let w = waiters
        waiters = []
        for c in w { c.resume() }
    }

    private func run() async {
        var attempt = 0
        while !Task.isCancelled {
            do {
                var req = URLRequest(url: pb.url("/api/realtime"))
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, response) = try await stream.bytes(for: req)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw APIError(status: 0) }
                var parser = SSEParser()
                for try await b in bytes {
                    guard let e = parser.feed(b) else { continue }
                    if e.event == "PB_CONNECT" {
                        try await connected(e)
                        attempt = 0
                    } else {
                        dispatch(e)
                    }
                }
            } catch {
                if Task.isCancelled { return }
            }
            if Task.isCancelled { return }
            // Lost: those waiting for the first connect go on; the reconnects send their subscriptions.
            clientId = ""
            lastSent = []
            lost = true
            wakeWaiters()
            let wait = Self.backoff[min(attempt, Self.backoff.count - 1)]
            attempt += 1
            try? await Task.sleep(nanoseconds: wait * 1_000_000)
        }
    }

    private func connected(_ e: SSEEvent) async throws {
        var id = e.id
        if let obj = try? JSONSerialization.jsonObject(with: Data(e.data.utf8)) as? [String: Any], let cid = obj["clientId"] as? String {
            id = cid
        }
        clientId = id
        lastSent = []
        try await submit()
        let reconnect = everConnected || lost
        everConnected = true
        lost = false
        wakeWaiters()
        for fn in connectHandlers.values { fn(reconnect) }
    }

    private func dispatch(_ e: SSEEvent) {
        guard let listeners = subs[e.event] else { return }
        let data = Data(e.data.utf8)
        for fn in listeners.values { fn(data) }
    }

    /// POST the subscriptions if they changed since last sent. One after another, so an older set never lands
    /// after a newer one.
    private func submit() async throws {
        let previous = submitChain
        let next = Task {
            _ = try? await previous?.value
            try await self.sendSubscriptions()
        }
        submitChain = next
        try await next.value
    }

    private func sendSubscriptions() async throws {
        guard !clientId.isEmpty, order != lastSent else { return }
        let keys = order
        lastSent = keys
        do {
            try await pb.send("/api/realtime", method: "POST", body: .json([
                "clientId": .string(clientId),
                "subscriptions": .array(keys.map { .string($0) }),
            ]))
        } catch {
            if lastSent == keys { lastSent = [] }
            throw error
        }
    }

    /// The topic plus its options, as the JS SDK writes it.
    static func key(_ topic: String, _ query: [String: String]?) -> String {
        guard let query, !query.isEmpty else { return topic }
        let data = (try? JSONSerialization.data(withJSONObject: ["query": query], options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
        return topic + "?options=" + encodeURIComponent(String(decoding: data, as: UTF8.self))
    }
}

/// JavaScript's encodeURIComponent.
func encodeURIComponent(_ s: String) -> String {
    let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.!~*'()")
    return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
}
