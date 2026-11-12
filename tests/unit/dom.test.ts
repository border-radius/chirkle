import { describe, expect, it, vi } from "vitest";
import { clear, h, holdKeys, reconcile, typeInto } from "../../web/src/dom.ts";

describe("h()", () => {
  it("creates an element with class, attributes and dataset", () => {
    const el = h("a", { class: "link big", href: "/r/1", title: "Go", dataset: { id: "m1", roomId: "r1" } });
    expect(el.tagName).toBe("A");
    expect(el.className).toBe("link big");
    expect(el.getAttribute("href")).toBe("/r/1");
    expect(el.title).toBe("Go");
    expect(el.dataset).toMatchObject({ id: "m1", roomId: "r1" });
    expect(el.getAttribute("data-room-id")).toBe("r1");
  });

  it("boolean attributes: true sets, false/null/undefined omit", () => {
    const el = h("button", { disabled: true, hidden: false, "aria-busy": null, title: undefined });
    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("numbers become attribute strings", () => {
    expect(h("textarea", { rows: 3 }).getAttribute("rows")).toBe("3");
  });

  it("form properties (value, checked) are set as properties", () => {
    const input = h("input", { value: "hello" });
    expect(input.value).toBe("hello");
    const box = h("input", { type: "checkbox", checked: true });
    expect(box.checked).toBe(true);
  });

  it("appends nested children in order, skipping null/undefined/false", () => {
    const el = h("div", {}, [h("b", {}, "name"), " says ", null, undefined, false, h("i", {}, ["hi", 2])]);
    expect(el.childNodes).toHaveLength(3);
    expect(el.textContent).toBe("name says hi2");
    expect(el.querySelector("i")!.textContent).toBe("hi2");
  });

  it("accepts a single child", () => {
    expect(h("p", {}, "solo").textContent).toBe("solo");
    expect(h("p").childNodes).toHaveLength(0);
  });

  it("attaches event listeners", () => {
    const click = vi.fn();
    const el = h("button", { on: { click } });
    el.click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("listeners stop after the signal aborts", () => {
    const ac = new AbortController();
    const click = vi.fn();
    const el = h("button", { on: { click }, signal: ac.signal });
    ac.abort();
    el.click();
    expect(click).not.toHaveBeenCalled();
  });

  describe("XSS safety (§7.3)", () => {
    const payload = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;

    it("string children become text nodes, never markup", () => {
      const el = h("div", {}, payload);
      expect(el.querySelector("img")).toBeNull();
      expect(el.querySelector("script")).toBeNull();
      expect(el.childNodes).toHaveLength(1);
      expect(el.firstChild!.nodeType).toBe(Node.TEXT_NODE);
      expect(el.textContent).toBe(payload);
    });

    it("attribute values are not parsed as markup", () => {
      const el = h("div", { title: payload });
      expect(el.children).toHaveLength(0);
      expect(el.title).toBe(payload);
    });
  });
});

describe("clear()", () => {
  it("removes all children", () => {
    const el = h("ul", {}, [h("li", {}, "a"), h("li", {}, "b"), "text"]);
    clear(el);
    expect(el.childNodes).toHaveLength(0);
  });
});

describe("reconcile()", () => {
  const li = (t: string) => h("li", {}, t);
  const texts = (el: Element) => [...el.childNodes].map((n) => n.textContent);

  it("fills an empty parent in order", () => {
    const ul = h("ul");
    reconcile(ul, [li("a"), li("b")]);
    expect(texts(ul)).toEqual(["a", "b"]);
  });

  it("keeps existing nodes (same identity) and only inserts what's new", () => {
    const [a, b, c] = [li("a"), li("b"), li("c")];
    const ul = h("ul", {}, [a, b]);
    const spy = vi.spyOn(ul, "insertBefore");
    reconcile(ul, [a, b, c]);
    expect(texts(ul)).toEqual(["a", "b", "c"]);
    expect(ul.childNodes[0]).toBe(a);
    expect(ul.childNodes[1]).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("replacing one node moves nothing else (the ones after it stay put)", () => {
    const [a, b, c, d, e] = [li("a"), li("b"), li("c"), li("d"), li("e")];
    const ul = h("ul", {}, [a, b, c, d]);
    const spy = vi.spyOn(ul, "insertBefore");
    reconcile(ul, [a, e, c, d]);
    expect(texts(ul)).toEqual(["a", "e", "c", "d"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(e, c);
  });

  it("prepends, removes and reorders", () => {
    const [a, b, c, d] = [li("a"), li("b"), li("c"), li("d")];
    const ul = h("ul", {}, [b, c, d]);
    reconcile(ul, [a, b, d]);
    expect(texts(ul)).toEqual(["a", "b", "d"]);
    expect(ul.childNodes[1]).toBe(b);
    reconcile(ul, [d, a]);
    expect(texts(ul)).toEqual(["d", "a"]);
  });

  it("empties the parent for an empty list", () => {
    const ul = h("ul", {}, [li("a")]);
    reconcile(ul, []);
    expect(ul.childNodes).toHaveLength(0);
  });
});

describe("holdKeys / typeInto (QA BUG-252, BUG-272)", () => {
  const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

  it("an Enter pressed after a name while the field loads reaches the field after the name; a lone Enter does not", () => {
    const ac = new AbortController();
    const held = holdKeys(ac.signal);
    for (const k of ["Enter", "b", "o", "Shift", "b", "Enter"]) key(k);
    const text = held.take();
    expect(text).toBe("bob\n");
    const input = document.createElement("input");
    const seen: string[] = [];
    input.addEventListener("input", () => seen.push(`input:${input.value}`));
    input.addEventListener("keydown", (e) => seen.push(`key:${e.key}`));
    typeInto(input, text);
    expect(seen).toEqual(["input:bob", "key:Enter"]);
    ac.abort();
  });
});
