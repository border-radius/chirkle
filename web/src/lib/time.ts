import * as S from "../strings/lib-time.ts";
// Time parsing and display (§7.5, §7.6.1). Intl formatters are created once per locale and reused.

/** "2026-10-10 12:34:56.789Z" → epoch ms (NaN for ""). */
export function parsePb(s: string): number {
  return s ? Date.parse(s.replace(" ", "T")) : NaN;
}

/** epoch ms → PocketBase datetime string. Fixed width, so string order is time order. */
export function toPb(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ");
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

const sameYear = (a: number, b: number) => new Date(a).getFullYear() === new Date(b).getFullYear();

const STYLES = {
  time: { hour: "numeric", minute: "2-digit" },
  dateTime: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  dateTimeYear: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  day: { weekday: "long", month: "long", day: "numeric" },
  dayYear: { weekday: "long", year: "numeric", month: "long", day: "numeric" },
  full: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

const cache = new Map<string, Intl.DateTimeFormat>();

function fmt(style: keyof typeof STYLES, locale: string | undefined, ms: number): string {
  const key = `${locale ?? ""}|${style}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, STYLES[style]);
    cache.set(key, f);
  }
  return f.format(ms);
}

/** Message timestamp: time only for today, date + time otherwise (year only when it differs). */
export function formatTime(ms: number, now = Date.now(), locale?: string): string {
  if (sameDay(ms, now)) return fmt("time", locale, ms);
  return fmt(sameYear(ms, now) ? "dateTime" : "dateTimeYear", locale, ms);
}

/** Date divider label: "Today", "Yesterday", or a weekday + date. */
export function dayLabel(ms: number, now = Date.now(), locale?: string): string {
  if (sameDay(ms, now)) return S.TODAY;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(ms, yesterday.getTime())) return S.YESTERDAY;
  return fmt(sameYear(ms, now) ? "day" : "dayYear", locale, ms);
}

/** Full timestamp for tooltips (e.g. the "(edited)" marker). */
export function formatFull(ms: number, locale?: string): string {
  return fmt("full", locale, ms);
}
