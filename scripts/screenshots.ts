// README screenshots: a throwaway server (as the tests start one) filled with made-up people, rooms and messages, then
// the built app (pb_public/) photographed in Chromium, light and dark, into docs/.
//
//   npm run build && npm run screenshots
//
// Nothing is kept but the images. Fonts come from the machine: Inter (first in the app's font stack) and a color emoji font
// make it look as it does on a phone or a Mac; point FONTCONFIG_FILE at them on a machine without.

import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { disableRateLimits, startPocketBase } from "../tests/support/pocketbase.ts";
import { runSql } from "../tests/support/sql.ts";
import { type Api, createApi } from "../web/src/api.ts";
import { newId } from "../web/src/lib/id.ts";
import { toPb } from "../web/src/lib/time.ts";
import type { Room } from "../web/src/lib/types.ts";
import { createClient } from "../web/src/pb.ts";

const root = resolve(import.meta.dirname, "..");
const OUT = join(root, "docs");
const PASSWORD = "password-123";
const MINUTE = 60_000;

interface Person {
  key: string;
  name: string;
  /** Avatar gradient (two colors and an angle), or none for colored initials. */
  avatar?: [string, string, number];
}

const PEOPLE: Person[] = [
  { key: "alex", name: "Alex Morgan", avatar: ["#7c5cff", "#ff8fb1", 135] },
  { key: "maya", name: "Maya Chen", avatar: ["#ffb347", "#ff5f6d", 160] },
  { key: "leo", name: "Leo Fischer", avatar: ["#43cea2", "#185a9d", 120] },
  { key: "amara", name: "Amara Okafor" },
  { key: "sam", name: "Sam Rivera", avatar: ["#f7971e", "#ffd200", 200] },
  { key: "yuki", name: "Yuki Tanaka" },
  { key: "priya", name: "Priya Nair", avatar: ["#00c6ff", "#0072ff", 140] },
  { key: "jonas", name: "Jonas Berg" },
];

/** One message: who, how many minutes ago, what; `reply` names an earlier message's `tag`. */
interface Line {
  by: string;
  ago: number;
  text: string;
  tag?: string;
  reply?: string;
  image?: boolean;
  reactions?: [emoji: string, who: string[]][];
}

/** The room the screenshot shows. */
const DESIGN: Line[] = [
  { by: "maya", ago: 190, text: "Morning! The new onboarding mocks are up in Figma, would love eyes on them before Thursday" },
  { by: "leo", ago: 186, text: "On it after standup ☕" },
  {
    by: "priya",
    ago: 151,
    text: "Looked through them. The empty states are lovely, the illustrations really carry it",
    reactions: [["💜", ["maya", "sam"]]],
  },
  {
    by: "sam",
    ago: 95,
    tag: "steps",
    text: "One thing: step 3 asks for notifications before people have seen a single message. Can we move it to after the first room?",
  },
  { by: "maya", ago: 88, reply: "steps", text: "Good call, that's the screen where everyone drops off anyway. Moving it." },
  { by: "alex", ago: 44, tag: "ship", text: "Nice work everyone. If the copy review is done by Wednesday we can ship this with 2.4" },
  {
    by: "yuki",
    ago: 39,
    reply: "ship",
    text: "Copy is done, just waiting on the German strings. Tracking here: https://example.com/i18n/onboarding",
  },
  {
    by: "maya",
    ago: 33,
    text: "Updated mocks with Sam's change are in. Last call for comments 🙌",
    reactions: [
      ["👍", ["leo", "sam", "yuki", "alex"]],
      ["🎉", ["priya"]],
    ],
  },
  { by: "leo", ago: 21, text: "Took the dark theme for a spin on my phone last night. Contrast on the composer is much better now" },
  { by: "leo", ago: 20, image: true, text: "" },
  {
    by: "amara",
    ago: 9,
    text: "That gradient 😍",
    reactions: [
      ["🔥", ["maya", "priya", "alex"]],
      ["👀", ["sam"]],
    ],
  },
  { by: "priya", ago: 3, text: "Looks great to me. Ship it!" },
];

const ROOMS: { name: string; visibility?: "open" | "public"; lines: Line[]; unread?: number }[] = [
  {
    name: "general",
    unread: 3,
    lines: [
      { by: "jonas", ago: 300, text: "Reminder: all-hands moved to 3pm today" },
      { by: "amara", ago: 95, text: "Lunch order is going in at 12:15, reply here if you want in" },
      { by: "sam", ago: 30, text: "Anyone else's VPN acting up?" },
      { by: "jonas", ago: 26, text: "Restarting it fixed it for me" },
      { by: "yuki", ago: 8, text: "Welcome aboard, Priya! 👋" },
    ],
  },
  { name: "design", lines: DESIGN },
  {
    name: "release-2.4",
    unread: 7,
    lines: Array.from({ length: 7 }, (_, i) => ({
      by: ["jonas", "leo", "sam"][i % 3]!,
      ago: 70 - i * 9,
      text: [
        "Release branch is cut",
        "CI is green on all three browsers",
        "Changelog draft is up",
        "Staging deploy done",
        "Smoke tests pass on staging",
        "Tagging rc1",
        "Release notes are ready for review",
      ][i]!,
    })),
  },
  {
    name: "announcements",
    visibility: "open",
    lines: [{ by: "alex", ago: 60 * 26, text: "We're hiring! Two frontend roles are open, details on the careers page." }],
  },
  {
    name: "random",
    lines: [
      { by: "amara", ago: 60 * 5, text: "Who took the last oat milk" },
      { by: "leo", ago: 60 * 4, text: "It was like that when I got here" },
    ],
  },
  {
    name: "support",
    unread: 1,
    lines: [{ by: "yuki", ago: 52, text: "Ticket queue is down to zero 🎉" }],
  },
];

/** DMs with Alex, newest last. */
const DMS: { with: string; lines: Line[] }[] = [
  {
    with: "sam",
    lines: [
      { by: "sam", ago: 140, text: "Got a minute later for the roadmap?" },
      { by: "alex", ago: 135, text: "Sure, after 2" },
    ],
  },
  { with: "maya", lines: [{ by: "maya", ago: 20, text: "Sent you the deck" }] },
];

const pb = await startPocketBase({ publicDir: join(root, "pb_public"), fixtureRoute: true });
let browser: Browser | undefined;
try {
  await disableRateLimits(pb.url);
  browser = await chromium.launch();
  const now = Date.now();

  // ---- people
  const apis = new Map<string, Api>();
  const ids = new Map<string, string>();
  for (const p of PEOPLE) {
    const api = createApi(createClient(pb.url));
    const user = await api.signUp({ email: `${p.key}@example.com`, password: PASSWORD, name: p.name });
    if (p.avatar)
      await api.setAvatar(new File([await render(browser, avatarHtml(p.avatar), 256, 256)], `${p.key}.png`, { type: "image/png" }));
    apis.set(p.key, api);
    ids.set(p.key, user.id);
  }
  const as = (key: string) => apis.get(key)!;

  // ---- rooms and messages, with their times set afterwards
  const times: { id: string; at: number }[] = [];
  const reads: { room: string; at: number }[] = [];
  const photo = await render(browser, photoHtml(), 1200, 800);

  async function post(room: Room, lines: Line[]) {
    const tags = new Map<string, string>();
    for (const l of lines) {
      const id = newId();
      const files = l.image ? [new File([photo], "dusk.png", { type: "image/png" })] : undefined;
      const replyTo = l.reply ? tags.get(l.reply) : undefined;
      await as(l.by).send({ id, room: room.id, text: l.text, ...(files ? { files } : {}), ...(replyTo ? { replyTo } : {}) });
      for (const [emoji, who] of l.reactions ?? []) for (const k of who) await as(k).react(id, emoji, true);
      if (l.tag) tags.set(l.tag, id);
      times.push({ id, at: now - l.ago * MINUTE });
    }
  }

  for (const r of ROOMS) {
    const room = await as("alex").createRoom(r.name, r.visibility ?? "public");
    times.push({ id: room.id, at: now - 3 * 24 * 60 * MINUTE });
    await post(room, r.lines);
    // Alex has read all but the last `unread` messages of other people.
    const last = r.lines.length - (r.unread ?? 0) - 1;
    reads.push({ room: room.id, at: last >= 0 ? now - r.lines[last]!.ago * MINUTE : now - 4 * 24 * 60 * MINUTE });
  }
  for (const dm of DMS) {
    const room = await as("alex").openDm(ids.get(dm.with)!);
    await post(room, dm.lines);
    reads.push({ room: room.id, at: now });
  }

  const alex = ids.get("alex")!;
  await runSql(pb.url, [
    { sql: "UPDATE users SET created = {:at}, updated = {:at}", params: { at: toPb(now - 7 * 24 * 60 * MINUTE) } },
    ...times.map(({ id, at }) => ({
      sql: "UPDATE messages SET created = {:at}, updated = {:at} WHERE id = {:id}",
      params: { id, at: toPb(at) },
    })),
    ...times.map(({ id, at }) => ({
      sql: "UPDATE rooms SET created = {:at}, updated = {:at} WHERE id = {:id}",
      params: { id, at: toPb(at) },
    })),
    { sql: "UPDATE rooms SET last_message_at = COALESCE((SELECT MAX(created) FROM messages m WHERE m.room = rooms.id), created)" },
    { sql: "DELETE FROM room_reads WHERE user = {:me}", params: { me: alex } },
    ...reads.map(({ room, at }) => ({
      sql: "INSERT INTO room_reads (id, user, room, last_read_at) VALUES ({:id}, {:me}, {:room}, {:at})",
      params: { id: newId(), me: alex, room, at: toPb(at) },
    })),
  ]);

  // ---- Alex's collections, the photo saved to one so the sidebar shows a count
  const json = { "content-type": "application/json" };
  const auth = await fetch(`${pb.url}/api/collections/users/auth-with-password`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ identity: "alex@example.com", password: PASSWORD }),
  });
  const asAlex = { ...json, authorization: ((await auth.json()) as { token: string }).token };
  const shot = await fetch(`${pb.url}/api/collections/messages/records?perPage=1&filter=${encodeURIComponent("files ~ 'dusk'")}`, {
    headers: asAlex,
  });
  const [withPhoto] = ((await shot.json()) as { items: { id: string; files: string[] }[] }).items;
  for (const [name, isPublic] of [
    ["Moodboard", false],
    ["Screenshots", true],
    ["Brand assets", true],
  ] as const) {
    const res = await fetch(`${pb.url}/api/collections/collections/records`, {
      method: "POST",
      headers: asAlex,
      body: JSON.stringify({ owner: alex, name, public: isPublic }),
    });
    const { id } = (await res.json()) as { id: string };
    if (!res.ok) throw new Error(`collection ${name}: ${res.status} ${JSON.stringify({ id })}`);
    if (name !== "Moodboard") continue;
    if (!withPhoto) throw new Error("no message with the photo to save");
    const saved = await fetch(`${pb.url}/api/chat/items`, {
      method: "POST",
      headers: asAlex,
      body: JSON.stringify({ collection: id, message: withPhoto.id, file: withPhoto.files[0] }),
    });
    if (!saved.ok) throw new Error(`saving the photo: ${saved.status} ${await saved.text()}`);
  }

  // ---- photographs
  await mkdir(OUT, { recursive: true });
  const design = (await as("alex").listRooms()).find((r) => r.name === "design")!;
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: scheme,
      serviceWorkers: "block",
      locale: "en-US",
      timezoneId: afternoon(),
    });
    const page = await ctx.newPage();
    await page.goto(`${pb.url}/login`);
    await page.getByLabel("Email").fill("alex@example.com");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.waitForURL((u) => u.pathname === "/");
    await page.goto(`${pb.url}/r/${design.id}`);
    await page.getByText("Looks great to me. Ship it!").waitFor();
    await page.locator("img[src*='dusk']").first().waitFor();
    await page.waitForLoadState("networkidle");
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(OUT, `screenshot-${scheme}.png`) });
    await ctx.close();
    console.log(`docs/screenshot-${scheme}.png`);
  }
} finally {
  await browser?.close();
  await pb.stop();
}

/** A time zone where it is mid-afternoon now, so the messages' times read as a working day. */
function afternoon(): string {
  const zones = [
    "Pacific/Honolulu",
    "America/Los_Angeles",
    "America/Chicago",
    "America/New_York",
    "America/Sao_Paulo",
    "Atlantic/Azores",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Athens",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Bangkok",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Australia/Sydney",
    "Pacific/Auckland",
  ];
  const hour = (tz: string) =>
    Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date()));
  return zones.reduce((a, b) => (Math.abs(hour(b) - 15) < Math.abs(hour(a) - 15) ? b : a));
}

/** A PNG of `html` at w×h. */
async function render(b: Browser, html: string, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  const page = await b.newPage({ viewport: { width: w, height: h } });
  try {
    await page.setContent(html);
    return new Uint8Array(await page.screenshot());
  } finally {
    await page.close();
  }
}

function avatarHtml([a, b, angle]: [string, string, number]): string {
  return `<body style="margin:0;width:256px;height:256px;background:linear-gradient(${angle}deg,${a},${b});overflow:hidden">
<div style="position:absolute;left:78px;top:46px;width:100px;height:100px;border-radius:50%;background:rgb(255 255 255/.85)"></div>
<div style="position:absolute;left:28px;top:160px;width:200px;height:180px;border-radius:50%;background:rgb(255 255 255/.85)"></div></body>`;
}

/** A made-up dusk landscape, standing in for a photo. */
function photoHtml(): string {
  return `<body style="margin:0"><svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b1055"/><stop offset=".55" stop-color="#d4418e"/><stop offset="1" stop-color="#ffb36b"/></linearGradient>
  <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff6d5"/><stop offset=".6" stop-color="#ffd38a"/><stop offset="1" stop-color="#ffd38a" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1200" height="800" fill="url(#sky)"/>
<circle cx="760" cy="470" r="170" fill="url(#sun)"/>
<path d="M0 560 L180 400 L320 500 L470 330 L640 520 L780 420 L940 540 L1080 380 L1200 470 V800 H0Z" fill="#5b2a6e"/>
<path d="M0 640 L150 540 L300 610 L460 500 L620 630 L800 540 L980 650 L1200 560 V800 H0Z" fill="#3a1a52"/>
<path d="M0 720 L200 650 L420 710 L640 640 L860 720 L1060 660 L1200 700 V800 H0Z" fill="#1f0f33"/>
</svg></body>`;
}
