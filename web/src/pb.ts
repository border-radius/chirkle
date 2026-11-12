// A minimal PocketBase client: only what api.ts uses (REST requests, the auth store, realtime over SSE, file URLs).
// It replaces the official JS SDK, whose admin services, OAuth2/OTP/MFA flows and cookie helpers the app never used
// but always shipped (§7.7). The wire behavior follows SDK 0.28: same storage key, query and realtime protocol.

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: string;
  query?: Query | undefined;
  /** JSON, or multipart when any value is a Blob/File (or an array of them). */
  body?: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  /** How much of a multipart body has been sent, 0 to 1: the request then goes through XHR (fetch can't tell). */
  onUpload?: ((fraction: number) => void) | undefined;
  /** A conditional GET (PERF.md §5): `sent` goes as If-None-Match, the answer's ETag to `got`. A 304 answers undefined. */
  tag?: { sent?: string | undefined; got?: ((tag: string) => void) | undefined } | undefined;
}

export interface AuthRecord {
  id: string;
  collectionName?: string;
  [field: string]: unknown;
}

/** A failed request: `status` 0 for network trouble or an abort. `response` is PocketBase's error body. */
export class PbError extends Error {
  readonly status: number;
  readonly response: { message?: string; data?: Record<string, { message?: unknown; code?: unknown }> };
  readonly isAbort: boolean;

  constructor(status: number, response: PbError["response"] = {}, isAbort = false) {
    super(response.message || "Something went wrong.");
    this.name = "PbError";
    this.status = status;
    this.response = response;
    this.isAbort = isAbort;
  }
}

// ---- auth store ----

export interface AuthStore {
  readonly token: string;
  readonly record: AuthRecord | null;
  /** There is a token and it hasn't expired. */
  readonly isValid: boolean;
  /** When the token expires (epoch ms), or 0 without a (readable) token. */
  readonly expiresAt: number;
  save(token: string, record: AuthRecord | null): void;
  clear(): void;
  /** Called on every save/clear, including another tab's when the store is backed by localStorage. */
  onChange(fn: () => void): () => void;
}

/** The SDK's key, so existing sessions survive the switch. */
const STORAGE_KEY = "pocketbase_auth";

/** The JWT's `exp` (seconds), or 0 when it can't be read. */
function tokenExp(token: string): number {
  try {
    const part = token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/");
    return Number(JSON.parse(atob(part)).exp) || 0;
  } catch {
    return 0;
  }
}

/** In memory only, or persisted in `storage` (shared with the other tabs of this browser). */
export function createAuthStore(storage?: Storage): AuthStore {
  let token = "";
  let record: AuthRecord | null = null;
  const listeners = new Set<() => void>();

  const load = (raw: string | null) => {
    let data: { token?: string; record?: AuthRecord | null } = {};
    try {
      data = JSON.parse(raw || "{}") ?? {};
    } catch {}
    token = data.token || "";
    record = data.record || null;
  };
  const set = (t: string, r: AuthRecord | null) => {
    token = t;
    record = r;
    for (const fn of [...listeners]) fn();
  };

  if (storage) {
    load(storage.getItem(STORAGE_KEY));
    addEventListener("storage", (e) => {
      if (e.key !== STORAGE_KEY) return;
      load(e.newValue);
      set(token, record);
    });
  }

  return {
    get token() {
      return token;
    },
    get record() {
      return record;
    },
    get isValid() {
      return tokenExp(token) > Date.now() / 1000;
    },
    get expiresAt() {
      return tokenExp(token) * 1000;
    },
    save(t, r) {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ token: t, record: r }));
      set(t, r);
    },
    clear() {
      storage?.removeItem(STORAGE_KEY);
      set("", null);
    },
    onChange(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

// ---- client ----

export type Unsubscribe = () => Promise<void>;

export interface Realtime {
  /** Connected, with a client id, and no connect in progress. */
  readonly isConnected: boolean;
  /** The connection being made follows one that failed or was lost: events may have been missed meanwhile. */
  readonly recovered: boolean;
  /**
   * Listen to `topic` (e.g. "messages/*", or "PB_CONNECT" for every (re)connect). Resolves once the server has the
   * subscription, so an event caused after that reaches `fn`. `query` (fields, expand, filter) applies to its events.
   */
  subscribe(topic: string, fn: (data: unknown) => void, query?: Query): Promise<Unsubscribe>;
  /** Drop every subscription and close the connection. */
  unsubscribe(): Promise<void>;
}

export interface PbClient {
  readonly authStore: AuthStore;
  readonly realtime: Realtime;
  send<T>(path: string, opts?: RequestOptions): Promise<T>;
  /** Bind `{:name}` placeholders in a filter expression, quoting and escaping the values. */
  filter(expr: string, params: Record<string, string | number | boolean | null>): string;
  /** URL of a record's file (`query`: thumb). */
  fileUrl(collection: string, recordId: string, filename: string, query?: Query): string;
}

const qs = (query: Query = {}) => {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) if (v !== undefined) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};

const isFiles = (v: unknown) => v instanceof Blob || (Array.isArray(v) && v.some((x) => x instanceof Blob));

/** A body holding files as multipart: files and strings as fields, anything else in PocketBase's `@jsonPayload`. */
function toFormData(body: Record<string, unknown>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue;
    if (isFiles(v)) for (const f of [v].flat() as Blob[]) form.append(k, f);
    else if (typeof v === "string") form.append(k, v);
    else form.append("@jsonPayload", JSON.stringify({ [k]: v }));
  }
  return form;
}

/** An XHR answer as fetch gives it: rejects only when nothing came back (an AbortError when aborted). */
function upload(url: string, method: string, headers: Record<string, string>, body: FormData, onUpload: (fraction: number) => void) {
  return new Promise<{ status: number; json: () => Promise<unknown> }>((ok, fail) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && e.total && onUpload(e.loaded / e.total);
    x.onload = () => ok({ status: x.status, json: async () => JSON.parse(x.responseText) });
    x.onerror = () => fail(new TypeError("Network request failed"));
    x.onabort = () => fail(new DOMException("Aborted", "AbortError"));
    x.send(body);
  });
}

export function createClient(baseUrl: string, authStore: AuthStore = createAuthStore()): PbClient {
  const base = baseUrl.replace(/\/+$/, "");

  async function send<T>(path: string, { method = "GET", query, body, signal, onUpload, tag }: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (authStore.token) headers.Authorization = authStore.token;
    // The 304 is ours to read, not the HTTP cache's to answer from (it keeps no copy: no-store).
    if (tag?.sent) Object.assign(headers, { "If-None-Match": tag.sent, "Cache-Control": "no-cache" });
    let payload: BodyInit | undefined;
    if (body) {
      if (Object.values(body).some(isFiles)) payload = toFormData(body);
      else {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }
    const aborted = (e: unknown) => !!signal?.aborted || (e as Error)?.name === "AbortError";
    let res: { status: number; json: () => Promise<unknown>; headers?: Headers };
    let data: PbError["response"] = {};
    const url = base + path + qs(query);
    try {
      res =
        onUpload && payload instanceof FormData
          ? await upload(url, method, headers, payload, onUpload)
          : await fetch(url, { method, headers, ...(payload ? { body: payload } : {}), ...(signal ? { signal } : {}) });
      const etag = res.headers?.get("ETag");
      if (etag) tag?.got?.(etag);
      if (res.status === 304) return undefined as T;
      // No body is fine for a 204, or an error the server didn't explain. A success whose body never came (the page
      // navigated away, the connection dropped) is a failure, not `{}`: as a login's answer it saved no session (QA BUG-117).
      data = await (res.json() as Promise<PbError["response"]>).catch((e) => {
        if (aborted(e) || (res.status < 300 && res.status !== 204)) throw e;
        return {};
      });
    } catch (e) {
      throw new PbError(0, {}, aborted(e));
    }
    if (res.status >= 400) throw new PbError(res.status, data ?? {});
    return data as T;
  }

  const realtime = createRealtime(`${base}/api/realtime`, send);
  // The server reads who a realtime client is from the token its subscriptions were sent with. A new token (a password
  // change, which revokes the old ones, here or in another tab) must reach it, or nothing more arrives (QA BUG-52).
  // Someone else (or nobody, after a logout) needs a new connection: the server refuses another user's subscriptions on
  // one it knows as someone, and would go on sending that user's events on it (QA BUG-66).
  let token = authStore.token;
  let who = token ? (authStore.record?.id ?? "") : "";
  authStore.onChange(() => {
    if (authStore.token === token) return;
    token = authStore.token;
    const next = token ? (authStore.record?.id ?? "") : "";
    if (next === who) return realtime.resubmit();
    who = next;
    realtime.restart();
  });

  return {
    authStore,
    realtime,
    send,
    filter: (expr, params) =>
      expr.replace(/\{:(\w+)\}/g, (match, name: string) => {
        if (!Object.hasOwn(params, name)) return match;
        const v = params[name];
        return typeof v === "string" ? JSON.stringify(v) : String(v);
      }),
    fileUrl: (collection, recordId, filename, query) =>
      `${base}/api/files/${[collection, recordId, filename].map(encodeURIComponent).join("/")}${qs(query)}`,
  };
}

// ---- realtime ----

/** Wait before reconnect attempt n (the last value repeats), as the SDK does. */
const RECONNECT_MS = [200, 300, 500, 1000, 1200, 1500, 2000];
const CONNECT_TIMEOUT_MS = 15_000;

type Listener = (e: Event) => void;

/**
 * The SDK's realtime protocol: one EventSource; PB_CONNECT carries the client id; the set of subscriptions (each a
 * topic plus its serialized options) is POSTed to /api/realtime whenever it changes, and again after a reconnect.
 */
function createRealtime(url: string, send: PbClient["send"]): Realtime & { resubmit(): void; restart(): void } {
  let es: EventSource | null = null;
  let clientId = "";
  /** Subscription key → listeners. A key is the topic plus its options, and the event name the server uses. */
  const subs = new Map<string, Listener[]>();
  let lastSent: string[] = [];
  let attempts = 0;
  let lost = false;
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  /** The in-flight subscriptions POST, aborted on disconnect. */
  let submitting: AbortController | null = null;
  /** Submits run one after another, so an older subscription set never lands after a newer one. */
  let queue: Promise<unknown> = Promise.resolve();

  const keys = () => [...subs.keys()];
  const unsent = () => {
    const now = keys();
    return now.length !== lastSent.length || now.some((k) => !lastSent.includes(k));
  };
  const bindAll = (add: boolean) => {
    for (const [key, fns] of subs) for (const fn of fns) add ? es?.addEventListener(key, fn) : es?.removeEventListener(key, fn);
  };

  async function sendSubs(): Promise<void> {
    if (!clientId) return;
    if (!subs.size) return disconnect();
    if (!unsent()) return;
    bindAll(false);
    bindAll(true);
    lastSent = keys();
    submitting = new AbortController();
    try {
      await send("/api/realtime", { method: "POST", body: { clientId, subscriptions: lastSent }, signal: submitting.signal });
    } catch (e) {
      if (!(e instanceof PbError && e.isAbort)) throw e;
    }
  }

  function submit(): Promise<void> {
    const p = queue.then(sendSubs);
    queue = p.catch(() => {});
    return p;
  }

  function connect(): Promise<void> {
    if (attempts > 0) return Promise.resolve(); // a reconnect is scheduled; it sends every subscription
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      if (pending.length === 1) queueMicrotask(initConnect);
    });
  }

  function initConnect() {
    disconnect(true);
    connectTimer = setTimeout(() => connectError(new Error("EventSource connect took too long.")), CONNECT_TIMEOUT_MS);
    const source = new EventSource(url);
    es = source;
    // A connection closed meanwhile (a restart for another user, a reconnect) must leave the current one alone: its
    // late answers would otherwise settle or fail the new connection's pending subscribes.
    const current = () => es === source;
    source.onerror = () => current() && connectError(new Error("Failed to establish realtime connection."));
    source.addEventListener("PB_CONNECT", (e) => {
      if (!current()) return;
      clientId = (e as MessageEvent).lastEventId;
      lastSent = [];
      submit()
        .then(async () => {
          for (let tries = 3; current() && unsent() && tries > 0; tries--) await submit();
          if (!current()) return;
          // Listeners added while those were on their way, to a topic already sent, made no submit that binds them
          // (QA BUG-269: the notifications' after the unread counts', during a login's reconnect). Binding is idempotent.
          bindAll(true);
          for (const p of pending) p.resolve();
          pending = [];
          attempts = 0;
          clearTimeout(reconnectTimer);
          clearTimeout(connectTimer);
          for (const fn of subs.get("PB_CONNECT") ?? []) fn(e);
          lost = false;
          if (unsent()) await submit();
        })
        .catch((err) => {
          if (!current()) return;
          clientId = "";
          lastSent = [];
          connectError(err);
        });
    });
  }

  function connectError(err: unknown) {
    clearTimeout(connectTimer);
    clearTimeout(reconnectTimer);
    lost = true;
    if (!clientId && !attempts) {
      // The first connect failed: tell those waiting for it, then go on trying like after a lost connection. Nothing
      // else would try again, and the page would get no live updates at all.
      for (const p of pending) p.reject(err instanceof PbError ? err : new PbError(0));
      pending = [];
      if (!subs.size) return disconnect();
    }
    disconnect(true);
    reconnectTimer = setTimeout(initConnect, RECONNECT_MS[Math.min(attempts, RECONNECT_MS.length - 1)]);
    attempts++;
  }

  function disconnect(reconnecting = false) {
    clearTimeout(connectTimer);
    clearTimeout(reconnectTimer);
    bindAll(false);
    submitting?.abort();
    submitting = null;
    es?.close();
    es = null;
    clientId = "";
    lastSent = [];
    if (!reconnecting) {
      attempts = 0;
      for (const p of pending) p.resolve();
      pending = [];
    }
  }

  return {
    get isConnected() {
      return !!es && !!clientId && !pending.length;
    },
    get recovered() {
      return lost;
    },
    async subscribe(topic, fn, query) {
      const key = query ? `${topic}?options=${encodeURIComponent(JSON.stringify({ query }))}` : topic;
      const listener: Listener = (e) => {
        let data: unknown;
        try {
          data = JSON.parse((e as MessageEvent).data);
        } catch {}
        fn(data || {});
      };
      const fns = subs.get(key) ?? [];
      subs.set(key, [...fns, listener]);
      if (!es || !clientId || pending.length) await connect();
      else {
        // Bound now: a key dropped and taken again before the submits ran is no change to them, and they bind nothing.
        es.addEventListener(key, listener);
        if (!fns.length) await submit();
      }

      return async () => {
        const left = (subs.get(key) ?? []).filter((f) => f !== listener);
        es?.removeEventListener(key, listener);
        if (left.length) subs.set(key, left);
        else subs.delete(key);
        await submit();
      };
    },
    async unsubscribe() {
      bindAll(false);
      subs.clear();
      await submit();
    },
    /** Send the subscriptions again (with the current token), if connected. */
    resubmit() {
      if (!clientId || !subs.size) return;
      lastSent = [];
      // A failure that comes after this connection was replaced (a logout, another user) is the old one's: it must not
      // fail and close the new one, whose subscribes would reject and which would never reconnect (QA BUG-68).
      const source = es;
      submit().catch(() => es === source && connectError(new PbError(0)));
    },
    /** Close the connection and, with subscriptions left, open a new one that sends them all (with the current token). */
    restart() {
      if (!es && !pending.length) return; // not connected: the next subscribe() connects afresh
      disconnect();
      if (subs.size) connect().catch(() => {});
    },
  };
}
