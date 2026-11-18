import XCTest
@testable import ChirkleCore

// The cases of tests/unit/lib/links.test.ts (and android's LinksTest): the app links exactly what the web does.
final class LinksTests: XCTestCase {
    private func link(_ text: String, _ href: String? = nil) -> TextPart { .link(text: text, href: URL(string: href ?? text)!) }
    private func p(_ text: String) -> TextPart { .plain(text) }

    func testTextWithoutLinks() {
        XCTAssertEqual(linkify("hello there"), [p("hello there")])
        XCTAssertEqual(linkify(""), [])
    }

    func testHttpAndHttps() {
        XCTAssertEqual(linkify("see https://example.com/a?b=1#c now"), [p("see "), link("https://example.com/a?b=1#c"), p(" now")])
        XCTAssertEqual(linkify("http://example.com"), [link("http://example.com", "http://example.com/")])
        XCTAssertEqual(linkify("a https://a.io b https://b.io"), [p("a "), link("https://a.io", "https://a.io/"), p(" b "), link("https://b.io", "https://b.io/")])
    }

    func testWww() {
        XCTAssertEqual(linkify("go to www.example.com"), [p("go to "), link("www.example.com", "https://www.example.com/")])
    }

    func testPunctuation() {
        XCTAssertEqual(linkify("look: https://example.com/x."), [p("look: "), link("https://example.com/x"), p(".")])
        XCTAssertEqual(linkify("https://example.com/x?!"), [link("https://example.com/x"), p("?!")])
        XCTAssertEqual(linkify("\"https://example.com/x\","), [p("\""), link("https://example.com/x"), p("\",")])
        XCTAssertEqual(linkify("„https://example.com/x“"), [p("„"), link("https://example.com/x"), p("“")])
        XCTAssertEqual(linkify("https://example.com…"), [link("https://example.com", "https://example.com/"), p("…")])
        XCTAssertEqual(linkify("见https://example.com/x。"), [p("见"), link("https://example.com/x"), p("。")])
    }

    func testWwwInsideAnotherName() {
        for text in ["bob@www.example.com", "my.www.example.com", "x-www.example.com"] { XCTAssertEqual(linkify(text), [p(text)]) }
        XCTAssertEqual(linkify("end.https://example.com/x"), [p("end."), link("https://example.com/x")])
    }

    func testBrackets() {
        XCTAssertEqual(linkify("(see https://example.com/x)"), [p("(see "), link("https://example.com/x"), p(")")])
        XCTAssertEqual(linkify("https://en.wikipedia.org/wiki/Rust_(language)"), [link("https://en.wikipedia.org/wiki/Rust_(language)")])
        XCTAssertEqual(linkify("[https://example.com/x]"), [p("["), link("https://example.com/x"), p("]")])
    }

    func testOnlyHttp() {
        for text in ["javascript:alert(1)", "data:text/html,<b>x</b>", "file:///etc/passwd", "mailto:a@example.com", "ftp://example.com"] {
            XCTAssertEqual(linkify(text), [p(text)])
        }
        XCTAssertEqual(linkify("http:// nothing"), [p("http:// nothing")])
        XCTAssertEqual(linkify("xhttps://example.com"), [p("xhttps://example.com")])
    }

    func testStops() {
        XCTAssertEqual(linkify("<https://example.com/x>"), [p("<"), link("https://example.com/x"), p(">")])
        XCTAssertEqual(linkify("https://example.com/x　次"), [link("https://example.com/x"), p("　次")])
    }
}

final class HelpersTests: XCTestCase {
    func testIds() {
        let ids = (0 ..< 200).map { _ in newId() }
        XCTAssertEqual(Set(ids).count, 200)
        for id in ids { XCTAssertNotNil(id.range(of: "^[a-z0-9]{15}$", options: .regularExpression)) }
    }

    func testTimes() {
        let s = pbNow(Date(timeIntervalSince1970: 1_700_000_000.25))
        XCTAssertEqual(s, "2023-11-14 22:13:20.250Z")
        XCTAssertEqual(pbDate(s)?.timeIntervalSince1970 ?? 0, 1_700_000_000.25, accuracy: 0.001)
    }

    func testFileNames() {
        XCTAssertEqual(displayName("report_k3j2h1g0f9.pdf"), "report.pdf")
        XCTAssertEqual(displayName("notes"), "notes")
        XCTAssertTrue(isImage("a.JPG"))
        XCTAssertTrue(isVideo("a.mov"))
        XCTAssertFalse(isImage("a.pdf"))
    }

    func testTokenExpiry() {
        // {"exp":2000000000}
        let token = "e30." + Data(#"{"exp":2000000000}"#.utf8).base64EncodedString().replacingOccurrences(of: "=", with: "") + ".sig"
        XCTAssertEqual(tokenExp(token)?.timeIntervalSince1970, 2_000_000_000)
        XCTAssertNil(tokenExp("nope"))
    }

    func testFilterBinding() {
        let pb = PBClient(baseURL: URL(string: "https://x.example/")!, authStore: MemoryAuthStore())
        XCTAssertEqual(pb.filter("room = {:room}", ["room": "a\" || 1=1"]), #"room = "a\" || 1=1""#)
        XCTAssertEqual(pb.url("/api/x", query: [("t", "2026-01-01 00:00:00.000Z+1")]).absoluteString, "https://x.example/api/x?t=2026-01-01%2000:00:00.000Z%2B1")
    }

    func testRealtimeKeys() {
        XCTAssertEqual(Realtime.key("chat/messages", nil), "chat/messages")
        XCTAssertEqual(Realtime.key("room_reads/*", ["fields": "id,room"]), "room_reads/*?options=%7B%22query%22%3A%7B%22fields%22%3A%22id%2Croom%22%7D%7D")
    }
}

final class SSEParserTests: XCTestCase {
    func testEvents() {
        var p = SSEParser()
        let events = p.feed(Array("id:abc\nevent:PB_CONNECT\ndata:{\"clientId\":\"abc\"}\n\n: comment\r\nevent: x\r\ndata: a\r\ndata: b\r\n\r\n".utf8))
        XCTAssertEqual(events, [
            SSEEvent(id: "abc", event: "PB_CONNECT", data: #"{"clientId":"abc"}"#),
            SSEEvent(id: "abc", event: "x", data: "a\nb"),
        ])
    }

    func testSplitAcrossChunks() {
        var p = SSEParser()
        XCTAssertEqual(p.feed(Array("event:a\nda".utf8)), [])
        XCTAssertEqual(p.feed(Array("ta:1\n".utf8)), [])
        XCTAssertEqual(p.feed(Array("\n".utf8)), [SSEEvent(id: "", event: "a", data: "1")])
    }
}
