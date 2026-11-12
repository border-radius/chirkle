// A room's images and videos: the viewer (§17.7), opened from a thumbnail or from the media grid, and the grid (§30).
// Both are lazy chunks; both are told of the messages that change or go while they are open.
// (In views/room.ts until REFACTOR item 53.)

import type { Api } from "../../api.ts";
import { newer, older, PAGE_SIZE, withFiles } from "../../lib/cursor.ts";
import { attachmentName, isMedia, isVideo } from "../../lib/files.ts";
import type { MessageWindow } from "../../lib/messages.ts";
import { formatFull, parsePb } from "../../lib/time.ts";
import type { Message, Room } from "../../lib/types.ts";
import type { Scope } from "../../scope.ts";
import type { ViewerImage } from "./viewer.ts";

/** What the viewer and the grid use of the room view. */
export interface GalleryHost {
  api: Api;
  roomId: () => string;
  room: () => Room | undefined;
  /** The message window: the viewer starts with its images. */
  win: () => MessageWindow;
  /** "Show in chat": go to the message, as the user's own action. */
  goTo: (id: string) => Promise<void>;
  /** The save menu for a file, which the viewer offers to whoever is signed in (`signedIn`). */
  saveFile: (m: Message, file: string, opener: HTMLElement) => void;
  signedIn: () => boolean;
  /** Ends when the room is left (parked or unmounted): the viewer and the grid close with it. */
  screen: () => AbortSignal;
  scope: Scope;
  say: (text: string) => void;
}

export interface Gallery {
  /**
   * A thumbnail was clicked: show it in the viewer with the room's other images and videos, oldest first: the
   * window's to start with; the viewer fetches the others when it gets near them. The viewer is loaded on the first
   * click; if it can't be (offline, or a new version was deployed), the file opens in a new tab, as a thumbnail did
   * before the viewer. From the grid: its `images` and `more`, and `leave` closes it on "Show in chat".
   */
  view(m: Message, file: string, opener: HTMLElement, images?: ViewerImage[], more?: [boolean, boolean], leave?: () => void): Promise<void>;
  /** The room's images and videos as a grid; it opens the viewer with `view`. */
  openGrid(): void;
  /** A message changed or went (live): the open viewer and grid follow it. */
  changed(m: Message, gone: boolean): void;
}

const media = (x: Message) => (x.files ?? []).filter(isMedia).map((f) => ({ message: x, file: f, video: isVideo(f) }));

export function createGallery({ api, roomId, room, win, goTo, saveFile, signedIn, screen, scope, say }: GalleryHost): Gallery {
  /** Tells the open viewer that a message changed or went. */
  let viewing: ((m: Message, gone: boolean) => void) | undefined;
  /** And the open grid. */
  let gridding: ((m: Message, gone: boolean) => void) | undefined;

  async function view(
    m: Message,
    file: string,
    opener: HTMLElement,
    images?: ViewerImage[],
    more?: [boolean, boolean],
    leave?: () => void,
  ) {
    const w = win();
    images ??= w.items.flatMap((x) => (x.deleted || x.localFiles?.length ? [] : media(x)));
    const id = roomId();
    const start = images.findIndex((i) => i.message.id === m.id && i.file === file);
    try {
      const { openViewer } = await import("./viewer.ts");
      if (!scope.active) return;
      await openViewer({
        images,
        start,
        more: more ?? [w.hasOlder, w.hasNewer],
        page: async (back, edge) => {
          const messages = await api.page(withFiles(back ? older(id, edge) : newer(id, edge)), scope.signal);
          return { messages: back ? messages.reverse() : messages, done: messages.length < PAGE_SIZE };
        },
        media,
        name: attachmentName,
        when: (x) => formatFull(parsePb(x.created)),
        fileUrl: api.fileUrl,
        onJump: (x) => {
          leave?.();
          return goTo(x.id);
        },
        ...(signedIn() ? { onSave: saveFile } : {}),
        opener,
        follow: (fn) => (viewing = fn),
        signal: screen(),
      });
    } catch {
      if (scope.active) window.open(api.fileUrl(m, file), "_blank", "noopener");
    }
  }

  return {
    view,
    openGrid() {
      import("./media.ts").then(
        (g) =>
          scope.active &&
          g.openMedia({
            room: roomId(),
            label: room()?.kind === "dm" ? "" : room()?.name,
            api,
            name: attachmentName,
            open: view,
            follow: (fn) => (gridding = fn),
            signal: screen(),
          }),
        () => scope.active && say("Couldn't open media. Check your connection."),
      );
    },
    changed(m, gone) {
      viewing?.(m, gone);
      gridding?.(m, gone);
    },
  };
}
