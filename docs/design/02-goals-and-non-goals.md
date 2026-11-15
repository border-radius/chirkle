# §2. Goals and non-goals

Part of the design document: [index](../DESIGN.md).

## Goals

1. **Working real-time chat.** Sign up or log in, list and create rooms, read history, and send and receive messages live.
   - Any user can create a room.
   - Each user can hide rooms they don't want to see.
   - Users can edit and delete their own messages. A deleted message leaves a "Message deleted" placeholder in the history.
   - Removing a room **archives** it. Archived rooms stay readable.
   - History is kept forever. A user can scroll back to the very first message in any room.
2. **Minimal and fast frontend.** No framework and no virtual DOM. Strict size budget (§7.7). The page should be interactive in about 1 second on a mid-range phone.
3. **Simple to run.** `npm run dev` gives a working local setup. Deployment is one binary plus a few folders.
4. **Secure by default.** All access control lives in PocketBase API rules. Untrusted text never reaches the page as HTML.
5. **Tested.** Unit, integration and end-to-end tests run in CI on every push.

## Non-goals (MVP)

These are left out on purpose. The design should not block them later.

- Private rooms, room membership or invitations (direct messages: now designed in §16)
- File and image uploads (avatars and attachments: now designed in §15 and §17), link previews
- Reactions, threads, replies, mentions (replies: now designed in §19; reactions: §20)
- Typing indicators, presence, read receipts
- Push notifications (notifications while a tab is open, without a push service: now §34), email notifications
- Message search (now designed in §29)
- OAuth providers (email and password only)
- Email verification (not required to sign up or post, so no SMTP needed; SMTP is optional, for forgot password: §39)
- Message retention limits (history is never pruned; other tables are, §42.1)
- Native mobile apps (Android: now designed in [`ANDROID.md`](../ANDROID.md)), offline support (a service worker for an installable app and an offline shell: now §27)
- End-to-end encryption
