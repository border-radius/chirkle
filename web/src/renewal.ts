// Keeping the session alive and checked (QA BUG-45, BUG-51, BUG-151): renewed halfway through its lifetime for as long
// as the tab stays open, checked again when the tab comes back after a while and when the server refuses a change. A
// session that ran out or was revoked calls `expire`; one that can't be checked for lack of network is tried later.

import { type Api, ApiError } from "./api.ts";
import type { AppState, Store } from "./store.ts";

/** Statuses meaning "the server rejected this session" (vs. 0 = network trouble). */
const AUTH_REJECTED = new Set([401, 403, 404]);
/** Longest wait between session renewals, and the wait before another try after one failed for lack of network. */
const RENEW_MAX_MS = 24 * 60 * 60 * 1000;
const RENEW_RETRY_MS = 60 * 1000;
/**
 * A session can also be revoked before it expires: a password change signs out every other device. It is checked again
 * when the server refuses a change (at most this often), and when the tab comes back after this long (QA BUG-51).
 */
const CHECK_MIN_MS = 30 * 1000;
const CHECK_STALE_MS = 5 * 60 * 1000;
/** At start, the check waits for the room list (it would take a connection and server time from it), at most this long. */
const START_WAIT_MS = 3000;

export interface Renewal {
  /** Check (and renew) the session now. */
  renew(): void;
  /**
   * A restored session, at start: checked (and renewed) once the room list is in, or START_WAIT_MS on, whichever is
   * first. One that ran out meanwhile is over at once. Until checked, a revoked one shows what a guest sees (PERF.md §5).
   */
  renewSoon(): void;
  /** The tab became visible: timers were late or paused meanwhile. */
  visible(): void;
  stop(): void;
}

export function createRenewal({ api, store, expire }: { api: Api; store: Store<AppState>; expire: () => void }): Renewal {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the session was last checked with the server (renewed, or found revoked). */
  let checkedAt = 0;
  /** Stops waiting for the room list to check a restored session (renewSoon). */
  let starting = () => {};

  function schedule(ms = Math.min(Math.max((api.sessionExpiry() - Date.now()) / 2, 0), RENEW_MAX_MS)) {
    clearTimeout(timer);
    if (store.get().user) timer = setTimeout(renew, ms);
  }

  function renew() {
    const user = store.get().user;
    if (!user) return;
    // Already over (e.g. the computer slept through it): it can't be renewed, so say so instead of failing quietly.
    if (api.sessionExpiry() <= Date.now()) return expire();
    checkedAt = Date.now();
    api.refreshAuth().then(
      (fresh) => {
        if (store.get().user?.id !== fresh.id) return;
        store.set({ user: fresh });
        schedule();
      },
      (err: unknown) => {
        if (store.get().user?.id !== user.id) return;
        if (err instanceof ApiError && AUTH_REJECTED.has(err.status)) expire();
        else schedule(RENEW_RETRY_MS); // offline ≠ logged out: try again later
      },
    );
  }

  /** A refused change: was it the session? A revoked one logs out instead of failing every send ("Not sent"). */
  const offRejected = api.onRejected(() => {
    if (!store.get().user) return;
    const wait = checkedAt + CHECK_MIN_MS - Date.now();
    // Checked a moment ago: check again once allowed, not never (QA BUG-151).
    if (wait <= 0) renew();
    else schedule(wait);
  });

  const offStore = store.subscribe((s, prev) => {
    if (s.user === prev.user) return;
    if (s.user && !prev.user) schedule();
    if (!s.user) clearTimeout(timer);
  });

  return {
    renew,
    renewSoon() {
      if (!store.get().user) return;
      if (api.sessionExpiry() <= Date.now()) return expire();
      const listed = (s: AppState) => s.roomsStatus !== "idle" && s.roomsStatus !== "loading";
      if (listed(store.get())) return renew();
      const go = () => {
        starting();
        renew();
      };
      const wait = setTimeout(go, START_WAIT_MS);
      const off = store.subscribe((s) => listed(s) && go());
      starting = () => {
        clearTimeout(wait);
        off();
      };
    },
    visible() {
      // Also check a session not checked for a while: revoked meanwhile, this tab would get nothing live and send nothing.
      if (store.get().user && Date.now() - checkedAt > CHECK_STALE_MS) renew();
      else schedule();
    },
    stop() {
      starting();
      offRejected();
      offStore();
      clearTimeout(timer);
    },
  };
}
