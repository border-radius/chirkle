// "@handle" in message text (§41). Pure, so what is a mention is unit-tested (shared/vectors/mentions.json). Keep in
// sync with pb_hooks/lib/handles.js MENTION and the app's lib/Mentions.kt.

/** "@handle": after the start or anything but a letter, digit, "_", "@", "." or "/", and not followed by one of those. */
const MENTION = /(^|[^A-Za-z0-9_@./])@([A-Za-z0-9_]{3,24})(?![A-Za-z0-9_@])/g;

/** `text` as plain strings and its mentions: `handle` in lower case without the "@", `text` as written. */
export function splitMentions(text: string): (string | { handle: string; text: string })[] {
  const out: (string | { handle: string; text: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(MENTION)) {
    const start = m.index + m[1]!.length;
    if (start > at) out.push(text.slice(at, start));
    out.push({ handle: m[2]!.toLowerCase(), text: `@${m[2]}` });
    at = start + m[2]!.length + 1;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
