// Reactions on a message (§20.3): a chip per emoji with how many reacted and who, and the buttons that open the emoji
// picker to add one. What reacting *does* is up to the room view; the buttons have no listeners of their own: the message
// list handles their clicks by their `data-act` (messages.ts, PERF.md §5).

import { h } from "../../dom.ts";
import type { Reaction } from "../../lib/types.ts";

/** A reaction as shown: with who reacted, in words. */
export type ShownReaction = Reaction & { who: string };

/** Where focus goes in a message after its reactions change: the reaction, else the buttons that add one. */
export const reactionFocus = (emoji: string): readonly string[] => [
  `.reactions [data-emoji="${CSS.escape(emoji)}"]`,
  ".reactions .add-reaction",
  ".actions .react",
];

/**
 * "Add reaction", with class `cls` (also its `data-act`): opens the emoji picker for a reaction to its message. The
 * picker says whether it is open (`aria-expanded`).
 */
export function addReactionButton(cls: string): HTMLButtonElement {
  const label = "Add reaction";
  return h("button", {
    type: "button",
    class: `${cls} ic i-react`,
    title: label,
    "aria-label": label,
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    dataset: { act: cls },
  });
}

/**
 * The emoji people reacted with, each with how many (§20.3). Where I can react, each one is a toggle for mine
 * (`data-act="reaction"`, `aria-pressed`), and a last button adds another; otherwise (an archived room) they only show.
 */
export function reactionRow(reactions: readonly ShownReaction[], reactable: boolean, me: string): HTMLElement {
  const chips = reactions.map((r) => {
    const mine = r.users.includes(me);
    const n = r.users.length;
    const content = [h("span", { class: "reaction-emoji" }, r.emoji), h("span", { class: "reaction-count" }, String(n))];
    const attrs = { class: `reaction${mine ? " mine" : ""}`, title: `${r.who} reacted with ${r.emoji}`, dataset: { emoji: r.emoji } };
    if (!reactable) return h("span", attrs, content);
    return h(
      "button",
      {
        ...attrs,
        dataset: { emoji: r.emoji, act: "reaction" },
        type: "button",
        "aria-pressed": String(mine),
        "aria-label": `${r.emoji} ${n} ${n === 1 ? "reaction" : "reactions"}`,
      },
      content,
    );
  });
  return h("div", { class: "reactions", role: "group", "aria-label": "Reactions" }, [
    ...chips,
    reactable ? addReactionButton("add-reaction") : null,
  ]);
}
