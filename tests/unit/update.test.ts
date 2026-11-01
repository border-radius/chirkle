import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../../web/src/api.ts";
import { appScript, startUpdates } from "../../web/src/update.ts";

const page = (script: string) =>
  `<!doctype html><head></head><body><div id="app"></div><script type="module" src="${script}"></script></body>`;

describe("a new version (§27.4)", () => {
  let root: HTMLElement;
  let reconnect: (r: boolean) => void;
  let stop: () => void;
  const api = {
    onConnect: (fn: (r: boolean) => void) => {
      reconnect = fn;
      return () => {};
    },
  } as unknown as Api;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement("div");
    root.append(document.createElement("header"));
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it("reads the build's script from index.html", () => {
    expect(appScript(page("/assets/app-AB12CD34.js"))).toBe("/assets/app-AB12CD34.js");
    expect(appScript("<html>502 Bad Gateway</html>")).toBeUndefined();
  });

  it("after a reconnect, says so above the app when index.html names another build", async () => {
    let served = page("/assets/app-OLD00000.js");
    const load = vi.fn(async () => served);
    stop = startUpdates(api, root, "/assets/app-OLD00000.js", load);
    reconnect(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(root.querySelector(".update-bar")).toBeNull();

    served = page("/assets/app-NEW11111.js");
    reconnect(true); // a reconnect checks even right after another check
    await vi.advanceTimersByTimeAsync(10_000);
    const bar = root.firstElementChild!;
    expect(bar.className).toBe("update-bar");
    expect(bar.getAttribute("role")).toBe("status");
    expect(bar.querySelector("a")?.textContent).toBe("Reload");

    // Shown once: no more checks.
    reconnect(true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(root.querySelectorAll(".update-bar")).toHaveLength(1);
  });

  it("checks every half hour and ignores the first connect and failed loads", async () => {
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("");
    load.mockResolvedValue(page("/assets/app-NEW11111.js"));
    stop = startUpdates(api, root, "/assets/app-OLD00000.js", load);
    reconnect(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60_000); // a failed load, an empty page
    expect(root.querySelector(".update-bar")).toBeNull();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(root.querySelector(".update-bar")).not.toBeNull();
  });

  it("does nothing on a page with no build script named; stopping removes the line", async () => {
    const load = vi.fn(async () => page("/assets/app-NEW11111.js"));
    startUpdates(api, root, null, load)();
    stop = startUpdates(api, root, "/assets/app-OLD00000.js", load);
    reconnect(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    stop();
    expect(root.querySelector(".update-bar")).toBeNull();
  });
});
