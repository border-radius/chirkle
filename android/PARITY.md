# Parity with the web app

Each web e2e spec (`tests/e2e/`) and the Android tests that cover the same behaviour (ANDROID.md §13). A web feature
without an entry here fails review. **Covered**: the scenario runs on the app's screens (Robolectric, against a real
PocketBase). **Partial**: the behaviour is tested below the screens (API, services, room controller), or only some of
the spec's cases are. **Not yet**: no Android test.

Test classes: `UiFlowTest`, `UiFeaturesTest`, `UiPortsTest`, `UiCollectionsTest`, `UiNotifyTest`, `UiLinkedTest`, `RoutesTest` (`app/src/test`); `ServicesTest`, `ChirkleApiTest`, `CollectionsTest`, `NotifyCheckTest`, the
`lib` tests (`core/data/src/test`), among them `ContractTest`, `VectorsTest`, `WindowVectorsTest` and `LegacyPagesTest`, which run the web's shared
contract and vectors (`shared/`, docs/API.md); and `RoomScenariosTest` (`core/data`, repo), which replays the web room
controller's recorded scenarios (`shared/vectors/room.json`).

| Web spec | Android | Status |
|---|---|---|
| `smoke` | `UiFlowTest`: log in, open a room, send, the server has it; `UiFeaturesTest`: a message sent at the bottom of a full room shows whole | Covered |
| `signup` | `UiFeaturesTest`: signing up logs you in; `ChirkleApiTest`: sign up | Covered |
| `session` | `UiFlowTest`: a wrong password says so; `ServicesTest`: logging out clears the session's data, and so does a session that ran out while the app was closed (QA BUG-145, web: `app.test.ts`); a session revoked elsewhere ends on coming back or when a room of yours "doesn't exist" (QA BUG-183) | Partial: two sessions |
| `accounts` | `UiFeaturesTest`: renaming yourself | Partial: password change |
| `avatar` | — | Not yet (the photo picker can't be driven on Robolectric; changed by hand on the emulator, ANDROID.md §22.3) |
| `realtime` | `UiFlowTest`: a live message; `ServicesTest`, `ChirkleApiTest`: realtime events | Covered |
| `reconnect` | `ChirkleApiTest`: reconnect after a pause says events may have been missed | Partial: gap fill after it |
| `history` | `ServicesTest`: opens around a message far back, jumps to the latest | Partial: scrolling the edges |
| `unread` | `ServicesTest`: live counts, read on the server; `UiPortsTest`: unread rooms listed first, a folded section lists only them; `UiFeaturesTest`: what came while the app was in the background is read on coming back (QA BUG-157); `UiPortsTest`: opening a room reads only what is on screen, scrolling down the rest (ANDROID.md §25); `ServicesTest`: a read that fails is sent again by itself (QA BUG-162); `RoomSectionsTest` | Partial: the badge and the "New" line on screen |
| `edit` | `UiFeaturesTest`: edit, delete, a message's menu closing when it is deleted meanwhile (QA BUG-156); `ServicesTest`: edit, delete | Covered |
| `reactions` | `UiFeaturesTest`: quick reactions; `ServicesTest`; `HelpersTest`: the web's reaction cases | Covered |
| `replies` | `UiFeaturesTest`: reply and its quote; `ServicesTest`: a live reply's quote from the window, kept through an edit, or fetched (ANDROID.md §34); `UiFeaturesTest`: quotes and the reply bar follow the original's edit and delete (QA BUG-181, BUG-182); `ChirkleApiTest` | Partial: going to the original |
| `forward` | `UiFeaturesTest`: forwarding one message; `ChirkleApiTest` | Partial: several at once, delete together |
| `dm` | `UiFeaturesTest`: a new DM from the people search; `ChirkleApiTest` | Partial: close and reopen |
| `hide` | `UiFeaturesTest`: hiding a room (listed under the one Hidden & archived heading, ANDROID.md §36) | Partial: unhide |
| `archive` | `UiFeaturesTest`: an archived room is read-only; `ServicesTest` | Covered |
| `room_access` | `UiFeaturesTest`: private with a member; `ChirkleApiTest` | Partial: who can post, Open Air |
| `attachments` | `UiPortsTest`: the viewer drops a message deleted while it is open (QA BUG-155); `CollectionsTest`: a sent file's shape (`file_dims`, DESIGN.md §17.5) | Partial: picking files (pickers; sent through the system picker by hand on the emulator, ANDROID.md §22.3; the outbox sends files: `Outbox`); `ImagePrepTest`: photos upright before re-encoding on Android 8 (QA BUG-164); downloads by hand on the emulator (QA BUG-161, ANDROID.md §26) |
| `search` | `UiFeaturesTest`: find and go to a message far back; the message gone to shows whole though the ones after it are tall (QA BUG-163); `TextTest`: the web's search cases | Covered |
| `cache` | `ServicesTest`: the room is kept for next time; a private room you are taken out of is kept empty (QA BUG-160); the room opened again from a link stays the active one (QA BUG-168) | Partial: opening from it |
| `urls` | `RoutesTest`: links to rooms, messages and collections | Covered |
| `xss` | `LinksTest`: only http(s) become links. Compose shows text as text: there is no HTML to inject | Covered |
| `a11y` | — | Not yet (content descriptions are set; no automated check, no TalkBack pass) |
| `mobile` | — | Not applicable: the web's narrow layout |
| `media` | `UiPortsTest`: a room's images in the grid, one opened in the viewer; an empty room says so | Partial: paging, video posters (on the emulator only) |
| `switcher` | `UiPortsTest`: Jump to finds a room by a word and opens it; `JumpTest`: the web's matching and ranking cases; `ServicesTest`: the last-open times are forgotten with the session (QA BUG-152) | Covered |
| `theme` | `UiPortsTest`: Appearance set to Dark is kept; the 2026-10-31 redesign's colours in both (ANDROID.md §36); Inter without contextual alternates, as the web (QA BUG-191, ANDROID.md §37) | Covered |
| `collections` | `UiCollectionsTest`: make one from the room list, save from a tile, a badge to a public one, subscribe, "1 new" live and seen, attach from the picker with its badge, save and unsave in the viewer; `CollectionsTest`: badges follow a collection made public, renamed, private and deleted, live; a follow made while the subscription is on its way shows (QA BUG-170) | Partial: uploading (the photo picker can't be driven on Robolectric), axe |
| `pwa` | — | Not applicable: the app is the installed app (§3) |
| `linked` (two servers; also `tests/component/views/room/linked.test.ts`, `rooms.test.ts`) | `UiLinkedTest`: a shared room's top bar and access screen, New message by address; `LinkedTest` (also a DM that takes no messages, QA BUG-178); `ChirkleApiTest`: a shared room and a stand-in decode, an address refused with its reason. Between servers: `tests/integration/federation.test.ts` | Covered |
| — (Android only) | Servers and accounts (ANDROID.md §17): `AccountsTest`, `ServersTest` (add, switch, links and pushes find their account, refused sessions, addresses), `UiAccountsTest` (add an account on another server, switch from the account list opened by the brand, a bad address, log out to another account) | Covered |
| `notify` (web: while a tab is open, DESIGN.md §34) | Notifications of DMs and replies by a periodic check, no Google (ANDROID.md §21): `NotifyCheckTest` (DMs and replies once; every message of a room chosen in its menu, ANDROID.md §24; not other plain messages, from before sign-in, read elsewhere, hidden, on screen, the open room; a check failing part way loses nothing, QA BUG-153), `UiNotifyTest` (the worker's check posts them on their channels at their messages' times, takes a read one away; Notify of every message from the room's menu) | Covered; tried on the emulator (ANDROID.md §22.1). The app checks every 15 minutes, the web alerts live but only with a tab open; the web's sound has no app equivalent (the channels' own sounds) |
| — (Android only) | `android.test.ts` (server): App Links, minimum version (push was removed from the server on 2026-10-28) | Covered on the server |
| — (server API, 2026-10-29) | Pages, search, the room list and the notification check as routes (ANDROID.md §31): `WindowVectorsTest` and `VectorsTest` (the page and search builders, the same vectors as the web), `LegacyPagesTest` (the records API filters for servers from before the routes), `LegacyServerTest` (one session against a current server and one without the routes, or an old release's hooks), `ChirkleApiTest`, `NotifyCheckTest` and every screen test that pages or searches. Server: `tests/integration/lists.test.ts`, `search.test.ts` | Covered |
