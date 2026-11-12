import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../../web/src/api.ts";
import { createAuthStore, createClient, PbError } from "../../web/src/pb.ts";

/** An unsigned JWT with `payload` (only the client's expiry check reads it). Base64url, like PocketBase's. */
const jwt = (payload: object) => `x.${btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.x`;
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const user = { id: "u1", collectionName: "users", name: "Ada" };

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("auth store", () => {
  it("is valid only with an unexpired token", () => {
    const store = createAuthStore();
    expect(store.isValid).toBe(false);
    store.save(jwt({ exp: inAnHour() }), user);
    expect(store.isValid).toBe(true);
    store.save(jwt({ exp: Math.floor(Date.now() / 1000) - 1 }), user);
    expect(store.isValid).toBe(false);
    store.save("not-a-jwt", user);
    expect(store.isValid).toBe(false);
  });

  it("tells when the token expires (QA BUG-45: the app renews it in time)", () => {
    const store = createAuthStore();
    expect(store.expiresAt).toBe(0);
    const exp = inAnHour();
    store.save(jwt({ exp }), user);
    expect(store.expiresAt).toBe(exp * 1000);
    store.clear();
    expect(store.expiresAt).toBe(0);
  });

  it("reads base64url tokens (a payload with - or _ in it)", () => {
    const store = createAuthStore();
    // "?>?" encodes to "Pz4/" in base64: "/" becomes "_" in base64url.
    store.save(jwt({ exp: inAnHour(), x: "?>?" }), user);
    expect(store.isValid).toBe(true);
  });

  it("persists to storage under the SDK's key, so existing sessions survive", () => {
    const token = jwt({ exp: inAnHour() });
    createAuthStore(localStorage).save(token, user);
    expect(JSON.parse(localStorage.getItem("pocketbase_auth")!)).toEqual({ token, record: user });
    const reloaded = createAuthStore(localStorage);
    expect(reloaded.token).toBe(token);
    expect(reloaded.record).toEqual(user);
    reloaded.clear();
    expect(localStorage.getItem("pocketbase_auth")).toBeNull();
  });

  it("follows another tab's save and clear through the storage event", () => {
    const store = createAuthStore(localStorage);
    const changed = vi.fn();
    store.onChange(changed);
    const token = jwt({ exp: inAnHour() });
    const newValue = JSON.stringify({ token, record: user });
    dispatchEvent(new StorageEvent("storage", { key: "pocketbase_auth", newValue }));
    expect(store.record).toEqual(user);
    expect(changed).toHaveBeenCalledTimes(1);
    dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "{}" }));
    expect(changed).toHaveBeenCalledTimes(1);
    dispatchEvent(new StorageEvent("storage", { key: "pocketbase_auth", newValue: null }));
    expect(store.token).toBe("");
    expect(store.record).toBeNull();
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("stops calling a listener once unsubscribed", () => {
    const store = createAuthStore();
    const changed = vi.fn();
    const off = store.onChange(changed);
    store.clear();
    off();
    store.clear();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("client", () => {
  const pb = createClient("http://pb.test/");

  it("binds filter params as quoted, escaped literals and leaves unknown placeholders alone", () => {
    expect(pb.filter("a = {:s} && b = {:n} && c = {:b} && d = {:x} && e = {:missing}", { s: `x" || "`, n: 3, b: true, x: null })).toBe(
      `a = "x\\" || \\"" && b = 3 && c = true && d = null && e = {:missing}`,
    );
  });

  it("builds file URLs with encoded parts and only the query values given", () => {
    expect(pb.fileUrl("messages", "m1", "a b.png", { thumb: "240x180", token: undefined })).toBe(
      "http://pb.test/api/files/messages/m1/a%20b.png?thumb=240x180",
    );
  });

  function stubFetch(status: number, body: unknown) {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("sends JSON with the auth token, and the query encoded", async () => {
    const fetch = stubFetch(200, { ok: 1 });
    pb.authStore.save("tok", user);
    expect(await pb.send("/api/x", { method: "POST", query: { filter: "a = 1", skipTotal: true }, body: { a: null } })).toEqual({ ok: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://pb.test/api/x?filter=a%20%3D%201&skipTotal=true");
    expect(init.headers).toEqual({ Authorization: "tok", "Content-Type": "application/json" });
    expect(init.body).toBe(`{"a":null}`);
    pb.authStore.clear();
  });

  it("sends a body holding files as multipart: files and strings as fields, the rest as @jsonPayload", async () => {
    const fetch = stubFetch(200, {});
    const a = new File(["a"], "a.txt");
    const b = new File(["b"], "b.txt");
    await pb.send("/api/x", { method: "POST", body: { text: "hi", files: [a, b], n: 2 } });
    const form = fetch.mock.calls[0]![1].body as FormData;
    expect(form.get("text")).toBe("hi");
    expect(form.getAll("files").map((f) => (f as File).name)).toEqual(["a.txt", "b.txt"]);
    expect(form.get("@jsonPayload")).toBe(`{"n":2}`);
    expect(fetch.mock.calls[0]![1].headers).toEqual({});
  });

  it("rejects with the server's message, status and field errors", async () => {
    stubFetch(400, { message: "Failed to create record.", data: { name: { code: "validation_required", message: "Missing." } } });
    const err = await pb.send("/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PbError);
    expect(err).toMatchObject({ status: 400, message: "Failed to create record.", isAbort: false });
    expect((err as PbError).response.data?.name).toEqual({ code: "validation_required", message: "Missing." });
  });

  it("rejects with status 0 on network trouble, and marks aborts", async () => {
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("Failed to fetch")));
    expect(await pb.send("/api/x").catch((e: unknown) => e)).toMatchObject({ status: 0, isAbort: false });
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal("fetch", async () => Promise.reject(new DOMException("aborted", "AbortError")));
    expect(await pb.send("/api/x", { signal: ac.signal }).catch((e: unknown) => e)).toMatchObject({ status: 0, isAbort: true });
  });

  it("rejects with status 0 when a success's body never comes; no body is fine for a 204 or an error (QA BUG-117)", async () => {
    const cut = () => new Response(new ReadableStream({ pull: (c) => c.error(new TypeError("network error")) }), { status: 200 });
    vi.stubGlobal("fetch", async () => cut());
    expect(await pb.send("/api/x").catch((e: unknown) => e)).toMatchObject({ status: 0, isAbort: false });
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    expect(await pb.send("/api/x", { method: "POST" })).toEqual({});
    vi.stubGlobal("fetch", async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await pb.send("/api/x").catch((e: unknown) => e)).toMatchObject({ status: 502 });

    // A session refresh cut off like that (a reload while it was on its way) kept the session, not an empty one.
    const store = createAuthStore(localStorage);
    store.save(jwt({ exp: inAnHour() }), user);
    const token = store.token;
    const api = createApi(createClient("http://pb.test", store));
    vi.stubGlobal("fetch", async () => cut());
    await expect(api.refreshAuth()).rejects.toMatchObject({ status: 0 });
    expect(store.token).toBe(token);
    expect(JSON.parse(localStorage.getItem("pocketbase_auth")!).token).toBe(token);
  });
});

describe("realtime", () => {
  /** An EventSource the test drives: it records every connection and delivers the events the test emits. */
  class FakeSource {
    static all: FakeSource[] = [];
    closed = false;
    onerror: (() => void) | null = null;
    private readonly listeners = new Map<string, Set<(e: Event) => void>>();
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      FakeSource.all.push(this);
    }
    addEventListener(type: string, fn: (e: Event) => void) {
      this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(fn));
    }
    removeEventListener(type: string, fn: (e: Event) => void) {
      this.listeners.get(type)?.delete(fn);
    }
    close() {
      this.closed = true;
    }
    emit(type: string, init: MessageEventInit) {
      for (const fn of [...(this.listeners.get(type) ?? [])]) fn(new MessageEvent(type, init));
    }
  }

  /** The subscription POSTs, each answered when the test says. Aborts are ignored: the answer was already on its way. */
  function stubPosts() {
    const posts: { respond: (status: number) => void }[] = [];
    vi.stubGlobal(
      "fetch",
      () =>
        new Promise<Response>((resolve) =>
          posts.push({ respond: (status) => resolve(new Response(status === 204 ? null : "{}", { status })) }),
        ),
    );
    return posts;
  }

  afterEach(() => {
    FakeSource.all = [];
  });

  it("a first connect that fails is tried again, and the connect after it says events may have been missed (QA BUG-74)", async () => {
    vi.stubGlobal("EventSource", FakeSource);
    const posts = stubPosts();
    const pb = createClient("http://pb.test", createAuthStore());
    const events: unknown[] = [];
    const subscribed = pb.realtime.subscribe("rooms/*", (e) => events.push(e));
    const recovered: boolean[] = [];
    void pb.realtime.subscribe("PB_CONNECT", () => recovered.push(pb.realtime.recovered)).catch(() => {});
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(1));
    FakeSource.all[0]!.onerror!(); // e.g. the network dropped just as the page loaded
    await expect(subscribed).rejects.toMatchObject({ status: 0 }); // those waiting are told
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(2)); // ...and it tries again by itself
    FakeSource.all[1]!.emit("PB_CONNECT", { lastEventId: "c1", data: "{}" });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    posts[0]!.respond(204);
    await vi.waitFor(() => expect(recovered).toEqual([true]));
    expect(pb.realtime.recovered).toBe(false);
    FakeSource.all[1]!.emit("rooms/*", { data: JSON.stringify({ action: "create" }) });
    expect(events).toEqual([{ action: "create" }]);
  });

  it("a resubmit that fails after the connection was replaced leaves the new connection alone (QA BUG-68)", async () => {
    vi.stubGlobal("EventSource", FakeSource);
    const posts = stubPosts();
    const store = createAuthStore();
    store.save(jwt({ exp: inAnHour() }), user);
    const pb = createClient("http://pb.test", store);
    const subscribed = pb.realtime.subscribe("rooms/*", () => {});
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(1));
    FakeSource.all[0]!.emit("PB_CONNECT", { lastEventId: "c1", data: "{}" });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    posts[0]!.respond(204);
    await subscribed;

    store.save(jwt({ exp: inAnHour() + 60 }), user); // renewed: the subscriptions go again, with the new token
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    store.clear(); // logged out before the answer: a new connection, as a guest
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(2));
    posts[1]!.respond(404); // the old connection's answer, late: the server has forgotten that client
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeSource.all[1]!.closed).toBe(false);

    FakeSource.all[1]!.emit("PB_CONNECT", { lastEventId: "c2", data: "{}" });
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    posts[2]!.respond(204);
    await vi.waitFor(() => expect(pb.realtime.isConnected).toBe(true));
  });

  it("QA BUG-269: a second listener on a topic, added while the connection's subscriptions are on their way, gets its events", async () => {
    vi.stubGlobal("EventSource", FakeSource);
    const posts = stubPosts();
    const pb = createClient("http://pb.test", createAuthStore());
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = pb.realtime.subscribe("chat/messages", (e) => first.push(e)); // e.g. the unread counts
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(1));
    FakeSource.all[0]!.emit("PB_CONNECT", { lastEventId: "c1", data: "{}" });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    // The notifications chunk, loaded meanwhile: the same topic, so nothing new to send.
    const b = pb.realtime.subscribe("chat/messages", (e) => second.push(e));
    posts[0]!.respond(204);
    await Promise.all([a, b]);
    expect(posts).toHaveLength(1);
    FakeSource.all[0]!.emit("chat/messages", { data: JSON.stringify({ action: "create" }) });
    expect(first).toEqual([{ action: "create" }]);
    expect(second).toEqual([{ action: "create" }]);
  });

  it("a listener hears events exactly while it is subscribed, whenever it was added (item 60)", async () => {
    vi.stubGlobal("EventSource", FakeSource);
    const posts = stubPosts();
    const pb = createClient("http://pb.test", createAuthStore());
    const heard: string[] = [];
    const listen = (name: string) => pb.realtime.subscribe("chat/messages", () => heard.push(name));
    const a = listen("a");
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(1));
    FakeSource.all[0]!.emit("PB_CONNECT", { lastEventId: "c1", data: "{}" });
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    posts[0]!.respond(204);
    const offA = await a;
    const offB = await listen("b"); // connected, same topic: nothing to send
    const emit = (i: number) => FakeSource.all[i]!.emit("chat/messages", { data: "{}" });
    emit(0);
    expect(heard).toEqual(["a", "b"]);

    heard.length = 0;
    void offA();
    emit(0);
    expect(heard).toEqual(["b"]);

    // The last listener goes and a new one comes before the unsubscribe was sent: no change for the server.
    heard.length = 0;
    void offB();
    const c = listen("c");
    emit(0);
    expect(heard).toEqual(["c"]);
    await c;
    expect(posts).toHaveLength(1);
    expect(FakeSource.all[0]!.closed).toBe(false);

    // A lost connection: the new EventSource dispatches to the same listeners, and one added while reconnecting.
    heard.length = 0;
    FakeSource.all[0]!.onerror!();
    await vi.waitFor(() => expect(FakeSource.all).toHaveLength(2));
    const d = listen("d");
    FakeSource.all[1]!.emit("PB_CONNECT", { lastEventId: "c2", data: "{}" });
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    posts[1]!.respond(204);
    await d;
    emit(0); // the old connection hears nothing any more
    emit(1);
    expect(heard).toEqual(["c", "d"]);
  });
});
