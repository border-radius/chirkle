// A message's attachments (§17.5): image and video thumbnails that open the viewer (§17.7), audio players, download
// chips for other files, and a sending message's local previews. An image or video has a Save button (to a collection,
// §31), and one attached from a collection says which.

import { type Child, h } from "../../dom.ts";
import { attachmentName, isAudio, isGif, isMedia, isVideo } from "../../lib/files.ts";
import type { Badge, LocalFile, Message } from "../../lib/types.ts";
import { collectionIcon } from "../../ui/icon.ts";

/** Most image and video tiles a message shows; the last one says how many more there are, which the viewer shows. */
export const MAX_TILES = 4;

/** A message's attachments, or null without any. */
export type Attachments = ((m: Message) => HTMLElement | null) & {
  /** After the list is drawn: stop and forget the audio players no longer on the page (a deleted message's, say). */
  prune: () => void;
};

export function createAttachments(opts: {
  /** Signed URL of an attachment (§17.3). */
  fileUrl: (m: Message, filename: string, thumb?: string) => string;
  /** Signed URL of a video's poster frame (§30.1): 404 until the server has made one. */
  posterUrl: (m: Message, filename: string) => string;
  /** Get a new file token (an image failed to load, maybe because its token expired). */
  refreshFileToken: () => Promise<unknown>;
  /** A thumbnail was clicked: show the image or video in the viewer (§17.7). */
  onOpenImage: (m: Message, file: string, opener: HTMLElement) => void;
  /** How much of a sending message's attachments has been uploaded, 0 to 1 (§17.4). */
  uploadProgress: (id: string) => number;
  /** What the badge of a file from collection `id` says (§31); undefined until known. */
  badge?: (id: string) => Badge | undefined;
  /** Save to collection on a tile (§31): offer it next to `opener`. None for guests. */
  onSave?: (m: Message, file: string, opener: HTMLElement) => void;
  signal: AbortSignal;
}): Attachments {
  const { signal } = opts;
  /**
   * Aspect ratios of a sending message's image and video previews, so its tiles take their width before loading. A
   * message from the server says its files' own (`file_dims`); these cover the ones it doesn't know yet (a new video).
   */
  const sentRatios = new Map<string, string[]>();
  /** Audio players by message id and file, kept across renders so a new reaction or edit doesn't stop one playing. */
  const players = new Map<string, HTMLAudioElement>();
  /** Stops and forgets the players no longer on the page, or (unmounting) all of them. */
  const prune = (all?: unknown) =>
    players.forEach((el, key) => {
      if (all || !el.isConnected) {
        el.pause();
        players.delete(key);
      }
    });
  signal.addEventListener("abort", prune);
  const btn = (label: string, onClick: () => void) => h("button", { type: "button", on: { click: onClick }, signal }, label);

  /**
   * A message's attachments (§17.5): images and videos as uncropped thumbnails of a fixed height (1 large, or a row of
   * up to 4 small ones, the 4th saying "+N" when there are more), audio as a player under its download chip, other
   * files as download chips. A message not yet on
   * the server shows its local previews instead, and while it sends, how much of them has been uploaded.
   */
  function attachments(m: Message): HTMLElement | null {
    const local = m.localFiles ?? [];
    const names = m.files ?? [];
    if (!local.length && !names.length) return null;
    // Shown as an image or video only if the server will show it as one too, so nothing changes shape once it is sent.
    const shown = (f: LocalFile) => !!f.url && isMedia(f.file.name);
    const imageCount = local.length ? local.filter(shown).length : names.filter(isMedia).length;
    /** The last tile shown, when more are left out: it says how many. */
    const more = (tile: HTMLElement) => {
      if (images.childElementCount === MAX_TILES && imageCount > MAX_TILES) {
        tile.append(h("span", { class: "att-more" }, [`+${imageCount - MAX_TILES}`, h("span", { class: "visually-hidden" }, " more")]));
      }
    };
    const thumb = imageCount === 1 ? "800x480f" : "480x240f";
    const images = h("div", { class: `att-images ${imageCount === 1 ? "one" : "row"}` });
    const others = h("ul", { class: "att-files" });

    if (local.length) {
      for (const f of local) {
        if (!shown(f)) {
          others.append(h("li", {}, h("span", { class: "att-file i-file" }, f.file.name)));
          continue;
        }
        if (images.childElementCount === MAX_TILES) continue;
        const i = images.childElementCount;
        // An item from a collection (§31) shows its thumbnail (or a video's poster), never as a video.
        const el = f.item ? h("img", { src: f.url, alt: f.file.name, decoding: "async" }) : preview(f.file.name, f.url);
        el.addEventListener(
          el instanceof HTMLVideoElement ? "loadedmetadata" : "load",
          () => {
            const [w, ht] = el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : [el.naturalWidth, el.naturalHeight];
            if (!w || !ht) return;
            const ratios = sentRatios.get(m.id) ?? [];
            ratios[i] = `${w} / ${ht}`;
            sentRatios.set(m.id, ratios);
          },
          { signal },
        );
        const tile = h("span", { class: "att-tile" }, [el, playBadge(f.file.name)]);
        images.append(tile);
        more(tile);
      }
    } else {
      const ratios = sentRatios.get(m.id);
      for (const name of names) {
        if (isMedia(name)) {
          if (images.childElementCount === MAX_TILES) continue;
          const dims = m.file_dims?.[name];
          const ratio = ratios?.[images.childElementCount] ?? (dims ? `${dims[0]} / ${dims[1]}` : undefined);
          const tile = mediaTile(m, name, thumb, ratio);
          images.append(cell(m, name, tile));
          more(tile);
        } else {
          const chip = fileLink(m, name, "att-file i-file", [attachmentName(m, name)]);
          others.append(h("li", {}, isAudio(name) ? [chip, " ", player(m, name)] : chip));
        }
      }
    }
    const progress =
      local.length && m.status === "pending"
        ? h("progress", { class: "att-progress", max: "1", value: String(opts.uploadProgress(m.id)), "aria-label": "Uploading" })
        : null;
    return h("div", { class: "attachments" }, [
      images.childElementCount ? images : null,
      others.childElementCount ? others : null,
      progress,
    ]);
  }

  /**
   * A tile with what goes over it (§31): Save, and for a file attached from a collection its badge, a link to the
   * collection if you may see it, else "Private collection". A forward's files are its original's (§21.3).
   */
  function cell(m: Message, name: string, tile: HTMLElement): HTMLElement {
    const from = m.file_sources?.[name];
    const b = from ? opts.badge?.(from) : null;
    const { onSave } = opts;
    const save =
      onSave &&
      h(
        "button",
        {
          type: "button",
          class: "att-save",
          "aria-label": `Save ${attachmentName(m, name)} to collection`,
          title: "Save to collection",
          "aria-haspopup": "dialog",
          on: { click: () => onSave(m, name, save!) },
          signal,
        },
        collectionIcon(),
      );
    const badge =
      b &&
      ("private" in b
        ? h("span", { class: "att-src" }, [collectionIcon(), "Private collection"])
        : h("a", { class: "att-src", href: `/c/${from}`, title: `From the collection “${b.name}”` }, [
            collectionIcon(),
            h("span", {}, b.name),
            b.public ? null : h("span", { class: "ic i-lock", title: "Private" }, h("span", { class: "visually-hidden" }, " (private)")),
          ]));
    return h("span", { class: "att-cell" }, [tile, badge, save]);
  }

  /** A link to the full file, re-signed with the current token whenever it is about to be used. */
  function fileLink(m: Message, name: string, cls: string, children: Child[]): HTMLAnchorElement {
    const a = h(
      "a",
      { class: cls, href: opts.fileUrl(m, name), target: "_blank", rel: "noopener", download: attachmentName(m, name) },
      children,
    );
    const sign = () => (a.href = opts.fileUrl(m, name));
    for (const type of ["pointerenter", "focus", "click"] as const) a.addEventListener(type, sign, { signal });
    return a;
  }

  /**
   * An audio file's player. Its URL's token expires (§17.3), so playing or seeking long after it loaded fails: then it
   * gets a new token once and carries on where it was. A file it still can't load leaves the player's own error state.
   */
  function player(m: Message, name: string): HTMLAudioElement {
    const key = `${m.id}/${name}`;
    const kept = players.get(key);
    if (kept) return kept;
    const el = h("audio", { src: opts.fileUrl(m, name), controls: true, preload: "metadata", "aria-label": attachmentName(m, name) });
    let retried = false;
    el.addEventListener("loadedmetadata", () => (retried = false), { signal });
    el.addEventListener(
      "error",
      () => {
        if (retried) return;
        retried = true;
        const [t, playing] = [el.currentTime, !el.paused];
        void opts.refreshFileToken().then(() => {
          el.src = opts.fileUrl(m, name);
          el.currentTime = t;
          if (playing) void el.play().catch(() => {});
        });
      },
      { signal },
    );
    players.set(key, el);
    return el;
  }

  /**
   * What shows an image or video: an image as itself, a video as its first frame (the browser fetches just enough of
   * the file to draw it).
   */
  function preview(name: string, src: string): HTMLImageElement | HTMLVideoElement {
    return isVideo(name)
      ? h("video", { src: `${src}#t=0.001`, preload: "metadata", muted: true, playsinline: true })
      : h("img", { src, alt: name, decoding: "async" });
  }

  /** A video's tile shows a play badge over its first frame. */
  const playBadge = (name: string) => isVideo(name) && h("span", { class: "att-play", "aria-hidden": "true" }, "▶");

  /**
   * An image's thumbnail or a video's first frame: a click opens the viewer, a click that asks for a new tab or window
   * (or a middle click) gets the full file there. A video shows the poster the server made of it (§30.1), so the
   * browser fetches nothing of the video; without one (not made yet, no ffmpeg there) it shows the video's own first
   * frame. A failed load retries once with a new token, then offers Retry.
   */
  function mediaTile(m: Message, name: string, thumb: string, ratio?: string): HTMLElement {
    const video = isVideo(name);
    let poster = video;
    const src = () => (poster ? opts.posterUrl(m, name) : opts.fileUrl(m, name, video || isGif(name) ? undefined : thumb));
    let el = poster ? h("img", { src: src(), alt: attachmentName(m, name), decoding: "async" }) : preview(attachmentName(m, name), src());
    if (el instanceof HTMLImageElement) el.loading = "lazy";
    if (ratio) el.style.aspectRatio = ratio;
    const tile = fileLink(m, name, "att-tile", [el, playBadge(name)]);
    tile.removeAttribute("download"); // open images and videos in a tab rather than download them
    if (video) tile.setAttribute("aria-label", `${attachmentName(m, name)}, video`);
    tile.addEventListener(
      "click",
      (e) => {
        if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        opts.onOpenImage(m, name, tile);
      },
      { signal },
    );
    const load = () => (el.src = video && !poster ? `${src()}#t=0.001` : src());
    let retried = false;
    const failed = () => {
      // No poster: the video's first frame instead, as if there had never been one.
      if (poster) {
        poster = false;
        const was = el;
        el = preview(attachmentName(m, name), src());
        el.style.aspectRatio = was.style.aspectRatio;
        el.addEventListener("error", failed, { signal });
        was.replaceWith(el);
        return;
      }
      if (!retried) {
        retried = true;
        void opts.refreshFileToken().then(load, () => el.dispatchEvent(new Event("error")));
        return;
      }
      const broken = h("span", { class: "att-tile att-broken" }, [
        `Couldn't load ${video ? "video" : "image"} `,
        btn("Retry", () => {
          retried = false;
          broken.replaceWith(tile);
          load();
        }),
      ]);
      tile.replaceWith(broken);
    };
    el.addEventListener("error", failed, { signal });
    return tile;
  }

  return Object.assign(attachments, { prune: () => prune() });
}
