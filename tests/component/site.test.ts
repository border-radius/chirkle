import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SITE } from "../../web/src/lib/types.ts";
import { cachedSite, startSite } from "../../web/src/site.ts";
import { type AppState, createStore, initialState } from "../../web/src/store.ts";
import { intercept, newApi } from "../support/api.ts";

/** A Map-backed Storage. */
function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
  };
}

describe("site settings (§24)", () => {
  it("loads the site record: the defaults' title, no logo, open signups, no password reset without mail settings", async () => {
    expect(await newApi().site()).toEqual({ title: "Chirkle", logo: "", inviteOnly: false, passwordReset: false });
  });

  it("shows the cached site right away, then the server's, and caches it", async () => {
    const acme = { title: "Acme", logo: "/a.png", inviteOnly: true, passwordReset: true };
    const storage = memoryStorage({ "chat.site": JSON.stringify({ title: "Old", logo: "", inviteOnly: false }) });
    const api = newApi();
    intercept(api, "site", () => async () => acme);
    const store = createStore<AppState>(initialState());
    startSite(api, store, storage);
    expect(store.get().site.title).toBe("Old");
    await vi.waitFor(() => expect(store.get().site).toEqual(acme));
    expect(cachedSite(storage)).toEqual(acme);
    // A site cached before password reset existed (§39): not offered until the server says so.
    expect(cachedSite(memoryStorage({ "chat.site": JSON.stringify({ title: "Old", logo: "", inviteOnly: false }) }))).toEqual({
      title: "Old",
      logo: "",
      inviteOnly: false,
      passwordReset: false,
    });
  });

  it("a failed load keeps what is shown; a broken cache is ignored", async () => {
    const api = newApi();
    intercept(api, "site", () => async () => {
      throw new Error("offline");
    });
    const store = createStore<AppState>(initialState());
    startSite(api, store, memoryStorage({ "chat.site": "{not json" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get().site).toBe(DEFAULT_SITE);
    expect(cachedSite(memoryStorage({ "chat.site": JSON.stringify({ title: 3 }) }))).toBeNull();
  });
});
