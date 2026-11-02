// Unread badge on the tab (§22.4): the favicon shows how many messages are unread across every room and DM that has
// a badge in the room list (§18.4), and the title starts with it, e.g. "(3) #general – Chirkle": the open room's name, then
// the site's title (§24).

import { roomTitle } from "./lib/rooms.ts";
import { type AppState, type Store, unreadCount } from "./store.ts";

/** Unread messages over every room with a badge. */
export function totalUnread(s: AppState): number {
  let n = 0;
  for (const r of s.rooms.values()) n += unreadCount(s, r);
  return n;
}

/** What the badge says: nothing for 0, "99+" past 99. */
export const badgeLabel = (n: number): string => (n <= 0 ? "" : n > 99 ? "99+" : String(n));

/** The app icon, a speech bubble (`web/public/icons/icon.svg`, which `index.html` names too): the favicon as it is. */
export const ICON = "/icons/icon.svg";
let icon: HTMLImageElement | undefined;

/** The icon with a red badge holding `label`, drawn on a canvas: a PNG data: URL. */
export async function badgedIcon(label: string): Promise<string> {
  icon ??= Object.assign(new Image(), { src: ICON });
  await icon.decode();
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d") as CanvasRenderingContext2D;
  g.scale(2, 2);
  g.drawImage(icon, 0, 0, 32, 32);
  // Wider for more digits; the text is the largest that fits.
  const w = label.length === 1 ? 20 : label.length === 2 ? 26 : 32;
  g.beginPath();
  g.roundRect(32 - w, 0, w, 20, 10);
  g.fillStyle = "#d1213b";
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = g.fillStyle = "#fff";
  g.stroke();
  g.font = `700 ${label.length === 3 ? 13 : 16}px Arial,Helvetica,sans-serif`;
  g.textAlign = "center";
  g.fillText(label, 32 - w / 2, 15);
  return c.toDataURL();
}

/** The tab's title: the unread count, the open room and the site's title, e.g. "(3) #general – Chirkle". */
export function tabTitle(s: AppState, label: string): string {
  const room = s.activeRoomId ? s.rooms.get(s.activeRoomId) : undefined;
  const title = room ? `${roomTitle(room, s.user)} – ${s.site.title}` : s.site.title;
  return label ? `(${label}) ${title}` : title;
}

/** Keep the favicon and the title in step with the unread counts. Returns a function that stops it. */
export function startFavicon(store: Store<AppState>, doc: Document = document): () => void {
  const title = doc.title;
  let shown: string | null = null;
  // Firefox ignores a new href on the icon's <link>, so each change puts in a fresh one, once its icon is drawn and
  // only if no newer count came in meanwhile. The count is on it as `data-badge` too.
  const setIcon = async (label: string) => {
    const href = label ? await badgedIcon(label).catch(() => ICON) : ICON;
    if (label !== shown) return;
    const link = doc.createElement("link");
    link.rel = "icon";
    link.href = href;
    link.dataset.badge = label;
    const old = doc.querySelector('link[rel="icon"]');
    old ? old.replaceWith(link) : doc.head.append(link);
  };
  const render = (s: AppState) => {
    const label = badgeLabel(totalUnread(s));
    if (label !== shown) {
      shown = label;
      void setIcon(label);
    }
    const t = tabTitle(s, label);
    if (doc.title !== t) doc.title = t;
  };
  render(store.get());
  const off = store.subscribe((s, prev) => {
    if (
      s.unread !== prev.unread ||
      s.rooms !== prev.rooms ||
      s.hidden !== prev.hidden ||
      s.activeRoomId !== prev.activeRoomId ||
      s.away !== prev.away ||
      s.site !== prev.site ||
      s.user !== prev.user
    )
      render(s);
  });
  return () => {
    off();
    doc.title = title;
    shown = "";
    void setIcon("");
  };
}
