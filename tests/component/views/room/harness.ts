// Shared setup for the room view tests in this folder: a signed-up user, a store, the view mounted in a fake layout
// (§7.5), and helpers to find and drive what it shows. Each test file calls useRoomView() in its describe.

import { afterEach, beforeEach, expect, vi } from "vitest";
import type { Action, Api } from "../../../../web/src/api.ts";
import type { Message, Room } from "../../../../web/src/lib/types.ts";
import type { View } from "../../../../web/src/router.ts";
import { type AppState, createStore, initialState, type Store } from "../../../../web/src/store.ts";
import { createRoomView } from "../../../../web/src/views/room.ts";
import { intercept, type SignedUp, signedUp, subscribed, uniq, viewContext } from "../../../support/api.ts";
import { fakeLayout, installIntersectionObserver } from "../../../support/dom.ts";

export const ROW = 40;
export const VIEWPORT = 400;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export let root: HTMLElement;
export let me: SignedUp;
export let store: Store<AppState>;
export let navigate: ReturnType<typeof vi.fn<(hash: string) => void>>;
export let view: View | undefined;
export let io: ReturnType<typeof installIntersectionObserver>;
export let layout: ReturnType<typeof fakeLayout>;

/** Set up a fresh room view's world for each test of the calling file (call it inside its describe). */
export function useRoomView() {
  beforeEach(async () => {
    io = installIntersectionObserver();
    root = document.createElement("main");
    document.body.append(root);
    me = await signedUp("Me");
    // The unread counts are in, with none (initialState's UNCOUNTED is a page just loaded: QA BUG-93).
    store = createStore<AppState>({ ...initialState(), user: me.user, unread: new Map() });
    navigate = vi.fn();
  });
  afterEach(async () => {
    view?.unmount();
    view = undefined;
    root.remove();
    io.restore();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });
}

/** Replace the mounted view (the tests that create or unmount one themselves). */
export function setView(v: View | undefined) {
  view = v;
}

export function setLayout(l: ReturnType<typeof fakeLayout>) {
  layout = l;
}

export const editBox = (id: string) => msgEl(id)?.querySelector<HTMLTextAreaElement>("textarea.edit-input") ?? null;

// ---- helpers ----

export const list = () => root.querySelector<HTMLOListElement>("ol.messages")!;
export const msgEls = () => [...root.querySelectorAll<HTMLElement>("li.msg")];
export const ids = () => msgEls().map((el) => el.dataset.id!);
export const msgEl = (id: string) => root.querySelector<HTMLElement>(`li.msg[data-id="${id}"]`);
export const bodyOf = (id: string) => msgEl(id)?.querySelector(".body")?.textContent ?? null;
export const sentinel = (which: "top" | "bottom") => root.querySelector<HTMLElement>(`li.sentinel[data-sentinel="${which}"]`);
export const beginning = () => root.querySelector("li.beginning");
export const pill = () => root.querySelector<HTMLButtonElement>("button.new-messages")!;
export const composer = () => root.querySelector<HTMLTextAreaElement>("form.composer textarea");
export const sendButton = () => root.querySelector<HTMLButtonElement>("form.composer button[type='submit']")!;
/** A menu item's label, without the hint under it or the value beside it (ui/menu.ts); else the button's text. */
export const labelOf = (b: Element) => b.querySelector(".tile + span")?.firstChild?.textContent ?? b.textContent;
/** A button by its text (a menu item by its label), or (an icon button) its accessible name. */
export const button = (scope: Element | null, label: string) =>
  scope
    ? ([...scope.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => labelOf(b) === label || (!b.textContent && b.getAttribute("aria-label") === label),
      ) ?? null)
    : null;
export const key = (el: Element, k: string, opts: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
export const type = (text: string) => {
  const t = composer()!;
  t.value = text;
  t.dispatchEvent(new Event("input", { bubbles: true }));
};
export const send = (text: string) => {
  type(text);
  key(composer()!, "Enter");
};
export const loaded = () => vi.waitFor(() => expect(list().getAttribute("aria-busy")).toBe("false"));
export const atBottom = () => list().scrollTop === Math.max(0, list().scrollHeight - VIEWPORT);
export const headerMenu = () => {
  const d = root.querySelector<HTMLDetailsElement>("header.room-header details")!;
  d.open = true;
  return d;
};

export async function newRoom(owner: SignedUp = me): Promise<Room> {
  return owner.api.createRoom(`room-${uniq()}`);
}

export async function mount(room: Room, params: Record<string, string> = {}, api: Api = me.api) {
  view = createRoomView(viewContext(api, store, navigate));
  view.mount(root, { id: room.id, ...params });
  layout = fakeLayout(list(), { rowHeight: ROW, clientHeight: VIEWPORT });
  await loaded();
  await subscribed(api); // live events caused from here on reach the view
}

/**
 * Drop realtime message events while `offline` is true (to simulate a dropped connection). `dropped` counts them, so
 * a test can wait until the events it caused really were lost (instead of sleeping and hoping they came already).
 */
export function gateRealtime(api: Api) {
  const state = { offline: false, dropped: 0 };
  intercept(
    api,
    "subscribeMessages",
    (original) => (roomId, fn) =>
      original(roomId, (action, rec) => {
        if (state.offline) state.dropped++;
        else fn(action, rec);
      }),
  );
  return state;
}

/** Ids of the message events the view's subscription has received (to wait for one deterministically). */
export function deliveries(api: Api) {
  const ids: string[] = [];
  intercept(
    api,
    "subscribeMessages",
    (original) => (roomId, fn) =>
      original(roomId, (action, rec) => {
        ids.push(rec.id);
        fn(action, rec);
      }),
  );
  return ids;
}

/** Capture the view's realtime message handler so tests can inject events directly. */
export function captureHandler(api: Api) {
  const handlers: ((action: Action, m: Message) => void)[] = [];
  intercept(api, "subscribeMessages", (original) => (roomId, fn) => {
    handlers.push(fn);
    return original(roomId, fn);
  });
  return handlers;
}
