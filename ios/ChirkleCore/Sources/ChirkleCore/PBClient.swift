// A minimal PocketBase client (android's pb/PbClient.kt, web/src/pb.ts): REST requests with the auth header, filter
// binding, file URLs. The realtime half is Realtime.swift.
import Foundation

/// A failed request. `status` is 0 for network trouble; `fields` are PocketBase's per-field messages, `codes` their
/// codes (match on these, not on messages).
public struct APIError: Error, LocalizedError, Sendable {
    public var status: Int
    public var message: String
    public var fields: [String: String]
    public var codes: [String: String]

    public init(status: Int, message: String = "", fields: [String: String] = [:], codes: [String: String] = [:]) {
        self.status = status
        self.message = message
        self.fields = fields
        self.codes = codes
    }

    /// A sentence to show for it (android's errorMessage).
    public var errorDescription: String? {
        switch status {
        case 0: return Strings.cantReachServer
        case 429: return Strings.tooManyAttempts
        default: return message.isEmpty ? Strings.somethingWentWrong : message
        }
    }

    /// The server's reason for a field when it gave one, else the sentence above.
    public var reason: String { fields.values.first ?? errorDescription ?? Strings.somethingWentWrong }
}

/// A file to upload in a multipart body.
public struct UploadFile: Sendable {
    public var name: String
    public var type: String
    public var data: Data

    public init(name: String, type: String, data: Data) {
        self.name = name
        self.type = type
        self.data = data
    }
}

/// A request body: JSON, or multipart when it holds files.
public enum Body: Sendable {
    case json([String: JSONValue])
    case multipart(fields: [String: String], files: [String: [UploadFile]])
}

/// A JSON value to send.
public enum JSONValue: Sendable, Encodable, Hashable {
    case string(String)
    case bool(Bool)
    case int(Int)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case let .string(s): try c.encode(s)
        case let .bool(b): try c.encode(b)
        case let .int(i): try c.encode(i)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByBooleanLiteral, ExpressibleByIntegerLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(integerLiteral value: Int) { self = .int(value) }
}

public final class PBClient: Sendable {
    public let base: URL
    public let session: URLSession
    public let authStore: AuthStore

    public init(baseURL: URL, authStore: AuthStore, session: URLSession = .shared) {
        var s = baseURL.absoluteString
        while s.hasSuffix("/") { s.removeLast() }
        base = URL(string: s) ?? baseURL
        self.authStore = authStore
        self.session = session
    }

    public var token: String { authStore.session?.token ?? "" }

    public func url(_ path: String, query: [(String, String)] = []) -> URL {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = c.path + path
        if !query.isEmpty {
            c.queryItems = query.map { URLQueryItem(name: $0.0, value: $0.1) }
            // URLComponents leaves "+" as is, which servers read as a space; PocketBase's filters and times have them.
            c.percentEncodedQuery = c.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        }
        return c.url!
    }

    /// Send a request; the answer's body (nil for a 204), or an `APIError`.
    @discardableResult
    public func send(_ path: String, method: String = "GET", query: [(String, String)] = [], body: Body? = nil) async throws -> Data? {
        var req = URLRequest(url: url(path, query: query))
        req.httpMethod = method
        let token = self.token
        if !token.isEmpty { req.setValue(token, forHTTPHeaderField: "Authorization") }
        switch body {
        case let .json(obj):
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(obj)
        case let .multipart(fields, files):
            let boundary = "chirkle-" + newId()
            req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            req.httpBody = multipart(boundary: boundary, fields: fields, files: files)
        case nil:
            if method != "GET" && method != "DELETE" {
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = Data("{}".utf8)
            }
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError(status: 0)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let parsed = data.isEmpty ? nil : try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        if status >= 400 {
            throw Self.error(status, parsed as? [String: Any])
        }
        // A success without JSON (a proxy's or a captive portal's page, an answer cut short) is network trouble, not
        // `{}` (the web's QA BUG-117; android BUG-158).
        if parsed == nil && status != 204 { throw APIError(status: 0) }
        return status == 204 ? nil : data
    }

    static func error(_ status: Int, _ body: [String: Any]?) -> APIError {
        var fields: [String: String] = [:]
        var codes: [String: String] = [:]
        if let d = body?["data"] as? [String: Any] {
            for (k, v) in d {
                guard let o = v as? [String: Any] else { continue }
                if let m = o["message"] as? String { fields[k] = m }
                if let c = o["code"] as? String { codes[k] = c }
            }
        }
        return APIError(status: status, message: body?["message"] as? String ?? "", fields: fields, codes: codes)
    }

    private func multipart(boundary: String, fields: [String: String], files: [String: [UploadFile]]) -> Data {
        var d = Data()
        func line(_ s: String) { d.append(Data((s + "\r\n").utf8)) }
        for (k, v) in fields.sorted(by: { $0.key < $1.key }) {
            line("--\(boundary)")
            line("Content-Disposition: form-data; name=\"\(Self.quote(k))\"")
            line("")
            line(v)
        }
        for (k, list) in files.sorted(by: { $0.key < $1.key }) {
            for f in list {
                line("--\(boundary)")
                line("Content-Disposition: form-data; name=\"\(Self.quote(k))\"; filename=\"\(Self.quote(f.name))\"")
                line("Content-Type: \(f.type)")
                line("")
                d.append(f.data)
                line("")
            }
        }
        line("--\(boundary)--")
        return d
    }

    private static func quote(_ s: String) -> String {
        s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
    }

    /// Bind `{:name}` placeholders in a filter expression, quoting the values as `pb.filter()` does: a value never
    /// becomes part of the expression.
    public func filter(_ expr: String, _ params: [String: String]) -> String {
        var out = expr
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        for (k, v) in params {
            let data = (try? encoder.encode(v)) ?? Data("\"\"".utf8)
            out = out.replacingOccurrences(of: "{:\(k)}", with: String(decoding: data, as: UTF8.self))
        }
        return out
    }

    /// URL of a record's file (`thumb` in `query`).
    public func fileURL(_ collection: String, _ recordId: String, _ filename: String, query: [(String, String)] = []) -> URL {
        url("/api/files/\(Self.segment(collection))/\(Self.segment(recordId))/\(Self.segment(filename))", query: query)
    }

    static func segment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s
    }
}
