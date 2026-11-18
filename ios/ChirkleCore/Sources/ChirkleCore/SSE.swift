// A Server-Sent Events parser (the WHATWG rules PocketBase's /api/realtime needs): fed bytes, it hands back each
// event once its blank line arrives. URLSession.AsyncBytes.lines drops empty lines, which end events, so the stream
// is split here instead.
import Foundation

public struct SSEEvent: Hashable, Sendable {
    public var id: String
    public var event: String
    public var data: String
}

public struct SSEParser: Sendable {
    private var line: [UInt8] = []
    private var lastWasCR = false
    private var id = ""
    private var event = ""
    private var data: [String] = []

    public init() {}

    /// Feed one byte; the events it completes.
    public mutating func feed(_ byte: UInt8) -> SSEEvent? {
        if byte == UInt8(ascii: "\n") && lastWasCR {
            lastWasCR = false
            return nil
        }
        lastWasCR = byte == UInt8(ascii: "\r")
        if byte == UInt8(ascii: "\n") || byte == UInt8(ascii: "\r") {
            let l = String(decoding: line, as: UTF8.self)
            line.removeAll(keepingCapacity: true)
            return take(l)
        }
        line.append(byte)
        return nil
    }

    /// Feed a chunk; the events it completes.
    public mutating func feed(_ bytes: some Sequence<UInt8>) -> [SSEEvent] {
        var out: [SSEEvent] = []
        for b in bytes { if let e = feed(b) { out.append(e) } }
        return out
    }

    private mutating func take(_ l: String) -> SSEEvent? {
        if l.isEmpty {
            defer {
                event = ""
                data = []
            }
            if data.isEmpty { return nil }
            return SSEEvent(id: id, event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"))
        }
        if l.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring
        if let colon = l.firstIndex(of: ":") {
            field = l[..<colon]
            value = l[l.index(after: colon)...]
            if value.first == " " { value = value.dropFirst() }
        } else {
            field = Substring(l)
            value = ""
        }
        switch field {
        case "id": id = String(value)
        case "event": event = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}
