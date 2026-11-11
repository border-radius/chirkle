import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../../../web/src/dom.ts";
import { CATEGORIES, recentEmoji } from "../../../web/src/lib/emoji.ts";
import { COLS, createEmojiPicker, type EmojiPicker, step } from "../../../web/src/ui/emoji-picker.ts";

describe("step (arrow keys in the picker's grids)", () => {
  // Two grids: 10 emoji (a full row of 8, then 2), then 20 (8, 8, 4).
  const sizes = [10, 20];

  it("left and right go through every emoji, across grids, and stop at the ends", () => {
    expect(step(sizes, { cat: 0, i: 0 }, "left")).toEqual({ cat: 0, i: 0 });
    expect(step(sizes, { cat: 0, i: 9 }, "right")).toEqual({ cat: 1, i: 0 });
    expect(step(sizes, { cat: 1, i: 0 }, "left")).toEqual({ cat: 0, i: 9 });
    expect(step(sizes, { cat: 1, i: 19 }, "right")).toEqual({ cat: 1, i: 19 });
  });

  it("up and down keep the column, into the next grid, or to the end of a shorter row", () => {
    expect(step(sizes, { cat: 0, i: 3 }, "down")).toEqual({ cat: 0, i: 9 }); // row 2 has only 2
    expect(step(sizes, { cat: 0, i: 9 }, "down")).toEqual({ cat: 1, i: 1 });
    expect(step(sizes, { cat: 0, i: 1 }, "down")).toEqual({ cat: 0, i: 9 });
    expect(step(sizes, { cat: 1, i: 5 }, "up")).toEqual({ cat: 0, i: 9 }); // last row of grid 0 ends at 9
    expect(step(sizes, { cat: 1, i: 1 }, "up")).toEqual({ cat: 0, i: 9 });
    expect(step(sizes, { cat: 1, i: 0 }, "up")).toEqual({ cat: 0, i: 8 });
    expect(step(sizes, { cat: 1, i: 12 }, "up")).toEqual({ cat: 1, i: 4 });
    expect(step(sizes, { cat: 1, i: 13 }, "down")).toEqual({ cat: 1, i: 19 });
    expect(step(sizes, { cat: 1, i: 17 }, "down")).toEqual({ cat: 1, i: 17 });
    expect(step(sizes, { cat: 0, i: 2 }, "up")).toEqual({ cat: 0, i: 2 });
    expect(COLS).toBe(8);
  });

  it("skips empty grids", () => {
    expect(step([3, 0, 3], { cat: 0, i: 2 }, "right")).toEqual({ cat: 2, i: 0 });
    expect(step([3, 0, 3], { cat: 2, i: 0 }, "up")).toEqual({ cat: 0, i: 0 });
  });
});

describe("emoji picker (§20.4)", () => {
  let ac: AbortController;
  let picker: EmojiPicker;
  let opener: HTMLButtonElement;
  let elsewhere: HTMLButtonElement;

  beforeEach(() => {
    localStorage.clear();
    // A touch screen: focus goes to the emoji, not the search box (which would bring up the keyboard).
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    ac = new AbortController();
    picker = createEmojiPicker({ signal: ac.signal });
    opener = h("button", { type: "button" }, "☺");
    elsewhere = h("button", { type: "button" }, "elsewhere");
    document.body.append(opener, elsewhere, picker.el);
  });
  afterEach(() => {
    ac.abort();
    document.body.replaceChildren();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  const emojiButton = (e: string) => picker.el.querySelector<HTMLButtonElement>(`button.emoji[data-emoji="${e}"]`)!;
  const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  const search = () => picker.el.querySelector<HTMLInputElement>("input.emoji-search")!;
  const type = (text: string) => {
    search().value = text;
    search().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const shown = () =>
    [...picker.el.querySelectorAll<HTMLButtonElement>("button.emoji")].filter((b) => !b.closest("[hidden]")).map((b) => b.dataset.emoji);
  const tabStops = () => [...picker.el.querySelectorAll<HTMLButtonElement>("button.emoji")].filter((b) => b.tabIndex === 0);

  it("opens as a labelled dialog with every category, focused on the first emoji; picking closes it", () => {
    const onPick = vi.fn();
    picker.open(opener, { label: "Insert emoji", onPick });
    expect(picker.isOpen).toBe(true);
    expect(picker.el.getAttribute("role")).toBe("dialog");
    expect(picker.el.getAttribute("aria-label")).toBe("Insert emoji");
    expect(opener.getAttribute("aria-expanded")).toBe("true");
    expect([...picker.el.querySelectorAll(".emoji-heading")].map((x) => x.textContent)).toEqual(CATEGORIES.map((c) => c.name));
    // Under the room's h1: h3s would skip a level (QA BUG-78, axe heading-order).
    expect(new Set([...picker.el.querySelectorAll(".emoji-heading")].map((x) => x.tagName))).toEqual(new Set(["H2"]));
    expect(document.activeElement).toBe(emojiButton("😀"));
    emojiButton("🎉").click();
    expect(onPick).toHaveBeenCalledWith("🎉");
    expect(picker.isOpen).toBe(false);
    expect(opener.getAttribute("aria-expanded")).toBe("false");
  });

  it("puts recently picked emoji first", () => {
    picker.open(opener, { label: "x", onPick: () => {} });
    emojiButton("🎉").click();
    expect(recentEmoji()).toEqual(["🎉"]);
    picker.open(opener, { label: "x", onPick: () => {} });
    expect(picker.el.querySelector(".emoji-heading")!.textContent).toBe("Recent");
    expect(document.activeElement).toBe(picker.el.querySelector(".emoji-section.recent button.emoji[data-emoji='🎉']"));
  });

  it("shows which ones are chosen; without any to take back, they aren't toggles", () => {
    picker.open(opener, { label: "Add reaction", onPick: () => {}, chosen: new Set(["👍"]) });
    expect(emojiButton("👍").getAttribute("aria-pressed")).toBe("true");
    expect(emojiButton("👎").getAttribute("aria-pressed")).toBe("false");
    picker.close();
    picker.open(opener, { label: "Insert emoji", onPick: () => {} });
    expect(emojiButton("👍").hasAttribute("aria-pressed")).toBe(false);
    expect(emojiButton("👍").classList.contains("on")).toBe(false);
  });

  it("stays open when the window is resized (on Android, the keyboard going away)", () => {
    picker.open(opener, { label: "x", onPick: () => {} });
    window.dispatchEvent(new Event("resize"));
    expect(picker.isOpen).toBe(true);
    opener.remove(); // redrawn: nothing to place it by
    window.dispatchEvent(new Event("resize"));
    expect(picker.isOpen).toBe(true);
  });

  it("the grid is one tab stop; arrow keys move it", () => {
    picker.open(opener, { label: "x", onPick: () => {} });
    expect(tabStops()).toEqual([emojiButton("😀")]);
    key(document.activeElement!, "ArrowRight");
    expect(document.activeElement).toBe(emojiButton("😃"));
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(emojiButton(CATEGORIES[0]!.emoji[1 + COLS]!));
    expect(tabStops()).toEqual([document.activeElement]);
    key(document.activeElement!, "End");
    expect(document.activeElement).toBe(emojiButton(CATEGORIES.at(-1)!.emoji.at(-1)!));
    key(document.activeElement!, "Home");
    expect(document.activeElement).toBe(emojiButton("😀"));
  });

  it("a category tab goes to its first emoji", () => {
    picker.open(opener, { label: "x", onPick: () => {} });
    picker.el.querySelector<HTMLButtonElement>(".emoji-tab[aria-label='Food']")!.click();
    expect(document.activeElement).toBe(emojiButton(CATEGORIES.find((c) => c.name === "Food")!.emoji[0]!));
  });

  it("Escape closes it and gives focus back; so does the opener again", () => {
    picker.open(opener, { label: "x", onPick: () => {} });
    key(document.activeElement!, "Escape");
    expect(picker.isOpen).toBe(false);
    expect(document.activeElement).toBe(opener);

    const restoreFocus = vi.fn();
    picker.open(opener, { label: "x", onPick: () => {}, restoreFocus });
    picker.open(opener, { label: "x", onPick: () => {}, restoreFocus });
    expect(picker.isOpen).toBe(false);
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it("closes when you click or tab anywhere else, leaving focus there", () => {
    const onPick = vi.fn();
    picker.open(opener, { label: "x", onPick });
    elsewhere.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(picker.isOpen).toBe(false);
    picker.open(opener, { label: "x", onPick });
    elsewhere.focus();
    expect(picker.isOpen).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("with a mouse, opens in the search box", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    picker.open(opener, { label: "x", onPick: () => {} });
    expect(document.activeElement).toBe(search());
  });

  it("searching by name shows only what it finds (§20.6), the closest names first; Enter picks the first", () => {
    const onPick = vi.fn();
    picker.open(opener, { label: "Insert emoji", onPick });
    type("fire");
    expect(shown()[0]).toBe("🔥");
    expect(shown()).toContain("🚒"); // fire_engine
    expect(picker.el.querySelector(".emoji-section.found .emoji-heading")!.textContent).toBe("Found");
    type("thumbs up");
    expect(shown()).toEqual(["👍"]);
    type(":heart_eyes:");
    expect(shown()).toEqual(["😍", "😻"]);
    type("qqqq");
    expect(shown()).toEqual([]);
    expect(picker.el.querySelector(".emoji-section.found .emoji-heading")!.textContent).toBe("No emoji found");
    type("tada");
    key(search(), "Enter");
    expect(onPick).toHaveBeenCalledWith("🎉");
    expect(picker.isOpen).toBe(false);
  });

  it("↓ goes from the search box to what it found, ↑ from the top row back; Escape clears, then closes", () => {
    picker.open(opener, { label: "x", onPick: () => {} });
    search().focus();
    type("cat");
    key(search(), "ArrowDown");
    expect(document.activeElement).toBe(picker.el.querySelector(".emoji-section.found button.emoji"));
    expect((document.activeElement as HTMLElement).dataset.emoji).toBe("🐱");
    key(document.activeElement!, "ArrowRight");
    key(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(search());
    key(search(), "Escape");
    expect(search().value).toBe("");
    expect(picker.isOpen).toBe(true);
    expect(shown()).toContain("🍕"); // the categories again
    key(search(), "Escape");
    expect(picker.isOpen).toBe(false);
  });

  it("starts with an empty search box every time; a category tab clears it", () => {
    picker.open(opener, { label: "x", onPick: () => {} });
    type("dog");
    picker.close();
    picker.open(opener, { label: "x", onPick: () => {} });
    expect(search().value).toBe("");
    expect(shown()).toContain("🍕");
    type("dog");
    picker.el.querySelector<HTMLButtonElement>(".emoji-tab[aria-label='Food']")!.click();
    expect(search().value).toBe("");
    expect(document.activeElement).toBe(emojiButton(CATEGORIES.find((c) => c.name === "Food")!.emoji[0]!));
  });

  it("shows each emoji's short name as its tooltip, and marks chosen ones among those found", () => {
    picker.open(opener, { label: "Add reaction", onPick: () => {}, chosen: new Set(["👍"]) });
    expect(emojiButton("👍").title).toBe(":thumbsup:");
    type("thumbsup");
    const found = picker.el.querySelector<HTMLButtonElement>(".emoji-section.found button.emoji")!;
    expect(found.getAttribute("aria-pressed")).toBe("true");
  });
});
