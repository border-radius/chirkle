// The usage statistics page (DESIGN.md §40), /stats: a page of its own (stats.html), not the app's. It asks
// GET /api/chat/stats with the session this browser has: the app's (a moderator), else the admin UI's (a superuser,
// signed in at /_/ on this server). Anyone else is told there is no such page. Counts only; refreshed every 30 s
// while the tab is visible.

import { type Child, clear, h } from "../dom.ts";
import { applyTheme, savedTheme } from "../theme.ts";
import { DAY_MS, formatHours, lastDays, midnight, niceMax, peak, percent, personHours, runs, type Sample, type Stats } from "./data.ts";

const REFRESH_MS = 30_000;
/** The app's session (web/src/pb.ts), and PocketBase's admin UI's (0.40: "__pb_superusers__" + its base path). */
const SESSIONS = ["pocketbase_auth", "__pb_superusers__/_"];
const SVG = "http://www.w3.org/2000/svg";

const root = document.getElementById("stats") as HTMLElement;
const updated = document.getElementById("stats-updated") as HTMLElement;
const num = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTime = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const shortDay = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

let range: "day" | "week" = "day";
let last: Stats | null = null;
let refocus = false;

function tokens(): string[] {
  const out: string[] = [];
  for (const key of SESSIONS) {
    try {
      const token = JSON.parse(localStorage.getItem(key) || "{}")?.token;
      if (typeof token === "string" && token) out.push(token);
    } catch {}
  }
  return out;
}

/** The statistics, with the first session that may see them; "denied" when none may; null when it failed. */
async function load(): Promise<Stats | "denied" | null> {
  const tz = -new Date().getTimezoneOffset();
  for (const token of tokens()) {
    try {
      const res = await fetch(`/api/chat/stats?tz=${tz}`, { headers: { Authorization: token } });
      if (res.ok) return (await res.json()) as Stats;
      if (res.status !== 401 && res.status !== 403) return null;
    } catch {
      return null;
    }
  }
  return "denied";
}

// ---- pieces ----

function tile(label: string, value: string, note?: string, big = false): HTMLElement {
  return h("div", { class: big ? "tile big" : "tile" }, [
    h("div", { class: "tile-label" }, label),
    h("div", { class: "tile-value" }, value),
    note ? h("div", { class: "tile-note" }, note) : null,
  ]);
}

function section(title: string, children: Child[], hint?: string): HTMLElement {
  return h("section", { class: "card" }, [h("h2", {}, title), hint ? h("p", { class: "hint" }, hint) : null, ...children]);
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A table of the chart's numbers, folded away: the values without hovering. */
function table(caption: string, head: string[], rows: (string | number)[][]): HTMLElement {
  return h("details", { class: "chart-table" }, [
    h("summary", {}, "Show as a table"),
    h("table", {}, [
      h("caption", {}, caption),
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          head.map((c) => h("th", { scope: "col" }, c)),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map((r) =>
          h(
            "tr",
            {},
            r.map((c, i) => (i ? h("td", {}, typeof c === "number" ? num.format(c) : c) : h("th", { scope: "row" }, String(c)))),
          ),
        ),
      ),
    ]),
  ]);
}

// The charts are drawn at their box's own width (set by render), so their text stays its size on a phone.
let W = 720;
let H = 220;
/** Narrow: fewer labels along the bottom. */
const narrow = () => W < 520;
const PAD = { top: 12, right: 12, bottom: 26, left: 36 };

/** Gridlines and y labels at 0, half (when a whole number) and the top. */
function yAxis(g: SVGGElement, top: number) {
  for (const v of [0, top / 2, top].filter(Number.isInteger)) {
    const y = PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / top);
    g.append(svg("line", { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, class: "grid" }));
    const t = svg("text", { x: PAD.left - 6, y: y + 4, "text-anchor": "end", class: "axis" });
    t.textContent = num.format(v);
    g.append(t);
  }
}

/** A label along the bottom at `x`; near an edge it is anchored inward, so it isn't cut off. */
function xLabel(g: SVGGElement, x: number, text: string) {
  const anchor = x > W - PAD.right - 32 ? "end" : x < PAD.left + 32 ? "start" : "middle";
  const t = svg("text", { x: anchor === "end" ? Math.min(x + 6, W - 2) : x, y: H - 8, "text-anchor": anchor, class: "axis" });
  t.textContent = text;
  g.append(t);
}

/** The tooltip of a chart, placed over its box at `x` (0..1 of the width). */
function tooltip(box: HTMLElement) {
  const tip = h("div", { class: "tip", role: "status", hidden: true });
  box.append(tip);
  return {
    show(x: number, lines: [string, string][], title: string) {
      clear(tip);
      tip.append(h("div", { class: "tip-title" }, title));
      for (const [value, label] of lines) tip.append(h("div", {}, [h("strong", {}, value), ` ${label}`]));
      tip.hidden = false;
      const left = Math.min(Math.max(x * box.clientWidth, tip.offsetWidth / 2 + 4), box.clientWidth - tip.offsetWidth / 2 - 4);
      tip.style.left = `${left}px`;
    },
    hide() {
      tip.hidden = true;
    },
  };
}

/** People online over the last 24 hours or 7 days: a line with a light area under it, and a crosshair. */
function onlineChart(s: Stats): HTMLElement {
  const now = s.at;
  const from = now - (range === "day" ? DAY_MS : 7 * DAY_MS);
  const parts = runs(s.samples, from, s.sample_minutes);
  const shown = parts.flat();
  const top = niceMax(Math.max(0, ...shown.map((x) => x[1])));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xOf = (t: number) => PAD.left + ((t - from) / (now - from)) * plotW;
  const yOf = (v: number) => PAD.top + plotH * (1 - v / top);

  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  chart.setAttribute("aria-label", `People online over the last ${range === "day" ? "24 hours" : "7 days"}`);
  const g = svg("g");
  chart.append(g);
  yAxis(g, top);
  // x labels: every 6 hours, or each day at midnight.
  const ticks: number[] = [];
  if (range === "day") {
    const first = Math.ceil(from / (6 * 3_600_000)) * 6 * 3_600_000;
    for (let t = first; t <= now; t += 6 * 3_600_000) ticks.push(t);
  } else {
    for (let i = 6; i >= 0; i--) if (!narrow() || i % 2 === 0) ticks.push(midnight(now, i));
  }
  for (const t of ticks) {
    // A tick at either edge goes unlabeled: its label would run off or into the next.
    if (t < from || xOf(t) > W - PAD.right - 28) continue;
    xLabel(g, xOf(t), range === "day" ? time.format(t) : shortDay.format(t));
  }
  const base = yOf(0);
  for (const run of parts) {
    const pts = run.map((x) => `${xOf(x[0]).toFixed(1)},${yOf(x[1]).toFixed(1)}`);
    if (run.length === 1) {
      g.append(svg("circle", { cx: xOf(run[0]![0]), cy: yOf(run[0]![1]), r: 3, class: "dot" }));
      continue;
    }
    g.append(svg("polygon", { points: `${xOf(run[0]![0])},${base} ${pts.join(" ")} ${xOf(run.at(-1)![0])},${base}`, class: "area" }));
    g.append(svg("polyline", { points: pts.join(" "), class: "line" }));
  }
  const cross = svg("line", { y1: PAD.top, y2: base, class: "cross", visibility: "hidden" });
  const mark = svg("circle", { r: 4.5, class: "mark", visibility: "hidden" });
  g.append(cross, mark);

  const box = h("div", { class: "chart-box" }, [chart]);
  if (!shown.length) box.append(h("p", { class: "empty" }, s.history ? "No samples yet: one is taken every 5 minutes." : "Not recorded."));
  const tip = tooltip(box);
  const nearest = (clientX: number): Sample | null => {
    const r = chart.getBoundingClientRect();
    const t = from + ((((clientX - r.left) / r.width) * W - PAD.left) / plotW) * (now - from);
    let best: Sample | null = null;
    for (const x of shown) if (!best || Math.abs(x[0] - t) < Math.abs(best[0] - t)) best = x;
    return best;
  };
  const show = (x: Sample | null) => {
    if (!x) return;
    const cx = xOf(x[0]);
    for (const el of [cross, mark]) el.setAttribute("visibility", "visible");
    cross.setAttribute("x1", String(cx));
    cross.setAttribute("x2", String(cx));
    mark.setAttribute("cx", String(cx));
    mark.setAttribute("cy", String(yOf(x[1])));
    tip.show(
      cx / W,
      [
        [num.format(x[1]), "people online"],
        [num.format(x[3]), "on the web"],
        [num.format(x[4]), "on Android"],
        [num.format(x[2]), "guests"],
      ],
      (range === "day" ? time : dayTime).format(x[0]),
    );
  };
  const hide = () => {
    for (const el of [cross, mark]) el.setAttribute("visibility", "hidden");
    tip.hide();
  };
  chart.addEventListener("pointermove", (e) => show(nearest(e.clientX)));
  chart.addEventListener("pointerleave", hide);
  // Keys: the chart takes focus, and ← → step through the samples.
  let at = shown.length - 1;
  chart.setAttribute("tabindex", "0");
  chart.addEventListener("focus", () => show(shown[at] ?? null));
  chart.addEventListener("blur", hide);
  chart.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    at = Math.max(0, Math.min(shown.length - 1, at + (e.key === "ArrowLeft" ? -1 : 1)));
    show(shown[at] ?? null);
  });

  // The table: hourly in the last 24 hours, else daily peaks.
  const rows: (string | number)[][] = [];
  if (range === "day") {
    for (let t = Math.floor(from / 3_600_000) * 3_600_000; t <= now; t += 3_600_000) {
      const p = peak(
        shown.filter((x) => x[0] < t + 3_600_000),
        t,
      );
      if (p) rows.push([time.format(t), p.online]);
    }
  } else {
    for (let i = 6; i >= 0; i--) {
      const start = midnight(now, i);
      const p = peak(
        shown.filter((x) => x[0] < start + DAY_MS),
        start,
      );
      if (p) rows.push([dayName.format(start), p.online]);
    }
  }

  const picker = h("div", { class: "seg", role: "group", "aria-label": "Range" }, [
    rangeButton("day", "24 hours"),
    rangeButton("week", "7 days"),
  ]);
  return h("div", {}, [
    picker,
    box,
    table(
      range === "day" ? "Most people online, by hour" : "Most people online, by day",
      [range === "day" ? "Hour" : "Day", "People"],
      rows,
    ),
  ]);
}

function rangeButton(value: typeof range, label: string): HTMLElement {
  return h(
    "button",
    {
      type: "button",
      "aria-pressed": String(range === value),
      on: {
        click: () => {
          range = value;
          refocus = true;
          if (last) render(last);
        },
      },
    },
    label,
  );
}

/** Messages per day, the last 30 days: columns, each with its tooltip. */
function messagesChart(s: Stats): HTMLElement {
  const days = lastDays(s.messages.days, s.at);
  const top = niceMax(Math.max(0, ...days.map((d) => d.messages)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / days.length;
  const bw = Math.min(16, slot - 2);
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img" });
  chart.setAttribute("aria-label", "Messages per day, the last 30 days");
  const g = svg("g");
  chart.append(g);
  yAxis(g, top);
  const box = h("div", { class: "chart-box" }, [chart]);
  const tip = tooltip(box);
  days.forEach((d, i) => {
    const x = PAD.left + i * slot + (slot - bw) / 2;
    const bh = (d.messages / top) * plotH;
    const y = PAD.top + plotH - bh;
    const r = Math.min(4, bw / 2, bh);
    // A column, rounded at the top, square at the baseline.
    if (bh > 0) {
      g.append(
        svg("path", {
          d: `M${x},${y + bh}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${y + bh}Z`,
          class: "bar",
        }),
      );
    }
    const date = new Date(`${d.day}T12:00:00`);
    const every = narrow() ? 10 : 5;
    if (i % every === every - 1 || i === days.length - 1) {
      xLabel(g, x + bw / 2, i === days.length - 1 ? "Today" : shortDay.format(date));
    }
    // The hit target: the whole slot, top to bottom.
    const hit = svg("rect", { x: PAD.left + i * slot, y: PAD.top, width: slot, height: plotH, class: "hit" });
    const show = () =>
      tip.show(
        (x + bw / 2) / W,
        [
          [num.format(d.messages), d.messages === 1 ? "message" : "messages"],
          [num.format(d.people), d.people === 1 ? "person posted" : "people posted"],
        ],
        dayName.format(date),
      );
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerleave", () => tip.hide());
    g.append(hit);
  });
  return h("div", {}, [
    box,
    table(
      "Messages per day",
      ["Day", "Messages", "People who posted"],
      days.map((d) => [dayName.format(new Date(`${d.day}T12:00:00`)), d.messages, d.people]),
    ),
  ]);
}

// ---- the page ----

function render(s: Stats) {
  last = s;
  // The card's inner width: the page's, less its padding and the card's.
  W = Math.round(Math.min(928, Math.max(280, root.clientWidth - 66)));
  H = narrow() ? 180 : 220;
  const now = s.at;
  const today = midnight(now);
  const days = lastDays(s.messages.days, now);
  const sum = (n: number) => days.slice(-n).reduce((a, d) => a + d.messages, 0);
  const month = sum(30);
  const peakToday = peak(s.samples, today);
  const peakWeek = peak(s.samples, now - 7 * DAY_MS);
  const hoursToday = personHours(s.samples, today, s.sample_minutes);
  const hoursWeek = personHours(s.samples, now - 7 * DAY_MS, s.sample_minutes);
  const recorded = (v: string) => (s.history || s.samples.length ? v : "–");

  const sections = [
    !s.history
      ? h(
          "p",
          { class: "notice", role: "note" },
          "Recording is off (site settings: no_stats). Live numbers and messages are still shown; what was recorded before is dropped as it ages.",
        )
      : null,
    section("Now", [
      h("div", { class: "tiles" }, [
        tile("People online", num.format(s.now.online), undefined, true),
        tile("On the web", num.format(s.now.web)),
        tile("On Android", num.format(s.now.android)),
        tile("Guests", num.format(s.now.guests), "open tabs, not signed in"),
        tile(
          "Peak today",
          recorded(peakToday ? num.format(peakToday.online) : "–"),
          peakToday ? `at ${time.format(peakToday.at)}` : undefined,
        ),
        tile("Peak, 7 days", recorded(peakWeek ? num.format(peakWeek.online) : "–"), peakWeek ? dayTime.format(peakWeek.at) : undefined),
      ]),
    ]),
    section(
      "Usage",
      [
        h("div", { class: "tiles" }, [
          tile("Active, 24 hours", num.format(s.active.day), `${percent(s.active.day, s.accounts.total)} of accounts`),
          tile("Active, 7 days", num.format(s.active.week), `${percent(s.active.week, s.accounts.total)} of accounts`),
          tile("Active, 30 days", num.format(s.active.month), `${percent(s.active.month, s.accounts.total)} of accounts`),
          tile("Time online today", recorded(formatHours(hoursToday)), "all people together"),
          tile("Time online, 7 days", recorded(formatHours(hoursWeek)), "all people together"),
          tile("Per active person", recorded(s.active.week ? formatHours(hoursWeek / s.active.week) : "–"), "a week, on average"),
        ]),
        h("h3", {}, "People online"),
        onlineChart(s),
      ],
      "Active: online at least once. Time online is counted every 5 minutes.",
    ),
    section("Messages", [
      h("div", { class: "tiles" }, [
        tile("Today", num.format(days.at(-1)?.messages ?? 0)),
        tile("7 days", num.format(sum(7)), `${num.format(s.messages.people_week)} people posted`),
        tile("30 days", num.format(month), `${num.format(s.messages.people_month)} people posted`),
        tile("In DMs", percent(s.messages.dms_month, month), "of the 30 days'"),
        tile("Files sent", num.format(s.messages.files_month), "30 days"),
        tile("Reactions", num.format(s.messages.reactions_month), "on the 30 days' messages"),
      ]),
      h("h3", {}, "Messages per day"),
      messagesChart(s),
    ]),
    section("Accounts", [
      h("div", { class: "tiles" }, [
        tile("Accounts", num.format(s.accounts.total)),
        tile("New, 7 days", num.format(s.accounts.new_week)),
        tile("Moderators", num.format(s.accounts.moderators)),
        tile("Banned", num.format(s.accounts.banned)),
      ]),
    ]),
  ];
  // Keep the open tables open across a refresh.
  const open = [...root.querySelectorAll("details")].map((d) => d.open);
  clear(root);
  for (const el of sections) if (el) root.append(el);
  root.querySelectorAll("details").forEach((d, i) => {
    d.open = !!open[i];
  });
  // A range button was pressed: it is a new one now, focused as the old one was.
  if (refocus) root.querySelector<HTMLElement>(".seg [aria-pressed='true']")?.focus();
  refocus = false;
  updated.textContent = `Updated ${new Date(now).toLocaleTimeString()}`;
}

function denied() {
  document.title = "Page not found";
  clear(root);
  root.append(
    h("section", { class: "card missing" }, [
      h("h2", {}, "Page not found"),
      h("p", {}, "There is no such page, or you can't see it."),
      h("a", { href: "/" }, "Back to the app"),
    ]),
  );
  updated.textContent = "";
}

let timer = 0;
async function refresh() {
  clearTimeout(timer);
  const got = await load();
  if (got === "denied") return denied();
  if (got) render(got);
  else updated.textContent = last ? `Couldn't refresh: showing ${new Date(last.at).toLocaleTimeString()}` : "Couldn't load. Retrying…";
  if (!document.hidden) timer = window.setTimeout(refresh, REFRESH_MS);
}

applyTheme(savedTheme());
let drawnFor = root.clientWidth;
let resizing = 0;
addEventListener("resize", () => {
  clearTimeout(resizing);
  resizing = window.setTimeout(() => {
    if (!last || Math.abs(root.clientWidth - drawnFor) < 8) return;
    drawnFor = root.clientWidth;
    render(last);
  }, 150);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
  else clearTimeout(timer);
});
void refresh();
