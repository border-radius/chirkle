# Chirkle — iPhone App

| | |
|---|---|
| **Status** | **Phase 1 (started 2026-11-18):** log in, rooms, messages live, send, reply, edit, delete, react. Not yet built on a Mac: CI (`.github/workflows/ios.yml`) is the first compiler it meets |
| **Scope** | A native iPhone client for any current Chirkle server, in **Swift** and **SwiftUI**, after the Android app ([`ANDROID.md`](ANDROID.md)) |

Sections are cited as `I§n` (e.g. `I§4`) to tell them from DESIGN.md's `§n` and ANDROID.md's `A§n`. **Don't renumber:**
append new sections, and mark obsolete ones as such.

---

## 1. Summary

The iPhone app is native, as the Android app is: SwiftUI screens on a small data layer (`ChirkleCore`) that ports
android's `core/data` API half (`api/ChirkleApi.kt`, `pb/PbClient.kt`, `pb/Realtime.kt`, `lib/`). No WebView, no
third-party dependencies: URLSession, the Keychain, Observation.

It is built in phases. Phase 1 is a chat client someone can use daily; later phases close the gap to the Android
app's feature list (I§3).

## 2. Goals and non-goals

**Goals:** the same rules and limits as the other clients (`shared/contract.json`, checked by `ContractTests`); every
route answer it reads decodes (`AnswersTests` over `shared/schema/answers.json`); tested against a real, throwaway
server like the other clients (I§7); no server change for the app's convenience.

**Non-goals (phase 1):** iPad layout, offline database (the Android app's Room cache, A§6), background notifications
(A§21: Android's periodic check has no iOS equivalent that runs reliably; real pushes would need APNs, which the server
doesn't do), several servers at once (A§17), servers from before 2026-11-09 (I§3).

## 3. Servers it talks to

ChirkleCore uses the list routes (`GET /api/chat/rooms`, `…/rooms/{room}/messages`, 2026-10-29) and the live topic
(`chat/messages`, 2026-11-09) and has **no records-API fallback** for older servers, unlike the Android app
(docs/API.md "Pages and the room list"). An older server shows errors in the room list. If that matters, port
`PageQuery.legacy()` and `hasLiveTopic()` from `ChirkleApi.kt`.

The realtime connection's User-Agent is URLSession's (`Chirkle/… CFNetwork/… Darwin/…`), so `server/stats.go`'s
`appOf` counts it as `other` (docs/API.md, usage statistics). Teach `appOf` a `CFNetwork/` case if iOS should count on
its own.

## 4. Layout

```
ios/
  project.yml              XcodeGen spec: the app target (no .xcodeproj checked in)
  App/                     SwiftUI app: ChirkleApp, AppModel (session, room list, unread), RoomModel (one room),
                           views, KeychainAuthStore, Assets.xcassets (icon from pb_public/icons/maskable-512.png)
  ChirkleCore/             Swift package, no UI, macOS-testable
    Sources/ChirkleCore/   Models, PBClient, ChirkleAPI, Realtime (SSE), SSE parser, Contract, Helpers (ids, links,
                           files, rooms)
    Tests/ChirkleCoreTests/ SharedTests (contract, answers), HelpersTests (links, ids, SSE), ServerTests (real server)
```

## 5. How it works

- **Session:** `Session { token, user }` in the Keychain, one item per server, `AfterFirstUnlockThisDeviceOnly`.
  Renewed with `auth-refresh` after launch, off the critical path; a 401/403/404 logs out.
- **Room list:** `GET /api/chat/rooms` and `GET /api/chat/unread`; live through `rooms/*` events, `chat/messages`
  (activity: the counts are fetched again, 300 ms after a burst) and `room_reads/*` (read elsewhere).
- **A room:** the latest page, `older` pages when the top comes into view, `chat/messages` events filtered to the room.
  Live events carry no `reply_to` expand (PERF.md §2.3): the quote comes from the window, or the message is fetched. A
  reconnect that may have missed events loads the latest page again and merges it.
- **Sending:** the message shows at once with a client-made id (I§2, DESIGN.md §17.4). A failed send can be retried
  with the same id; a 400 on retry means it did arrive and it is fetched instead.
- **Reading:** the room's read position goes to its newest message when it opens and as messages come
  (`POST /api/chat/reads`, which never moves back).
- **Drafts:** kept per room in UserDefaults.
- **Realtime:** one SSE stream (`Realtime` actor), PB_CONNECT's client id, subscriptions POSTed when they change, the
  Android app's backoff (200 ms … 30 s). Closed in the background, reopened in the foreground as a reconnect.

## 6. Building

There is no Mac in the development setup: **CI is the compiler.**

### 6.1 CI (`.github/workflows/ios.yml`)

On a change to `ios/`, `shared/`, the hooks, migrations or server: on `macos-15`, build `bin/chirkle-server` (the
repository's setup action), `swift test` in `ios/ChirkleCore` (ServerTests start that server), then `xcodegen` and an
unsigned simulator build of the app.

### 6.2 TestFlight (`.github/workflows/ios-release.yml`)

Push a tag `ios-v<version>` (or run it by hand). It archives, signs with Xcode's cloud-managed automatic signing, and
uploads to App Store Connect in one `-exportArchive` with `destination=upload`. One-time setup:

1. An Apple Developer Program membership; an App Store Connect app record for bundle id `com.chirkle.ios`.
2. An App Store Connect API key with the Admin role (cloud signing makes the distribution certificate).
3. The `release` environment's secrets: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`.

The build number is the workflow run number; the marketing version comes from the tag.

### 6.3 On a Mac

`brew install xcodegen && cd ios && xcodegen && open Chirkle.xcodeproj`, choose a team under Signing, run.
`cd ios/ChirkleCore && swift test` runs the core's tests (ServerTests need `npm run setup` first).

## 7. Tests

| Test | What |
|---|---|
| `ContractTests` | `Contract.swift` equals `shared/contract.json` (fields, limits, file types) |
| `AnswersTests` | The examples of every route the app reads decode; nulls and wrong types give defaults |
| `LinksTests` | The web's `links.test.ts` cases (as android's `LinksTest`) |
| `HelpersTests`, `SSEParserTests` | Ids, times, file names, JWT expiry, filter binding, realtime keys, SSE framing |
| `ServerTests` | Against `bin/chirkle-server`: sign up, log in, renew, log out; wrong password; send, page, edit, react, delete; a retried send makes no duplicate; a live message; unread counts and reads; a DM |

The SwiftUI screens have no automated tests yet (phase 2: XCUITest against the same server).

## 8. Parity with the Android app

What phase 1 has, of ANDROID.md §3's list. **Yes**: done. **Part**: some of it. **No**: not yet.

| Feature (DESIGN.md) | iOS | Notes |
|---|---|---|
| Sign up, log in, invite code, session restore (§22, §24.2) | Yes | |
| Password reset link (§39) | Yes | Opens the web page from the email, as Android |
| Branding: title and logo (§24) | Yes | |
| Room list, unread counts (§5, §18) | Part | No hide; archived listed under their own heading |
| Create a room (§5) | Part | Public only; no access settings (§23) |
| Room access: private, open air, writers (§23) | Part | Respected (who can post), not editable |
| Guests read Open Air rooms (§23.3) | No | |
| Live messages, edits, deletes (§7.5) | Yes | |
| Full history, paging (§6) | Part | Older pages; no jump to a message, no "New" line, no Jump to latest |
| Direct messages (§16) | Yes | Open from people search; closed DMs say so |
| Avatars (§15) | Part | Shown; can't be changed. No profile screen (rename is in ChirkleCore) |
| Search (§29) | No | `PageQuery.search` is in ChirkleCore |
| Replies (§19) | Part | Reply and quote; tapping a quote doesn't go to the original |
| Links (§7.6.3), link previews (§28) | Yes | |
| Reactions (§20) | Part | Chips and four quick reactions; no emoji picker |
| Attachments (§17) | Part | Images shown, files open in the browser; no upload |
| Image and video viewer (§17.7) | No | Opens the file URL |
| Select, forward, delete together (§21) | No | |
| Drafts (§22.3) | Yes | |
| Collections (§31), mentions inbox (§41), invite links (§44), export and delete account (§43) | No | |
| Notifications (A§21) | No | I§2 |
| Several servers (A§17) | No | One server; "Use another server" on the login screen |
