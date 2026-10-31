import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ActionMenu, createActionMenu } from "../../../web/src/ui/menu.ts";

describe("createActionMenu", () => {
  let ac: AbortController;
  let menu: ActionMenu;

  beforeEach(() => {
    ac = new AbortController();
    menu = createActionMenu({ label: "Actions", signal: ac.signal });
    document.body.append(menu.el);
    menu.el.open = true;
  });
  afterEach(() => {
    ac.abort();
    menu.el.remove();
  });

  const buttons = () => [...menu.el.querySelectorAll("button")].map((b) => b.textContent);
  const button = (label: string) => [...menu.el.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const pressEscape = (el: Element) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  const summary = () => menu.el.querySelector("summary")!;

  it("renders a labelled toggle and one button per item", () => {
    menu.update([
      { label: "A", run: () => {} },
      { label: "B", run: () => {} },
    ]);
    expect(summary().getAttribute("aria-label")).toBe("Actions");
    expect(buttons()).toEqual(["A", "B"]);
  });

  it("an item closes the menu, then runs", () => {
    const run = vi.fn(() => expect(menu.el.open).toBe(false));
    menu.update([{ label: "A", run }]);
    button("A").click();
    expect(run).toHaveBeenCalledOnce();
  });

  it("QA BUG-190: an item run from the keyboard leaves the focus on the toggle, not the page; a mouse click leaves it alone", () => {
    menu.update([{ label: "A", run: () => {} }]);
    button("A").focus();
    button("A").click();
    expect(document.activeElement).toBe(summary());
    menu.el.open = true;
    (document.activeElement as HTMLElement).blur();
    button("A").click();
    expect(document.activeElement).toBe(document.body);
  });

  it("QA BUG-189: a setting is a switch (role=switch, aria-checked), valid outside a role=menu", () => {
    menu.update([{ label: "Notify", checked: true, run: () => {} }]);
    expect(button("Notify").getAttribute("role")).toBe("switch");
    expect(button("Notify").getAttribute("aria-checked")).toBe("true");
  });

  it("a confirm item asks first and focuses Cancel; Cancel returns to the items and focuses the toggle", () => {
    const run = vi.fn();
    menu.update([{ label: "Archive", confirm: { text: "Sure?", action: "Yes, archive" }, run }]);
    button("Archive").click();
    expect(menu.el.textContent).toContain("Sure?");
    expect(buttons()).toEqual(["Yes, archive", "Cancel"]);
    expect(document.activeElement).toBe(button("Cancel"));
    button("Cancel").click();
    expect(buttons()).toEqual(["Archive"]);
    expect(document.activeElement).toBe(summary());
    expect(run).not.toHaveBeenCalled();
  });

  it("confirming runs the item and closes the menu", () => {
    const run = vi.fn();
    menu.update([{ label: "Archive", confirm: { text: "Sure?", action: "Yes" }, run }]);
    button("Archive").click();
    button("Yes").click();
    expect(run).toHaveBeenCalledOnce();
    expect(menu.el.open).toBe(false);
    expect(buttons()).toEqual(["Archive"]);
  });

  it("Escape closes, leaves the confirm step and focuses the toggle", () => {
    menu.update([{ label: "Archive", confirm: { text: "Sure?", action: "Yes" }, run: () => {} }]);
    button("Archive").click();
    pressEscape(document.activeElement!);
    expect(menu.el.open).toBe(false);
    expect(buttons()).toEqual(["Archive"]);
    expect(document.activeElement).toBe(summary());
  });

  it("update() with the same labels keeps the buttons (and focus) but uses the new callbacks", () => {
    const first = vi.fn();
    const second = vi.fn();
    menu.update([{ label: "A", run: first }]);
    const el = button("A");
    el.focus();
    menu.update([{ label: "A", run: second }]);
    expect(button("A")).toBe(el);
    expect(document.activeElement).toBe(el);
    el.click();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
  });

  it("a confirm step whose item disappears is dropped", () => {
    menu.update([{ label: "Archive", confirm: { text: "Sure?", action: "Yes" }, run: () => {} }]);
    button("Archive").click();
    menu.update([{ label: "Unarchive", run: () => {} }]);
    expect(buttons()).toEqual(["Unarchive"]);
  });

  it("QA BUG-46: a click or focus anywhere else closes it; inside, it stays open", async () => {
    menu.update([{ label: "A", run: () => {} }]);
    const other = document.body.appendChild(document.createElement("button"));
    try {
      await vi.waitFor(() => {
        // The toggle event (which starts watching) is async: retry until a click inside is ignored and outside isn't.
        button("A").dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(menu.el.open).toBe(true);
        other.dispatchEvent(new Event("pointerdown", { bubbles: true }));
        expect(menu.el.open).toBe(false);
      });
      menu.el.open = true;
      await vi.waitFor(() => {
        other.blur(); // so that focus() fires focusin again on a retry
        other.focus();
        expect(menu.el.open).toBe(false);
      });
    } finally {
      other.remove();
    }
  });
});
