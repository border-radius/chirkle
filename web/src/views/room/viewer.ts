// Image viewer (§17.7): a room's images full size (and its videos, played), one at a time, stepping back and forth
// with the buttons, the arrow keys or a swipe, through the whole room's. A modal <dialog> over the whole window: it
// keeps focus inside, Escape closes it, and focus goes back to the thumbnail it was opened from. It adds a history entry (same URL), so Back closes it rather than leaving
// the room.
//
// A lazy chunk: the room view import()s it on the first click on a thumbnail, and it links its own stylesheet. It
// imports types only. Any module it shared with app.js would become a chunk that app.js loads on every page, so
// build.mjs refuses that: what it needs from app.js (the DOM helper, names, dates, signed URLs) comes in its options.

import type { h } from "../../dom.ts";
import type { Message } from "../../lib/types.ts";

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const VIEWER_CSS: string;

/** One image or video: a stored file of a message. */
export interface ViewerImage {
  message: Message;
  file: string;
  /** Played in a <video> rather than shown as an image. */
  video?: boolean;
}

export interface ViewerOptions {
  /** The images and videos to start with (the room's window), oldest first. More are fetched on the way. */
  images: readonly ViewerImage[];
  /** Which of them to show first. */
  start: number;
  /** The room has messages before (`[0]`) and after (`[1]`) the ones `images` come from. */
  more: [boolean, boolean];
  /**
   * A page of the room's messages with files just before (`older`) or after `edge`, oldest first. `done`: there are
   * none beyond them.
   */
  page: (older: boolean, edge: Message) => Promise<{ messages: Message[]; done: boolean }>;
  /** A message's images and videos. */
  media: (m: Message) => ViewerImage[];
  h: typeof h;
  /** What to call a file (`attachmentName`). */
  name: (m: Message, file: string) => string;
  /** When a message was sent, for the caption. */
  when: (m: Message) => string;
  /** Signed URL of the full file (§17.3). */
  fileUrl: (m: Message, file: string) => string;
  /** Get a new file token (an image failed to load, maybe because its token expired). */
  refreshFileToken: () => Promise<unknown>;
  /**
   * Show in chat: go to this message in the room (the viewer has closed). Its tile gets focus once it's there. None
   * for a collection's items (§31).
   */
  onJump?: (m: Message) => Promise<unknown>;
  /** Save to collection (§31): offer it for the one shown, next to the button. None for guests. */
  onSave?: (m: Message, file: string, opener: HTMLElement) => void;
  /** Gets focus back on close. */
  opener: HTMLElement;
  /** Gets the function to call when one of the room's messages changes or goes (`gone`: deleted for good). */
  follow: (fn: (m: Message, gone: boolean) => void) => void;
  /** Closes the viewer (the room view unmounts). */
  signal: AbortSignal;
}

/** Fetch the room's images beyond the ones here when this close (in images) to the first or last one. */
const FETCH_AHEAD = 3;

/** A horizontal move at least this long (px), and mostly horizontal, is a swipe to the next or previous image. */
const SWIPE_PX = 50;

/**
 * Marks the history entry the viewer adds. New on every page load, so an entry left over from before a reload (where
 * no viewer is open) isn't taken for one.
 */
const ENTRY = `viewer-${Date.now()}-${Math.random()}`;
const onEntry = () => (history.state as { viewer?: unknown } | null)?.viewer === ENTRY;

let stylesheet: Promise<void> | null = null;
/**
 * A viewer closed from itself went Back off its entry, and the browser hasn't got there yet: a viewer opened again
 * meanwhile waits for it, or that Back would close it.
 */
let leaving: Promise<unknown> | null = null;
/** The open viewer: opening another one closes it (and takes over its history entry). */
let current: ((back?: boolean) => void) | null = null;

/** Loaded once; a failed load is tried again next time, and the viewer opens anyway (unstyled but usable). */
function loadStylesheet(h: ViewerOptions["h"]): Promise<void> {
  stylesheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      stylesheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: VIEWER_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return stylesheet;
}

export async function openViewer(o: ViewerOptions): Promise<void> {
  const { h, images } = o;
  current?.();
  if (o.signal.aborted || !images[o.start]) return;
  const scope = new AbortController();
  const { signal } = scope;

  const title = h("h2", { id: "viewer-title" });
  const meta = h("p", { class: "viewer-meta" });
  const count = h("span", { class: "viewer-count" });
  const button = (cls: string, label: string, glyph: string, onClick: () => void, autofocus?: boolean) =>
    h(
      "button",
      { type: "button", class: `viewer-button ${cls}`, "aria-label": label, title: label, autofocus, on: { click: onClick }, signal },
      glyph,
    );
  const download = h("a", { class: "viewer-button", "aria-label": "Download", title: "Download" }, "↓");
  const closeButton = button("", "Close", "×", () => close(true), true);
  // The eye icon is drawn in CSS.
  const { onJump, onSave } = o;
  const jump =
    onJump &&
    button("viewer-jump", "Show in chat", "", () => {
      const at = shown();
      close(true, false);
      void onJump(at.message).then(() => !o.signal.aborted && tile(at)?.focus({ preventScroll: true }));
    });
  const save = onSave && button("", "Save to collection", "", () => onSave(shown().message, shown().file, save!));
  save?.append(h("span", { class: "ci", "aria-hidden": "true" }));
  const prev = button("viewer-prev", "Previous image", "‹", () => void go(-1));
  const next = button("viewer-next", "Next image", "›", () => void go(1));
  // Not draggable: Firefox (which has no -webkit-user-drag) would drag the image away instead of swiping.
  // What you are waiting for: ahead of thumbnails still loading in the list (PERF.md §5).
  const img = h("img", { alt: "", decoding: "async", draggable: "false", fetchpriority: "high" });
  const video = h("video", { controls: true, playsinline: true, preload: "auto", hidden: true });
  const failureText = h("span");
  const failure = h("p", { class: "viewer-error", hidden: true }, [
    failureText,
    h("button", { type: "button", class: "link", on: { click: () => load() }, signal }, "Retry"),
  ]);
  const stage = h("div", { class: "viewer-stage" }, [img, video, failure, prev, next]);
  const dialog = h("dialog", { class: "viewer", "aria-labelledby": title.id }, [
    h("header", { class: "viewer-bar" }, [
      h("div", { class: "viewer-caption", "aria-live": "polite" }, [title, meta]),
      count,
      save,
      jump,
      download,
      closeButton,
    ]),
    stage,
  ]);

  /** What can be stepped through: `images`, and what has been fetched beyond them. */
  const list = [...images];
  /** Per side (older, newer): the room may have more images or videos there. */
  const more = [...o.more];
  const fetching: (Promise<void> | null)[] = [null, null];
  let index = o.start;
  /** The shown image failed once already: the next failure is final (until Retry). */
  let retried = false;
  let closed = false;

  /**
   * `back`: closed from the viewer itself (Close, Escape, a click beside the image), so also leave its history entry,
   * and Back goes where it went before. Not when Back closed it, and not when leaving the room: that would undo the
   * navigation. `refocus`: put focus back on the thumbnail (not when going to the message: that focuses its own).
   */
  function close(back = false, refocus = true) {
    if (closed) return;
    closed = true;
    scope.abort();
    if (dialog.open) dialog.close();
    dialog.remove();
    img.removeAttribute("src"); // stop a download in progress
    stopVideo();
    if (current === close) current = null;
    // The thumbnail it was opened from, or the one drawn in its place since (a reaction or an edit redraws the message).
    if (refocus) (o.opener.isConnected ? o.opener : tile(images[o.start]!))?.focus();
    if (back && onEntry()) {
      leaving = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
      history.back();
    }
  }
  current = close;
  o.signal.addEventListener("abort", () => close(), { signal });

  const shown = () => list[index]!;
  /** An image's tile in the room's list (a tile that failed to load is a span, counted so the others keep their place). */
  const tile = ({ message: m, file }: ViewerImage) =>
    document.querySelectorAll<HTMLElement>(`li.msg[data-id="${CSS.escape(m.id)}"] .att-tile`)[o.media(m).findIndex((i) => i.file === file)];

  function show(i: number) {
    index = i;
    const { message: m, file } = shown();
    const name = o.name(m, file);
    title.textContent = name;
    meta.textContent = m.author ? `${m.expand?.author?.name ?? "Unknown"} · ${o.when(m)}` : o.when(m);
    download.download = name;
    sign();
    update();
    load();
    // The neighbouring images, so stepping to them is instant (not videos: they load when shown).
    for (const n of [list[i - 1], list[i + 1]]) if (n && !n.video) new Image().src = o.fileUrl(n.message, n.file);
    // Close to an end of what is here: fetch what is beyond it, so stepping on doesn't wait.
    if (i < FETCH_AHEAD) void fetchMore(0);
    if (i >= list.length - FETCH_AHEAD) void fetchMore(1);
  }

  /** The count and the step buttons. The count shows once the whole room's are here. */
  function update() {
    count.textContent = list.length > 1 && !more[0] && !more[1] ? `${index + 1} / ${list.length}` : "";
    // A step button that goes away at the first or last image hands focus to the other one.
    const focused = document.activeElement;
    prev.hidden = index === 0 && !more[0];
    next.hidden = index === list.length - 1 && !more[1];
    if (focused === prev && prev.hidden) (next.hidden ? closeButton : next).focus();
    if (focused === next && next.hidden) (prev.hidden ? closeButton : prev).focus();
  }

  /**
   * The room's images and videos beyond the first (side 0) or last (side 1) one here, from the server: pages of
   * messages with files until one has some (or there are no more). A failure leaves `more` set: stepping there tries
   * again.
   */
  function fetchMore(side: 0 | 1): Promise<void> {
    if (!more[side]) return Promise.resolve();
    fetching[side] ??= (async () => {
      let edge = (side ? list.at(-1)! : list[0]!).message;
      try {
        for (;;) {
          const { messages, done } = await o.page(!side, edge);
          if (closed) return;
          const found = messages.flatMap(o.media);
          if (done) more[side] = false;
          if (side) list.push(...found);
          else {
            list.unshift(...found);
            index += found.length;
          }
          if (found.length || done) break;
          edge = (side ? messages.at(-1) : messages[0])!;
        }
      } catch {
        // offline, say: stepping there tries again
      } finally {
        fetching[side] = null;
      }
      if (!closed) update();
    })();
    return fetching[side];
  }

  function load() {
    const { message: m, file, video: isVideo } = shown();
    retried = false;
    failure.hidden = true;
    stage.classList.add("loading");
    img.hidden = !!isVideo;
    video.hidden = !isVideo;
    if (isVideo) {
      img.removeAttribute("src");
      video.setAttribute("aria-label", o.name(m, file));
      video.src = o.fileUrl(m, file);
      // Autoplay with sound may be refused (no click on the page yet): the controls are there to start it.
      video.play().catch(() => {});
    } else {
      stopVideo();
      img.alt = o.name(m, file);
      img.src = o.fileUrl(m, file);
    }
  }

  function stopVideo() {
    if (!video.getAttribute("src")) return;
    video.pause();
    video.removeAttribute("src");
    video.load(); // drop the download in progress
  }

  function failed() {
    stage.classList.remove("loading");
    img.hidden = true;
    video.hidden = true;
    failureText.textContent = shown().video ? "Couldn't play video. " : "Couldn't load image. ";
    failure.hidden = false;
  }

  /**
   * A message changed: its images and videos it no longer has (deleted, or a forward whose original was) leave the
   * list. Shown, the next one (else the one before) shows instead; none left, the viewer closes (QA BUG-120).
   */
  o.follow((m, gone) => {
    if (closed) return;
    const has = new Set(gone || m.deleted ? [] : o.media(m).map((i) => i.file));
    const out = (i: ViewerImage) => i.message.id === m.id && !has.has(i.file);
    if (!list.some(out)) return;
    const at = shown();
    const before = list.slice(0, index).filter(out).length;
    const left = list.filter((i) => !out(i));
    list.splice(0, list.length, ...left);
    if (!list.length) return close(true);
    if (list.includes(at)) {
      index = list.indexOf(at);
      update();
    } else show(Math.min(index - before, list.length - 1));
  });

  /** One step back or on, waiting for the ones beyond what is here if need be. */
  async function go(step: number) {
    if (!list[index + step]) {
      const from = shown();
      await fetchMore(step < 0 ? 0 : 1);
      if (closed || shown() !== from) return;
    }
    if (list[index + step]) show(index + step);
  }
  /** The download link gets a fresh token whenever it is about to be used. */
  const sign = () => (download.href = o.fileUrl(shown().message, shown().file));

  img.addEventListener("load", () => stage.classList.remove("loading"), { signal });
  video.addEventListener("loadeddata", () => stage.classList.remove("loading"), { signal });
  // A video's token can expire while it plays (the browser fetches it in ranges): carry on with a new one from where
  // it was.
  video.addEventListener(
    "error",
    () => {
      if (!video.getAttribute("src")) return;
      if (retried) return failed();
      const at = shown();
      const time = video.currentTime;
      const playing = !video.paused;
      void o.refreshFileToken().then(
        () => {
          if (at !== shown() || closed) return;
          retried = true;
          video.src = o.fileUrl(shown().message, shown().file);
          video.currentTime = time;
          if (playing) video.play().catch(() => {});
        },
        () => at === shown() && failed(),
      );
    },
    { signal },
  );
  img.addEventListener(
    "error",
    () => {
      if (!img.getAttribute("src")) return;
      if (retried) return failed();
      const at = shown();
      void o.refreshFileToken().then(
        () => {
          if (at !== shown() || closed) return;
          retried = true;
          img.src = o.fileUrl(shown().message, shown().file);
        },
        () => at === shown() && failed(),
      );
    },
    { signal },
  );
  for (const type of ["pointerenter", "focus", "click"] as const) download.addEventListener(type, sign, { signal });

  // Escape (the dialog's own cancel) and anything else that closes it.
  dialog.addEventListener("close", () => close(true), { signal });
  document.addEventListener(
    "keydown",
    (e) => {
      // Not before it shows (its stylesheet is still loading): the keys are still the page's. Nor on the video, whose
      // own arrow keys seek.
      if (!dialog.open || e.target === video || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const steps: Record<string, () => unknown> = {
        ArrowLeft: () => go(-1),
        ArrowRight: () => go(1),
        Home: () => index && show(0),
        End: () => index < list.length - 1 && show(list.length - 1),
      };
      const step = steps[e.key];
      if (!step) return;
      e.preventDefault();
      step();
    },
    { signal },
  );

  // Swipe with one finger (pinching to zoom uses two); a click on the dark space around the image closes.
  let swipe: { x: number; y: number } | null = null;
  let swiped = false;
  // Not on a video: dragging along its seek bar isn't a swipe.
  stage.addEventListener("pointerdown", (e) => (swipe = e.isPrimary && e.target !== video ? { x: e.clientX, y: e.clientY } : null), {
    signal,
  });
  stage.addEventListener("pointercancel", () => (swipe = null), { signal });
  stage.addEventListener(
    "pointerup",
    (e) => {
      if (!swipe || !e.isPrimary) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      swiped = Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 2 * Math.abs(dy);
      if (swiped) void go(dx < 0 ? 1 : -1);
    },
    { signal },
  );
  stage.addEventListener(
    "click",
    (e) => {
      if (e.target === stage && !swiped) close(true);
      swiped = false;
    },
    { signal },
  );

  show(index);
  await Promise.all([loadStylesheet(h), leaving]);
  if (closed) return;
  if (!onEntry()) history.pushState({ viewer: ENTRY }, "");
  // Back (or Android's back gesture) left the viewer's entry: the URL is the room's either way, so the router sees nothing.
  window.addEventListener("popstate", () => !onEntry() && close(), { signal });
  document.body.append(dialog);
  dialog.showModal();
}
