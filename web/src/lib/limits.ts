// Field limits the UI enforces before the server does. They mirror pb_migrations (the source of truth);
// tests/integration/schema.test.ts fails if the two drift apart.

export const LIMITS = {
  /** messages.text max */
  messageText: 2000,
  /** users.name max */
  userName: 32,
  /** rooms.name max */
  roomName: 48,
  /** users password min (PocketBase's auth default) */
  passwordMin: 8,
  /**
   * users password max, in UTF-8 bytes: bcrypt's 72, PocketBase's 71. PocketBase refuses a longer one on signup without
   * saying why (QA BUG-267); the hooks say it for a change or a reset (PASSWORD_MAX_BYTES, lib/users.js).
   */
  passwordMaxBytes: 71,
  /** users.avatar maxSize (§15.1) */
  avatarBytes: 2 * 1024 * 1024,
  /** users.avatar mimeTypes (§15.1) */
  avatarTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"],
  /** messages.files maxSelect (§17.1) */
  attachments: 10,
  /** messages.files maxSize, per file (§17.1) */
  attachmentBytes: 20 * 1024 * 1024,
  /** rooms.members maxSelect: a private room's members, its creator included (§23.2) */
  roomMembers: 100,
} as const;

/** Length as PocketBase counts it for these limits: Unicode code points, not UTF-16 units (an emoji is 1, not 2). */
export function textLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Most messages that can be selected, and so deleted or forwarded at once (§21; MAX_MESSAGES in pb_hooks/lib/bulk.js). */
export const MAX_SELECTED = 50;
