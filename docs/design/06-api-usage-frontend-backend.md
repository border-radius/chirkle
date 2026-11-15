# §6. API usage (frontend ↔ backend)

Part of the design document: [index](../DESIGN.md).

The frontend talks to PocketBase through `pb.ts`, a minimal client (about 2 KB gzipped) that replaced the official **PocketBase JS SDK** (about 10 KB, most of it admin services, OAuth2/OTP/MFA flows and cookie helpers the app never used; §13). It keeps the SDK 0.28 wire behavior the app relies on: JSON or multipart requests with the auth header, `pb.filter()` binding, the auth record in `localStorage` under the SDK's key `pocketbase_auth` (shared with other tabs through the `storage` event), and the realtime protocol (one `EventSource`, `PB_CONNECT` client id, subscriptions POSTed to `/api/realtime` and resent after reconnects with the same backoff). Only `api.ts` imports it. A failed request rejects with a `PbError`, status 0 for network trouble, including a success whose body never came (the page navigated away mid-answer; taken as `{}` it saved an empty session, QA BUG-117). The record calls in the table below are named as in the SDK; `api.ts` implements them on top of `pb.send()`. The tests still use the SDK as an admin client.

| Action | Call |
|---|---|
| Sign up | `users.create({email, password, passwordConfirm, name})` then `authWithPassword` |
| Log in | `users.authWithPassword(email, password)` |
| Restore session | `pb.authStore.isValid` → `users.authRefresh()` in the background |
| Log out | `pb.authStore.clear()` + unsubscribe all |
| List rooms | `GET /api/chat/rooms` with `expand` and `fields` (`server/lists.go`): the rooms you can see, by name |
| List my hidden rooms | `hidden_rooms.getFullList({fields: "id,room"})` (fetched in parallel with rooms) |
| Create room | `rooms.create({name, created_by: me})` |
| Archive / unarchive room | `rooms.update(id, {archived: true \| false})` |
| Hide room | `hidden_rooms.create({user: me, room})` |
| Unhide room | `hidden_rooms.delete(hiddenRowId)` |
| Latest page | `GET /api/chat/rooms/{r}/messages?kind=latest` with `expand` and `fields: MSG_FIELDS`. The server writes the filter (`server/lists.go`), newest first |
| Older page (scroll up) | `kind=older&created={c}&id={i}`, the oldest loaded message as the cursor: `room = {:r} && (created < {:c} \|\| (created = {:c} && id < {:i}))` |
| Newer page (scroll down after jumping back) | `kind=newer&created={c}&id={i}`: `(created > {:c} \|\| (created = {:c} && id > {:i}))`, oldest first |
| One message (open `/r/:id/m/:msgId`) | `messages.getOne(id, {expand: "author", fields: MSG_FIELDS})`, then an older and a newer page around it |
| First page ("jump to beginning") | `kind=first`, oldest first. Also `kind=changed` (the edits and deletes missed offline) and `files=1` (the viewer's pages) |
| Send | `messages.create({id, room, author: me, text}, {expand: "author"})` |
| Edit | `messages.update(id, {text}, {expand: "author"})` |
| Delete (soft) | `messages.update(id, {deleted: true})` → the response has `text: ""`, `deleted: true` |
| Live room | `messages.subscribe("*", cb, {filter: pb.filter("room = {:r}", {r}), expand: "author", fields: MSG_FIELDS})` handles `create` and `update` (edits and soft deletes). A `delete` event only happens if a superuser hard-deletes a record, and it is handled by removing the message. |
| Live room list | `rooms.subscribe("*", cb)` (new rooms, renames, archive) + `hidden_rooms.subscribe("*", cb)` (keeps hide state in sync across tabs) |

`MSG_FIELDS = "id,room,text,created,updated,edited_at,deleted,author,expand.author.id,expand.author.name"`. Fetching only these fields keeps payloads small and never pulls user emails.

Pagination always uses **keyset cursors** on `(created, id)`, never page numbers, and passes `skipTotal: true`. Every page is a single index range scan, so it costs the same whether the room has 100 messages or 10 million. New inserts never shift page boundaries.

Filters are always built with `pb.filter()` and never by string concatenation, which prevents filter injection. Since
2026-10-29 the pages, search (§29), the room list and the app's notification check (ANDROID.md §21) are routes, so the
server can change its schema under them (docs/API.md). The clients still write a few filters on fields that won't move:
`id` (users by id), `room` (read positions, the live room), `collection` and `owner` (collections).
