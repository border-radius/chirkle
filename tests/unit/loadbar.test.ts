import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoadbar, LOADBAR_MS } from "../../web/src/ui/loadbar.ts";

describe("loadbar (§7.9)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows only once a fetch has taken LOADBAR_MS, and goes as soon as it ends", () => {
    const bar = createLoadbar();
    expect(bar.el.getAttribute("aria-hidden")).toBe("true");
    bar.set(true);
    vi.advanceTimersByTime(LOADBAR_MS - 1);
    expect(bar.el.classList.contains("on")).toBe(false);
    bar.set(true); // still busy: the wait isn't restarted
    vi.advanceTimersByTime(1);
    expect(bar.el.classList.contains("on")).toBe(true);
    bar.set(false);
    expect(bar.el.classList.contains("on")).toBe(false);
  });

  it("a quick fetch shows nothing", () => {
    const bar = createLoadbar();
    bar.set(true);
    vi.advanceTimersByTime(LOADBAR_MS / 2);
    bar.set(false);
    vi.advanceTimersByTime(LOADBAR_MS * 2);
    expect(bar.el.classList.contains("on")).toBe(false);
  });
});
