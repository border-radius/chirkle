// Usage statistics (DESIGN.md §40): what GET /api/chat/stats answers, and the figures the page works out from it.
// Pure, so tests/unit can check them.

/** A sample: [time (epoch ms), people online, guests, people on the web, people on Android]. */
export type Sample = [number, number, number, number, number];

export interface Stats {
  at: number;
  /** Recording (samples, activity) is on: site.no_stats isn't ticked. */
  history: boolean;
  sample_minutes: number;
  now: { online: number; guests: number; web: number; android: number };
  /** Accounts online in the last 24 hours, 7 days and 30 days. */
  active: { day: number; week: number; month: number };
  accounts: { total: number; new_week: number; moderators: number; banned: number };
  messages: {
    /** The viewer's days (YYYY-MM-DD) with any messages, the last 30. */
    days: { day: string; messages: number; people: number }[];
    people_week: number;
    people_month: number;
    dms_month: number;
    files_month: number;
    reactions_month: number;
  };
  /** The last 7 days', oldest first. */
  samples: Sample[];
}

export const DAY_MS = 86_400_000;

/** `t`'s day in this browser's time zone, as YYYY-MM-DD. */
export function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Midnight today in this browser's time zone, `back` days before it. */
export function midnight(now: number, back = 0): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** The last `n` days, oldest first, each with its messages and posters (none for a day without). */
export function lastDays(days: Stats["messages"]["days"], now: number, n = 30): { day: string; messages: number; people: number }[] {
  const by = new Map(days.map((d) => [d.day, d]));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = dayKey(midnight(now, i) + 12 * 3_600_000); // noon: safe across a DST change
    const d = by.get(day);
    out.push({ day, messages: d?.messages ?? 0, people: d?.people ?? 0 });
  }
  return out;
}

/** Person-hours online since `from`: each sample stands for its interval. */
export function personHours(samples: readonly Sample[], from: number, minutes: number): number {
  let sum = 0;
  for (const s of samples) if (s[0] >= from) sum += s[1];
  return (sum * minutes) / 60;
}

/** The most people online at once since `from`, and when (the first time it was reached); null without samples. */
export function peak(samples: readonly Sample[], from: number): { online: number; at: number } | null {
  let best: { online: number; at: number } | null = null;
  for (const s of samples) if (s[0] >= from && (!best || s[1] > best.online)) best = { online: s[1], at: s[0] };
  // Nobody at any time: no time to name (it said "0 at 02:45 AM", QA BUG-263).
  return best && !best.online ? { online: 0, at: 0 } : best;
}

/**
 * The samples since `from` as runs of a line: a gap longer than two intervals (the server was down, or recording was
 * off) ends a run, so the chart doesn't draw a line across it.
 */
export function runs(samples: readonly Sample[], from: number, minutes: number): Sample[][] {
  const out: Sample[][] = [];
  let run: Sample[] = [];
  let last = -Infinity;
  for (const s of samples) {
    if (s[0] < from) continue;
    if (s[0] - last > 2 * minutes * 60_000 && run.length) {
      out.push(run);
      run = [];
    }
    run.push(s);
    last = s[0];
  }
  if (run.length) out.push(run);
  return out;
}

/** A tidy top for an axis from 0: 1, 2 or 5 times a power of ten, at least `max` (and at least `min`). */
export function niceMax(max: number, min = 4): number {
  const v = Math.max(max, min);
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** "1.5 h", "40 min", "12 h": person-time for a tile. */
export function formatHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 10) return `${(Math.round(h * 10) / 10).toLocaleString()} h`;
  return `${Math.round(h).toLocaleString()} h`;
}

/** `part` of `whole` as a whole percent ("–" with nothing to divide). */
export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "–";
}
