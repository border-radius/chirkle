// The room's emoji picker, one for the composer and every message's reactions (§20), and the composer's suggestions:
// emoji by name (§20.6) and people by handle (§41). Each is a lazy chunk, loaded the first time it is needed.
// (In views/room.ts until REFACTOR item 53.)

import type { Api } from "../../api.ts";
import type { Scope } from "../../scope.ts";
import { avatar } from "../../ui/avatar.ts";
import type { EmojiPicker, PickerRequest } from "../../ui/emoji-picker.ts";
import type { EmojiSuggest } from "../../ui/emoji-suggest.ts";

export interface Pickers {
  /** The message the open picker reacts to ("": the composer's, or none). */
  readonly reactingTo: string;
  readonly isOpen: boolean;
  /**
   * Open the emoji picker next to `opener`, to react to message `reactingTo` ("" for the composer). If the chunk can't
   * be loaded (offline, or a new version was deployed), say so. Not if the opener went meanwhile.
   */
  open(opener: HTMLElement, req: PickerRequest, reactingTo?: string): Promise<void>;
  close(): void;
  /** Emoji by name in the composer: once loaded they follow the textarea. Quietly not, offline. */
  suggestEmoji(textarea: HTMLTextAreaElement): void;
  /** People by handle in the composer: once loaded it follows the textarea. Quietly not, offline. */
  suggestPeople(textarea: HTMLTextAreaElement): void;
}

export function createPickers({
  api,
  roomId,
  shell,
  scope,
  say,
}: {
  api: Api;
  roomId: () => string;
  /** Where the picker goes, once made. */
  shell: HTMLElement;
  scope: Scope;
  say: (text: string) => void;
}): Pickers {
  const { signal } = scope;
  let picker: EmojiPicker | null = null;
  let reactingTo = "";
  let suggest: EmojiSuggest | Promise<unknown> | null = null;
  let people = false;

  return {
    get reactingTo() {
      return reactingTo;
    },
    get isOpen() {
      return !!picker?.isOpen;
    },
    async open(opener, req, to = "") {
      reactingTo = to;
      try {
        const { createEmojiPicker, loadStylesheet } = await import("../../ui/emoji-picker.ts");
        await loadStylesheet();
        if (!scope.active || !opener.isConnected) return;
        if (!picker) {
          picker = createEmojiPicker({ signal });
          shell.append(picker.el);
        }
        picker.open(opener, req);
      } catch {
        if (scope.active) say("Couldn't open the emoji. Check your connection.");
      }
    },
    close() {
      picker?.close();
    },
    suggestEmoji(textarea) {
      suggest ??= import("../../ui/emoji-picker.ts").then(
        async ({ createEmojiSuggest, loadStylesheet }) => {
          await loadStylesheet();
          if (!scope.active) return;
          suggest = createEmojiSuggest({ textarea, signal });
          suggest.update(true);
        },
        () => {
          suggest = null;
        },
      );
    },
    suggestPeople(textarea) {
      if (people) return;
      people = true;
      void import("../../ui/mention-suggest.ts").then(
        ({ createMentionSuggest }) =>
          scope.active &&
          createMentionSuggest({ api, textarea, room: roomId, avatar: (u) => avatar(u, 24, api.avatarUrl), signal }).update(),
        () => {
          people = false;
        },
      );
    },
  };
}
