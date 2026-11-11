import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { h } from "../../../web/src/dom.ts";
import { recentEmoji } from "../../../web/src/lib/emoji.ts";
import { createEmojiSuggest, type EmojiSuggest, emojiToken, SUGGEST_MAX } from "../../../web/src/ui/emoji-suggest.ts";

describe("emojiToken (§20.6)", () => {
  const at = (text: string) => emojiToken(text, text.length);

  it("is ':' and two or more name characters before the caret, at the start or after a space or '('", () => {
    expect(at(":th")).toEqual({ start: 0, query: "th" });
    expect(at("so :Fire")).toEqual({ start: 3, query: "fire" });
    expect(at("(:+1")).toEqual({ start: 1, query: "+1" });
    expect(emojiToken(":tada more", 5)).toEqual({ start: 0, query: "tada" });
  });

  it("isn't a time, a link, a smiley or a single letter", () => {
    for (const t of ["12:30", "http://x", "a:bc", ":)", ":D", ":t", ":ta ", ""]) expect(at(t), t).toBeNull();
  });
});

describe("emoji suggestions in the composer (§20.6)", () => {
  let ac: AbortController;
  let textarea: HTMLTextAreaElement;
  let suggest: EmojiSuggest;
  /** The composer's own keys: Enter sends. */
  let sent: ReturnType<typeof vi.fn<() => void>>;
  let inputs: number;

  beforeEach(() => {
    localStorage.clear();
    ac = new AbortController();
    textarea = h("textarea", { id: "c-text" });
    sent = vi.fn<() => void>();
    inputs = 0;
    textarea.addEventListener("keydown", (e) => e.key === "Enter" && sent());
    textarea.addEventListener("input", () => inputs++);
    document.body.append(h("form", {}, [h("div", { class: "composer-row" }, [textarea])]));
    suggest = createEmojiSuggest({ textarea, signal: ac.signal });
    textarea.focus();
  });
  afterEach(() => {
    ac.abort();
    document.body.replaceChildren();
    localStorage.clear();
  });

  /** Typed at the caret. (happy-dom's setRangeText "end" puts the caret at the end of the whole text.) */
  function typeText(text: string) {
    const { value, selectionStart: from, selectionEnd: to } = textarea;
    textarea.value = value.slice(0, from) + text + value.slice(to);
    textarea.setSelectionRange(from + text.length, from + text.length);
    textarea.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
  }
  const key = (k: string, init: KeyboardEventInit = {}) =>
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  const options = () => [...suggest.el.querySelectorAll<HTMLElement>("[role=option]")];
  const selected = () => suggest.el.querySelector<HTMLElement>("[aria-selected=true]");

  it("offers emoji by name as you type, the first chosen, and links the list to the textarea", () => {
    typeText("hi :f");
    expect(suggest.isOpen).toBe(false);
    typeText("ir");
    expect(suggest.isOpen).toBe(true);
    expect(suggest.el.getAttribute("role")).toBe("listbox");
    expect(options()[0]!.textContent).toBe("🔥:fire:");
    expect(options()[0]!.getAttribute("aria-label")).toBe("🔥 fire");
    expect(options().length).toBeLessThanOrEqual(SUGGEST_MAX);
    expect(textarea.getAttribute("aria-controls")).toBe(suggest.el.id);
    expect(textarea.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    typeText("x");
    expect(suggest.isOpen).toBe(false); // nothing is called "firx"
  });

  it("↑/↓ choose (round the list), Enter puts it in place of :name with a space after; the composer doesn't send", () => {
    typeText("so :fire");
    key("ArrowDown");
    expect(selected()).toBe(options()[1]);
    key("ArrowUp");
    key("ArrowUp");
    expect(selected()).toBe(options().at(-1));
    key("ArrowDown");
    key("Enter");
    expect(sent).not.toHaveBeenCalled();
    expect(textarea.value).toBe("so 🔥 ");
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(suggest.isOpen).toBe(false);
    expect(textarea.hasAttribute("aria-activedescendant")).toBe(false);
    expect(recentEmoji()).toEqual(["🔥"]);
    key("Enter");
    expect(sent).toHaveBeenCalledOnce();
  });

  it("Tab and a click pick too; in the middle of the text, no space is added", () => {
    typeText(":tad");
    key("Tab");
    expect(textarea.value).toBe("🎉 ");
    textarea.value = "a  b";
    textarea.setSelectionRange(2, 2);
    typeText(":rainb");
    const before = inputs;
    options()[0]!.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    options()[0]!.click();
    expect(textarea.value).toBe("a 🌈 b");
    expect(inputs).toBe(before + 1); // so the composer counts and keeps the draft
  });

  it("a whole :name: becomes its emoji as the second colon is typed; unknown names stay", () => {
    typeText("nice :tada");
    typeText(":");
    expect(textarea.value).toBe("nice 🎉");
    typeText(" :nope:");
    expect(textarea.value).toBe("nice 🎉 :nope:");
    // Not when the caret just comes back to one (pasted, say).
    textarea.value = "see :fire: there";
    textarea.setSelectionRange(10, 10);
    textarea.dispatchEvent(new Event("click"));
    expect(textarea.value).toBe("see :fire: there");
  });

  it("Escape closes it until another :name is typed; it closes when the textarea loses focus", () => {
    typeText(":smi");
    key("Escape");
    expect(suggest.isOpen).toBe(false);
    typeText("l");
    expect(suggest.isOpen).toBe(false);
    typeText(" :smi");
    expect(suggest.isOpen).toBe(true);
    textarea.blur();
    expect(suggest.isOpen).toBe(false);
  });

  it("leaves keys alone while closed, and while typing with an input method", () => {
    typeText(":fir");
    key("Enter", { isComposing: true });
    expect(sent).toHaveBeenCalledOnce();
    suggest.close();
    key("ArrowDown");
    key("Enter");
    expect(sent).toHaveBeenCalledTimes(2);
  });
});
