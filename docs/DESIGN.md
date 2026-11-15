# Chirkle — MVP Design Document

| | |
|---|---|
| **Status** | Draft |
| **Date** | 2026-10-10 |
| **Scope** | MVP (§1–§14); post-MVP features: avatars §15, direct messages §16, attachments §17, unread counts §18, replies §19, reactions and emoji §20, selecting, forwarding and deleting several messages §21, accounts and quality of life §22, room access (private rooms, Open Air rooms and guests) §23, site settings §24, measured scale §25, Telegram bridge §26, …, media grid §30, media collections §31, Jump to §32, linked instances §33 |

Code and tests cite this document by section number (e.g. `§7.5`). **Don't renumber sections:** append new ones, and
mark obsolete ones as such instead of deleting them.

Each section is a file of its own in [`design/`](design/), named by its number: §7.5 is in
`design/07-frontend-design.md`, under its heading "7.5". A new section is a new file, numbered after the last.

| § | Section |
|---|---|
| §1 | [Summary](design/01-summary.md) |
| §2 | [Goals and non-goals](design/02-goals-and-non-goals.md) |
| §3 | [Architecture](design/03-architecture.md) |
| §4 | [Repository layout](design/04-repository-layout.md) |
| §5 | [Data model](design/05-data-model.md) |
| §6 | [API usage (frontend ↔ backend)](design/06-api-usage-frontend-backend.md) |
| §7 | [Frontend design](design/07-frontend-design.md) |
| §8 | [Build and dev tooling](design/08-build-and-dev-tooling.md) |
| §9 | [Testing strategy](design/09-testing-strategy.md) |
| §10 | [Security considerations](design/10-security-considerations.md) |
| §11 | [Deployment](design/11-deployment.md) |
| §12 | [Milestones](design/12-milestones.md) |
| §13 | [Decisions and open questions](design/13-decisions-and-open-questions.md) |
| §14 | [Future work (post-MVP)](design/14-future-work-post-mvp.md) |
|  | [Post-MVP features](design/post-mvp-features.md) |
| §15 | [Avatars](design/15-avatars.md) |
| §16 | [Direct messages](design/16-direct-messages.md) |
| §17 | [Attachments](design/17-attachments.md) |
| §18 | [Unread counts](design/18-unread-counts.md) |
| §19 | [Replies](design/19-replies.md) |
| §20 | [Reactions and emoji](design/20-reactions-and-emoji.md) |
| §21 | [Selecting, forwarding and deleting several messages](design/21-selecting-forwarding-and-deleting-several-messages.md) |
| §22 | [Accounts and quality of life](design/22-accounts-and-quality-of-life.md) |
| §23 | [Room access: private rooms and Open Air](design/23-room-access-private-rooms-and-open-air.md) |
| §24 | [Site settings: branding and invite-only signups](design/24-site-settings-branding-and-invite-only-signups.md) |
| §25 | [Measured scale](design/25-measured-scale.md) |
| §26 | [Telegram bridge](design/26-telegram-bridge.md) |
| §27 | [Installable app (PWA)](design/27-installable-app-pwa.md) |
| §28 | [Link previews](design/28-link-previews.md) |
| §29 | [Message search](design/29-message-search.md) |
| §30 | [Media grid](design/30-media-grid.md) |
| §31 | [Media collections](design/31-media-collections.md) |
| §32 | [Jump to](design/32-jump-to.md) |
| §33 | [Linked instances](design/33-linked-instances.md) |
| §34 | [Notifications (2026-10-24)](design/34-notifications.md) |
| §35 | [Anonymous rooms (2026-11-03)](design/35-anonymous-rooms.md) |
| §36 | [Moderators (2026-11-03)](design/36-moderators.md) |
| §37 | [Shared files, opened by URL (2026-11-04)](design/37-shared-files-opened-by-url.md) |
| §39 | [Forgot password (2026-11-08)](design/39-forgot-password.md) |
| §40 | [Usage statistics (2026-11-09)](design/40-usage-statistics.md) |
| §41 | [Handles, mentions and "Mentions & replies" (2026-11-10)](design/41-handles-mentions-and-mentions-replies.md) |
| §42 | [Retention and server metrics (2026-11-12)](design/42-retention-and-server-metrics.md) |
| §43 | [Your data and deleting your account (2026-11-15)](design/43-your-data-and-deleting-your-account.md) |
