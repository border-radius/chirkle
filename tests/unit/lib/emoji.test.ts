import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATEGORIES, EMOJI, RECENT_MAX, recentEmoji, rememberEmoji } from "../../../web/src/lib/emoji.ts";
import { emojiNamed, findEmoji, NAMES, namedEmoji } from "../../../web/src/lib/emoji-names.ts";

/** pb_hooks/lib/emoji.js's set: its EMOJI lines, read as text (the file runs in PocketBase, not here). */
function serverEmoji(): string[] {
  const src = readFileSync("pb_hooks/lib/emoji.js", "utf8");
  const block = /const EMOJI = \[([\s\S]*?)\]\.join/.exec(src)![1]!;
  return [...block.matchAll(/"([^"]*)"/g)].flatMap((m) => m[1]!.split(" "));
}

describe("emoji (§20.1, §20.4)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("the server allows exactly the emoji the picker offers (pb_hooks/lib/emoji.js)", () => {
    expect(serverEmoji()).toEqual(CATEGORIES.flatMap((c) => c.emoji));
  });

  it("each of Telegram's reaction emoji is one of the picker's or has the nearest of them (pb_hooks/telegram/reactions.js, lib/emoji.js)", () => {
    const src = readFileSync("pb_hooks/telegram/reactions.js", "utf8");
    const lib = readFileSync("pb_hooks/lib/emoji.js", "utf8");
    const telegram = [.../const TELEGRAM = new Set\(([\s\S]*?)\.split/.exec(src)![1]!.matchAll(/"([^"]*)"/g)].flatMap((m) =>
      m[1]!.split(" ").filter(Boolean),
    );
    const similar = new Map(
      [.../const SIMILAR = new Map\(\[([\s\S]*?)\]\);/.exec(lib)![1]!.matchAll(/\["([^"]+)", "([^"]+)"\]/g)].map((m) => [m[1]!, m[2]!]),
    );
    const picker = new Set(serverEmoji());
    expect(telegram.length).toBeGreaterThan(70);
    for (const to of similar.values()) expect(picker.has(to), to).toBe(true);
    for (const e of telegram) {
      const bare = e.replace(/\u200D[♂♀]$/, "");
      expect([e, bare, `${bare}\uFE0F`].some((x) => picker.has(x)) || similar.has(e), e).toBe(true);
    }
  });

  it("every emoji is offered once, as a single character on screen", () => {
    const all = CATEGORIES.flatMap((c) => c.emoji);
    expect(all.length).toBe(EMOJI.size);
    const graphemes = new Intl.Segmenter();
    for (const e of all) expect([...graphemes.segment(e)], e).toHaveLength(1);
  });

  it("remembers recently used emoji, newest first, without repeats, up to RECENT_MAX", () => {
    expect(recentEmoji()).toEqual([]);
    rememberEmoji("👍");
    rememberEmoji("🎉");
    rememberEmoji("👍");
    expect(recentEmoji()).toEqual(["👍", "🎉"]);
    for (const e of CATEGORIES[0]!.emoji.slice(0, RECENT_MAX + 5)) rememberEmoji(e);
    expect(recentEmoji()).toHaveLength(RECENT_MAX);
    expect(recentEmoji()[0]).toBe(CATEGORIES[0]!.emoji[RECENT_MAX + 4]);
  });

  it("ignores what isn't a picker emoji, and works without storage", () => {
    rememberEmoji("x");
    expect(recentEmoji()).toEqual([]);
    localStorage.setItem("chat.recentEmoji", JSON.stringify(["👍", 3, "<b>", "🎉"]));
    expect(recentEmoji()).toEqual(["👍", "🎉"]);
    localStorage.setItem("chat.recentEmoji", "{not json");
    expect(recentEmoji()).toEqual([]);
    localStorage.clear();
    // e.g. a private window, or site data blocked: every access throws
    const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => rememberEmoji("👍")).not.toThrow();
    expect(recentEmoji()).toEqual([]);
    blocked.mockRestore();
    expect(recentEmoji()).toEqual([]);
  });
});

describe("emoji names (§20.6)", () => {
  it("name every picker emoji once, in the picker's order", () => {
    expect(namedEmoji().map((n) => n.emoji)).toEqual(CATEGORIES.flatMap((c) => c.emoji));
  });

  it("short names are unique and can be typed as :name: (letters, digits, _ + -)", () => {
    const names = namedEmoji().map((n) => n.name);
    expect(new Set(names).size).toBe(names.length);
    for (const line of NAMES.split("\n")) expect(line, line).toMatch(/^\S+( [a-z0-9_+-]+)+$/);
  });

  it("finds by the beginnings of words, exact names first, then names beginning so, then the rest", () => {
    expect(findEmoji("fire")[0]!.emoji).toBe("🔥");
    expect(findEmoji("heart")[0]!.emoji).toBe("❤️");
    expect(
      findEmoji("fir")
        .map((n) => n.emoji)
        .slice(0, 2),
    ).toEqual(["🔥", "🎆"]); // fire, then fireworks (shorter than fire_engine)
    expect(findEmoji("heart_e")[0]!.emoji).toBe("😍");
    expect(findEmoji("eyes").map((n) => n.emoji)).toContain("😍"); // a part of heart_eyes
    expect(findEmoji("Thumbs UP").map((n) => n.emoji)).toEqual(["👍"]);
    expect(findEmoji("+1").map((n) => n.emoji)).toEqual(["👍"]);
    expect(findEmoji("smile", 3)).toHaveLength(3);
    expect(findEmoji("  ")).toEqual([]);
    expect(findEmoji("zzzzz")).toEqual([]);
  });

  it("looks up an exact short name, in any case", () => {
    expect(emojiNamed("tada")).toBe("🎉");
    expect(emojiNamed("TADA")).toBe("🎉");
    expect(emojiNamed("tad")).toBeUndefined();
    expect(EMOJI.has(emojiNamed("rainbow_flag")!)).toBe(true);
  });
});
