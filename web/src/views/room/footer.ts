// The bottom of a room: the composer, or, instead of it, the selection bar (§21), or a banner saying why there is none
// (archived, a guest §23.3, a reader §23.6, a DM that takes no messages §16.7). And the ways to the composer: the
// caret goes there on entering a room and on coming back to the window, Ctrl+/ anywhere (§7.6), and files dropped on
// the room are attached (§17.4). (In views/room.ts until REFACTOR item 53.)

import { h } from "../../dom.ts";
import { canPost, dmClosed, roomTitle } from "../../lib/rooms.ts";
import type { Room, User } from "../../lib/types.ts";
import type { Composer } from "./composer.ts";
import type { Selection } from "./selection.ts";

export interface Footer {
  readonly el: HTMLElement;
  /** The composer is shown (not a banner or the selection bar). */
  composing(): boolean;
  /** Show what fits the room now. `failed`: the room didn't load (no composer: you'd write into history you can't see). */
  render(failed: boolean): void;
  /** Put the caret in the composer when it is next shown: on entering the room (§22.5). */
  focusNext(): void;
  /** The listeners on the window and the room (`shell`), from mount on. */
  bind(shell: HTMLElement): void;
}

const noHover = () => matchMedia("(hover:none)").matches;

export function createFooter({
  composer,
  selection,
  room,
  me,
  closePicker,
  parked,
  active,
  signal,
}: {
  composer: Composer;
  selection: Selection;
  room: () => Room | undefined;
  me: () => User | null;
  /** Nothing left to insert into or react to. */
  closePicker: () => void;
  /** The room is kept out of the page (parking.ts): never focus it. */
  parked: () => boolean;
  active: () => boolean;
  signal: AbortSignal;
}): Footer {
  const el = h("footer", { class: "room-footer" });
  const banner = h("p", { class: "archived-banner ic i-archive" }, "This room is archived. History is read-only.");
  const guestBanner = h(
    "p",
    { class: "guest-banner ic i-globe" },
    // One flex item: the links stay in the sentence, not spaced apart by the banner's gap.
    h("span", {}, [
      "You're reading as a guest. ",
      h("a", { href: "/login" }, "Log in"),
      " or ",
      h("a", { href: "/signup" }, "sign up"),
      " to join the conversation.",
    ]),
  );
  const readerBanner = h(
    "p",
    { class: "guest-banner reader-banner ic i-lock" },
    "Only some people can post in this room. You can read along and react.",
  );
  const closedBanner = h("p", { class: "guest-banner reader-banner ic i-x" });
  let focusComposer = true;
  const composing = () => el.contains(composer.el);
  const show = (child: HTMLElement) => el.firstChild !== child && el.replaceChildren(child);

  return {
    el,
    composing,
    render(failed) {
      const r = room();
      // (The composer element, and anything typed into it, is kept for when the load succeeds.)
      if (!r || failed) return el.replaceChildren();
      if (selection.ids) {
        // The composer (and anything typed into it) comes back when selecting ends.
        selection.refresh();
        show(selection.bar);
        closePicker();
      } else if (r.archived) {
        el.replaceChildren(banner);
        closePicker();
      } else if (!me()) {
        show(guestBanner);
      } else if (!canPost(r, me())) {
        // A reader. What they had typed stays in the composer, for if they may post again.
        show(readerBanner);
      } else if (dmClosed(r, me())) {
        // Readable, but the server refuses what is sent (QA BUG-178). What was typed stays, as for a reader.
        closedBanner.textContent = dmClosed(r, me());
        show(closedBanner);
      } else show(composer.el);
      composer.setPlaceholder(`Message ${roomTitle(r, me())}`);
      // Entering a room (or switching to another one), you can just type. Not on touch screens: it would pop up the
      // keyboard over the messages you came to read.
      if (focusComposer && composing()) {
        focusComposer = false;
        // In the next frame, whose layout it then uses: focus() lays the page out at once, and on entering a room that
        // came in the middle of drawing it (PERF.md §5).
        if (!noHover()) requestAnimationFrame(() => active() && !parked() && composing() && composer.focus());
      }
    },
    focusNext() {
      focusComposer = true;
    },
    bind(shell) {
      // Coming back to the window: put the caret in the composer so you can just type. Only when nothing else has
      // focus (or a link does, e.g. an attachment opened in a new tab): never away from a field, menu or confirm you
      // were on. Not with text selected (you may be copying it), and not on touch screens (it pops up the keyboard).
      window.addEventListener(
        "focus",
        () =>
          !parked() &&
          composing() &&
          document.activeElement!.matches("body,a") &&
          getSelection()!.isCollapsed &&
          !noHover() &&
          composer.focus(),
        { signal },
      );
      // Ctrl+/ (⌘/ on a Mac) anywhere: to the composer, as its key badge says. By the key's place too, for layouts
      // where it types something else (Cyrillic: "."). Not for a room kept in the background, nor while there is no
      // composer (a banner instead); behind a modal dialog the composer is inert, so focus stays there.
      document.addEventListener(
        "keydown",
        (e) => {
          if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key !== "/" && e.code !== "Slash")) return;
          if (parked() || !composing()) return;
          e.preventDefault();
          composer.focus();
        },
        { signal },
      );
      // Files dropped anywhere on the room go to the composer.
      const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
      shell.addEventListener("dragover", (e) => hasFiles(e) && composing() && e.preventDefault(), { signal });
      shell.addEventListener(
        "drop",
        (e) => {
          if (!hasFiles(e) || !composing()) return;
          e.preventDefault();
          void composer.addFiles([...(e.dataTransfer?.files ?? [])]);
        },
        { signal },
      );
    },
  };
}
