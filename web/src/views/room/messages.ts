// The message list DOM (§7.5, §7.6.1, §7.6.2): renders a MessageWindow with author groups and day dividers,
// reusing each message's element until something it shows changes. Owns the per-message UI state (edit box,
// delete confirm, inline errors), shows reactions (§20.3, reactions.ts), attachments (§17.5, attachments.ts) and which
// messages are selected (§21.1); what those buttons *do* is up to the room view.

import { h, reconcile } from "../../dom.ts";
import { linkify } from "../../lib/links.ts";
import { emptyForward, type MessageWindow, quoteText, startsGroup } from "../../lib/messages.ts";
import { reactors } from "../../lib/reactions.ts";
import { captureAnchor, restoreAnchor } from "../../lib/scroll.ts";
import { dayLabel, formatFull, formatTime, parsePb } from "../../lib/time.ts";
import type { Badge, LinkPreview, Message, Quoted, Reaction, User } from "../../lib/types.ts";
import { type AvatarUrl, avatar } from "../../ui/avatar.ts";
import { createActionMenu } from "../../ui/menu.ts";
import { createAttachments } from "./attachments.ts";
import { composing, editProblem, fitRows, rowsFor } from "./composer.ts";
import { createReactionParts, reactionFocus } from "./reactions.ts";

export interface MsgError {
  text: string;
  retry: () => void;
}

/** What to render, read fresh on every render. */
export interface ListState {
  win: MessageWindow;
  /** The first load is done (until then, no "beginning of the room" marker). */
  ready: boolean;
  /** The first load failed: show an error with Retry instead of the (empty) window. */
  failed: boolean;
  /** Text of the "beginning of the room" marker. */
  beginning: string;
  /** Highlighted message (/r/:id/m/:msgId). */
  targetId: string | null;
  /** The first unread message: a "New" line goes over it (§18.5). */
  unreadId: string | null;
  /** The selected messages while selecting (§21.1), else null. */
  selected: ReadonlySet<string> | null;
}

export interface MessageList {
  readonly el: HTMLOListElement;
  readonly topSentinel: HTMLElement;
  readonly bottomSentinel: HTMLElement;
  /** `anchor`: keep the message at the top of the viewport in place (content changed above it). */
  render(opts?: { anchor?: boolean }): void;
  startEdit(id: string): void;
  /** Close the edit box (no render). */
  stopEdit(): void;
  /** Show or clear an inline error under a message (no render). */
  setError(id: string, error: MsgError | null): void;
  /**
   * Focus the first of `selectors` found in message `id`: now, or after the next render (`later`), since a
   * message's element is rebuilt when what it shows changes.
   */
  focusIn(id: string, selectors: readonly string[], later?: boolean): void;
  /** A sending message's attachments are this far uploaded, 0 to 1 (§17.4): its progress bar moves (no render). */
  setUpload(id: string, fraction: number): void;
}

/** At most this many characters of a quote are in its accessible name. */
const QUOTE_SPOKEN = 80;

const byId = (id: string) => `li.msg[data-id="${CSS.escape(id)}"]`;

export function createMessageList(opts: {
  state: () => ListState;
  me: () => User | null;
  /** Does the message get an Edit button? */
  editable: (m: Message) => boolean;
  /** Does the message get a Delete button? */
  deletable: (m: Message) => boolean;
  /** Does the message get a Reply button? (§19) */
  repliable: (m: Message) => boolean;
  /** Reply on a message. */
  onReply: (id: string) => void;
  /** Can the message be selected (and forwarded)? (§21) */
  selectable: (m: Message) => boolean;
  /** Select or unselect a message; the first one starts selecting. */
  onSelect: (id: string) => void;
  /** Forward on a message. */
  onForward: (id: string) => void;
  /** Can I react to the message? (§20) */
  reactable: (m: Message) => boolean;
  /** The message's reactions as they should show (with my changes on their way). */
  reactions: (m: Message) => readonly Reaction[];
  /** A reaction chip was clicked: add (`on`) or take back my `emoji`. */
  onReact: (id: string, emoji: string, on: boolean) => void;
  /** React (or a reactions row's +) was clicked: offer the emoji picker next to `opener`. */
  onPickReaction: (id: string, opener: HTMLElement) => void;
  /** The name of someone not in the window (who reacted), if known yet. */
  nameOf: (userId: string) => string | undefined;
  /** A reply's quote was clicked: show the message it answers. */
  onOpenQuote: (id: string) => void;
  onSaveEdit: (id: string, text: string) => void;
  /** Escape in the edit box (after it has closed). */
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  onRetrySend: (id: string) => void;
  onDiscard: (id: string) => void;
  /** Retry button of a failed first load. */
  onRetryLoad: () => void;
  avatarUrl: AvatarUrl;
  /** "Message" in an author's menu (§16.5). */
  onMessageUser: (userId: string) => void;
  /** Signed URL of an attachment (§17.3). */
  fileUrl: (m: Message, filename: string, thumb?: string) => string;
  /** Signed URL of a video's poster frame (§30.1). */
  posterUrl: (m: Message, filename: string) => string;
  /** Get a new file token (an image failed to load, maybe because its token expired). */
  refreshFileToken: () => Promise<unknown>;
  /** A thumbnail was clicked: show the image or video in the viewer (§17.7). */
  onOpenImage: (m: Message, file: string, opener: HTMLElement) => void;
  /** What the badge of a file from collection `id` says (§31); undefined until known. */
  badge?: (id: string) => Badge | undefined;
  /** Save to collection on a tile (§31). */
  onSave?: (m: Message, file: string, opener: HTMLElement) => void;
  signal: AbortSignal;
}): MessageList {
  const { signal } = opts;
  const el = h("ol", { class: "messages", "aria-live": "polite", "aria-busy": "true", "aria-label": "Messages" });
  const topSentinel = h("li", { class: "sentinel", dataset: { sentinel: "top" }, "aria-hidden": "true" });
  const bottomSentinel = h("li", { class: "sentinel", dataset: { sentinel: "bottom" }, "aria-hidden": "true" });
  const beginning = h("li", { class: "beginning" });
  const newLine = h("li", { class: "new-line" }, h("span", {}, "New"));
  const loadError = h("li", { class: "load-error", role: "alert" }, [
    "Couldn't load this room. Check your connection. ",
    h("button", { type: "button", class: "link", on: { click: () => opts.onRetryLoad() }, signal }, "Retry"),
  ]);

  // Day dividers ("Today") and time-only stamps depend on the current date: redraw when it changes.
  let midnight: ReturnType<typeof setTimeout> | undefined;
  const scheduleMidnight = () => {
    const next = new Date();
    next.setHours(24, 0, 1, 0);
    midnight = setTimeout(() => {
      render({ anchor: true });
      scheduleMidnight();
    }, next.getTime() - Date.now());
  };
  scheduleMidnight();
  signal.addEventListener("abort", () => clearTimeout(midnight), { once: true });

  // Selecting (§21.1): a click anywhere on a message selects it, rather than following a link or pressing a button.
  el.addEventListener(
    "click",
    (e) => {
      const t = e.target as Element;
      const li = opts.state().selected && !t.matches("input.select") ? t.closest<HTMLElement>("li.msg") : null;
      if (!li?.querySelector("input.select")) return;
      e.preventDefault();
      e.stopPropagation();
      // Focus would stay on the page itself (the message isn't focusable), out of reach of Escape (§21.1).
      focusAfter = { id: li.dataset.id!, selector: "input.select" };
      opts.onSelect(li.dataset.id!);
    },
    { capture: true, signal },
  );

  // Touch screens have no hover: tapping a message shows its actions (like hovering it does), tapping it again or
  // anywhere else hides them. Taps on its links and buttons don't count, but pressing an action hides them. A message
  // without actions (deleted, read-only room…) doesn't light up.
  let touched: string | null = null;
  const touch = (li: HTMLElement | null) => {
    if (touched) el.querySelector(`li.msg[data-id="${CSS.escape(touched)}"]`)?.classList.remove("touched");
    touched = li?.dataset.id ?? null;
    if (!li) return;
    li.classList.add("touched");
    // The buttons show below it: on the last message they would be under the composer.
    li.scrollIntoView({ block: "nearest" });
  };
  document.addEventListener(
    "click",
    (e) => {
      if ((!touched && !matchMedia("(hover:none)").matches) || opts.state().selected) return;
      const t = e.target as Element;
      const li = t.closest<HTMLElement>("li.msg");
      if (!li || !el.contains(li) || t.closest(".actions button")) return touch(null);
      const open = li.dataset.id === touched;
      if (t.closest("a, button, input, textarea, summary, label, [contenteditable]")) return open || touch(null);
      touch(open || !li.querySelector(".actions") ? null : li);
    },
    // Before the tapped button's own handler, which may redraw the message (a reaction chip) and take it off the page.
    { capture: true, signal },
  );

  /**
   * Each timestamp parsed and formatted once: every change redraws the whole window, and this was most of its cost.
   * Keyed by `created`; the stamps depend on today's date (time only for today), so a new day starts afresh.
   */
  let times = new Map<string, { ms: number; day: string; time: string }>();
  let timesDay = "";
  const timeOf = (created: string) => {
    let t = times.get(created);
    if (!t) {
      const ms = parsePb(created);
      t = { ms, day: new Date(ms).toDateString(), time: formatTime(ms) };
      times.set(created, t);
    }
    return t;
  };

  let editing: string | null = null;
  /**
   * What is typed in the open edit box, once it differs from the message (null: not yet). The box is rebuilt whenever
   * its message is redrawn (a highlight fading, the quoted message edited…), and must keep it (QA BUG-43).
   */
  let editText: string | null = null;
  let confirmDelete: string | null = null;
  const errors = new Map<string, MsgError>();
  const cache = new Map<string, { sig: string; el: HTMLElement }>();
  const dividers = new Map<string, HTMLElement>();
  /** Focus to apply after the next render: message elements are rebuilt when they change. The first selector found wins. */
  let focusAfter: { id: string; selector: string | readonly string[]; caretToEnd?: boolean } | null = null;
  /** Names of the people in the window, for who reacted (rebuilt every render). */
  let names = new Map<string, string>();

  /** Upload progress of sending messages, by id. */
  const uploads = new Map<string, number>();
  const attachments = createAttachments({ ...opts, uploadProgress: (id) => uploads.get(id) ?? 0 });
  const reactionParts = createReactionParts(opts);

  const btn = (label: string, onClick: () => void, cls?: string) =>
    h("button", { type: "button", ...(cls ? { class: cls } : {}), on: { click: onClick }, signal }, label);
  /** A button of the message toolbar: an icon, named by its label. */
  const tool = (label: string, onClick: () => void, cls: string, icon: string) =>
    h("button", { type: "button", class: `${cls} ic ${icon}`, "aria-label": label, title: label, on: { click: onClick }, signal });

  function askDelete(id: string) {
    confirmDelete = id;
    focusAfter = { id, selector: ".confirm .cancel" };
    render();
  }

  function cancelDelete(id: string) {
    confirmDelete = null;
    focusAfter = { id, selector: ".actions .delete" };
    render();
  }

  function editBox(m: Message): HTMLElement[] {
    const hintText = "Enter to save · Esc to cancel";
    const hint = h("p", { class: "hint", "aria-live": "polite" }, hintText);
    const box = h("textarea", {
      class: "edit-input",
      rows: rowsFor(m.text),
      "aria-label": "Edit message",
      value: editText ?? m.text,
      on: {
        input: (e) => {
          editText = (e.currentTarget as HTMLTextAreaElement).value;
          fitRows(e.currentTarget as HTMLTextAreaElement);
          hint.textContent = hintText;
          hint.classList.remove("error");
        },
        keydown: (e) => {
          if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
            e.preventDefault();
            const value = (e.currentTarget as HTMLTextAreaElement).value;
            const problem = editProblem(value, !!m.files?.length);
            if (problem) {
              // Say why nothing happens (an empty edit is not a delete; over-long text can't be saved).
              hint.textContent = problem;
              hint.classList.add("error");
              return;
            }
            opts.onSaveEdit(m.id, value);
          } else if (e.key === "Escape" && !composing(e)) {
            e.preventDefault();
            editing = null;
            editText = null;
            render();
            opts.onCancelEdit();
          }
        },
      },
      signal,
    });
    return [box, hint];
  }

  /**
   * What a reply shows of the message it answers: the copy in the window when there is one (it follows edits and
   * deletes live), else the one the server expanded. Null when it isn't a reply. A live reply to a message beyond the
   * window has neither until the controller has fetched it: "…" meanwhile, not "Message deleted" (QA BUG-180).
   */
  function quotedOf(m: Message, win: MessageWindow): Quoted | null {
    if (!m.reply_to) return null;
    const inWindow = win.items.find((x) => x.id === m.reply_to);
    return inWindow ?? m.expand?.reply_to ?? { id: m.reply_to, author: "", text: "…", deleted: false };
  }

  /** A sent message's time links to it (/r/:id/m/:msgId); one still sending, or failed, isn't on the server yet. */
  function permalink(m: Message, time: HTMLElement): HTMLElement {
    if (m.status) return time;
    return h("a", { class: "permalink", href: `/r/${m.room}/m/${m.id}` }, [time]);
  }

  function messageNode(
    m: Message,
    groupStart: boolean,
    targetId: string | null,
    quoted: Quoted | null,
    selected: ReadonlySet<string> | null,
  ): HTMLElement {
    const err = errors.get(m.id);
    const selectable = opts.selectable(m);
    /** Selecting: whether this message is one of them (null: it can't be). */
    const picked = selected && selectable ? selected.has(m.id) : null;
    const editable = opts.editable(m);
    const deletable = opts.deletable(m);
    const repliable = opts.repliable(m);
    const reactable = opts.reactable(m);
    const me = opts.me();
    const reactions = m.deleted
      ? []
      : opts.reactions(m).map((r) => ({ ...r, who: reactors(r.users, me?.id ?? "", (id) => names.get(id) ?? opts.nameOf(id)) }));
    const { ms, time } = timeOf(m.created);
    /** Someone else's reply to one of my messages: highlighted, so that I notice it (§19.3). */
    const toMe = !!me && quoted?.author === me.id && m.author !== me.id;
    const sig = JSON.stringify([
      m.text,
      m.deleted,
      m.edited_at,
      m.status ?? "",
      m.created,
      time, // changes at midnight ("7:36 PM" → "Oct 10, 7:36 PM")
      groupStart,
      editable,
      deletable,
      repliable,
      reactable,
      selectable,
      !!selected,
      picked,
      m.forwarded_from ? (m.expand?.forwarded_from?.name ?? "") : "",
      reactions.map((r) => [r.emoji, r.users.length, r.users.includes(me?.id ?? ""), r.who]),
      quoted ? [quoted.expand?.author?.name ?? "", quoteText(quoted)] : null,
      editing === m.id,
      confirmDelete === m.id,
      err?.text ?? "",
      targetId === m.id,
      toMe,
      m.expand?.author?.name ?? "",
      m.expand?.author?.avatar ?? "",
      (m.files ?? []).join("/"),
      (m.previews ?? []).map((p) => [p.url, p.title, p.icon.length]),
      (m.localFiles ?? []).map((f) => f.url || f.file.name).join("/"),
      Object.values(m.file_sources ?? {}).map((c) => opts.badge?.(c) ?? null),
    ]);
    const hit = cache.get(m.id);
    if (hit && hit.sig === sig) return hit.el;

    const author: User = m.expand?.author ?? (me && m.author === me.id ? me : { id: m.author, name: "Unknown" });
    const cls = [
      "msg",
      groupStart && "group-start",
      m.status,
      m.deleted && "deleted",
      toMe && "to-me",
      targetId === m.id && "target",
      picked && "selected",
    ]
      .filter(Boolean)
      .join(" ");

    const parts: (HTMLElement | null)[] = [];
    if (picked !== null) {
      parts.push(
        h("input", {
          type: "checkbox",
          class: "select",
          checked: picked,
          "aria-label": `Select message from ${author.name}, ${formatFull(ms)}`,
          on: {
            change: (e) => {
              // Shows what is selected, not what was clicked: a refused one (the limit) stays unchecked.
              (e.currentTarget as HTMLInputElement).checked = picked;
              opts.onSelect(m.id);
            },
          },
          signal,
        }),
      );
    }
    // Above the author's name, from where the avatar is.
    if (quoted) parts.push(quote(quoted));
    if (groupStart) {
      parts.push(avatar(author, 32, opts.avatarUrl));
      parts.push(
        h("div", { class: "meta" }, [
          authorEl(author, me, !!m.expand?.author),
          permalink(m, h("time", { datetime: new Date(ms).toISOString(), title: formatFull(ms) }, time)),
        ]),
      );
    }
    if (m.forwarded_from && !m.deleted) {
      parts.push(h("div", { class: "forwarded" }, `Forwarded from ${m.expand?.forwarded_from?.name ?? "Unknown"}`));
    }
    if (editing === m.id) {
      parts.push(...editBox(m));
    } else {
      // A forward with nothing to show: its original was deleted (§21.3).
      const gone = m.deleted || emptyForward(m);
      parts.push(
        gone
          ? h("div", { class: "body placeholder" }, m.deleted ? "Message deleted" : "The original message was deleted")
          : h("div", { class: "body" }, bodyText(m.text)),
      );
      if (m.edited_at && !m.deleted)
        parts.push(h("span", { class: "edited", title: `Edited ${formatFull(parsePb(m.edited_at))}` }, "(edited)"));
    }
    if (!m.deleted) parts.push(attachments(m));
    if (!m.deleted && m.previews?.length) parts.push(previewList(m.previews));
    if (reactions.length) parts.push(reactionParts.row(m, reactions, reactable, me?.id ?? ""));
    if (m.status === "failed") {
      // The original went away while this reply was sending: Retry sends it without the quote (§19).
      const replyGone = !!quoted?.deleted;
      parts.push(
        h("div", { class: "send-error" }, [
          replyGone ? "Not sent: the message you replied to was deleted. " : "Not sent. ",
          btn(replyGone ? "Send without quote" : "Retry", () => opts.onRetrySend(m.id)),
          btn("Discard", () => opts.onDiscard(m.id)),
        ]),
      );
    }
    if (selected) {
      // Selecting: no actions on single messages.
    } else if (confirmDelete === m.id) {
      parts.push(
        h(
          "div",
          {
            class: "confirm",
            role: "group",
            "aria-label": "Confirm delete",
            on: {
              keydown: (e) => {
                if (e.key !== "Escape") return;
                e.preventDefault();
                cancelDelete(m.id);
              },
            },
            signal,
          },
          [
            "Delete this message? ",
            btn(
              "Delete message",
              () => {
                confirmDelete = null;
                opts.onDelete(m.id);
              },
              "danger",
            ),
            btn("Cancel", () => cancelDelete(m.id), "cancel"),
          ],
        ),
      );
    } else if (editing !== m.id && (reactable || repliable || deletable || selectable)) {
      parts.push(
        h("div", { class: "actions" }, [
          reactable ? reactionParts.addButton(m.id, "react") : null,
          repliable ? tool("Reply", () => opts.onReply(m.id), "reply", "i-reply") : null,
          selectable && !emptyForward(m) ? tool("Forward", () => opts.onForward(m.id), "forward", "i-fwd") : null,
          selectable ? tool("Select", () => opts.onSelect(m.id), "select", "i-check") : null,
          editable ? tool("Edit", () => list.startEdit(m.id), "edit", "i-edit") : null,
          deletable ? tool("Delete", () => askDelete(m.id), "delete", "i-trash") : null,
        ]),
      );
    }
    if (err) parts.push(h("div", { class: "msg-error", role: "alert" }, [`${err.text} `, btn("Retry", err.retry)]));

    const li = h("li", { class: cls, dataset: { id: m.id } }, parts);
    if (touched === m.id) li.classList.add("touched");
    cache.set(m.id, { sig, el: li });
    return li;
  }

  /** A service message (§5.3): one line of the app's own, nobody's, with no buttons (so no reply, reaction or select). */
  function serviceNode(m: Message): HTMLElement {
    const sig = `${m.text} · ${timeOf(m.created).time}`;
    const hit = cache.get(m.id);
    if (hit?.sig === sig) return hit.el;
    const li = h("li", { class: "service", dataset: { id: m.id } }, sig);
    cache.set(m.id, { sig, el: li });
    return li;
  }

  /** Message text with its links clickable (§7.6.3). They open in a new tab, which the router leaves alone. */
  function bodyText(text: string): (string | HTMLAnchorElement)[] {
    return linkify(text).map((part) =>
      typeof part === "string" ? part : h("a", { href: part.href, target: "_blank", rel: "noopener noreferrer nofollow" }, part.text),
    );
  }

  /** A line for each link (§28): its favicon and title, opening it like the link in the text. Only http(s), data: icons. */
  function previewList(previews: readonly LinkPreview[]): HTMLElement {
    return h(
      "ul",
      { class: "previews" },
      previews
        .filter((p) => /^https?:\/\//i.test(p.url))
        .map((p) =>
          h(
            "li",
            {},
            h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer nofollow", title: p.url }, [
              p.icon.startsWith("data:image/") ? h("img", { src: p.icon, alt: "", width: 16, height: 16 }) : null,
              h("span", {}, p.title),
            ]),
          ),
        ),
    );
  }

  /** A reply's quote of the message it answers (§19): clicking it shows that message. */
  function quote(q: Quoted): HTMLElement {
    const name = q.expand?.author?.name ?? "";
    const text = quoteText(q);
    // Spoken as one line, like it is shown: never the whole of a long message. Not "Reply …" either, which is
    // what the Reply button next to it is called.
    const chars = [...text];
    const spoken = chars.length > QUOTE_SPOKEN ? `${chars.slice(0, QUOTE_SPOKEN).join("").trimEnd()}…` : text;
    return h(
      "button",
      {
        type: "button",
        class: `reply-quote${q.deleted ? " deleted" : ""}`,
        title: "Show the original message",
        "aria-label": `Quoting ${name || "a message"}: ${spoken}. Show the original message.`,
        on: { click: () => opts.onOpenQuote(q.id) },
        signal,
      },
      [name ? h("span", { class: "reply-author" }, name) : null, h("span", { class: "reply-text" }, text)],
    );
  }

  /** The author's name: for other (known) users a menu offering "Message" (§16.5), unless they take no DMs (§16.7). Guests can't message (§23.3). */
  function authorEl(author: User, me: User | null, known: boolean): HTMLElement {
    // Someone on a linked instance says where (§33.4).
    const where = author.instance ? `On ${author.instance}` : undefined;
    if (!me || author.id === me.id || !known || author.no_dms) return h("span", { class: "author", title: where }, author.name);
    const menu = createActionMenu({ label: author.name, summary: author.name, className: "author", note: where, signal });
    menu.update([{ label: "Message", run: () => opts.onMessageUser(author.id) }]);
    menu.el.classList.add("author-menu");
    return menu.el;
  }

  function divider(ms: number): HTMLElement {
    const label = dayLabel(ms);
    const key = `${new Date(ms).toDateString()}|${label}`;
    let d = dividers.get(key);
    if (!d) {
      d = h("li", { class: "day" }, h("span", {}, label));
      dividers.set(key, d);
    }
    return d;
  }

  function render(o: { anchor?: boolean } = {}) {
    if (signal.aborted) return;
    const { win, ready, failed, beginning: beginningText, targetId, unreadId, selected } = opts.state();
    el.classList.toggle("selecting", !!selected);
    if (failed) {
      reconcile(el, [loadError]);
      return;
    }
    // An edit box or delete confirm only stays open while its message can still be changed (it may have been
    // deleted in another tab, or the room archived, meanwhile).
    const canChange = (id: string | null, can: (m: Message) => boolean) => !!id && win.items.some((m) => m.id === id && can(m));
    if (selected || !canChange(editing, opts.editable)) {
      editing = null;
      editText = null;
    }
    if (selected || !canChange(confirmDelete, opts.deletable)) confirmDelete = null;
    beginning.textContent = beginningText;
    names = new Map();
    const me = opts.me();
    if (me) names.set(me.id, me.name);
    for (const m of win.items) {
      const a = m.expand?.author;
      if (a) names.set(a.id, a.name);
    }
    const nodes: Node[] = [];
    if (win.hasOlder) nodes.push(topSentinel);
    else if (ready) nodes.push(beginning);
    let prev: Message | undefined;
    let prevDay = "";
    const today = new Date().toDateString();
    if (today !== timesDay || times.size > 2000) {
      times = new Map();
      timesDay = today;
    }
    for (const m of win.items) {
      const { ms, day } = timeOf(m.created);
      const newDay = day !== prevDay;
      if (newDay) nodes.push(divider(ms));
      if (m.id === unreadId) nodes.push(newLine);
      nodes.push(m.author ? messageNode(m, newDay || startsGroup(prev, m), targetId, quotedOf(m, win), selected) : serviceNode(m));
      prev = m;
      prevDay = day;
    }
    if (win.hasNewer) nodes.push(bottomSentinel);

    const anchor = o.anchor ? captureAnchor(el, "li.msg") : null;
    // A redrawn edit box is a new element: give it back the focus and caret the old one had (QA BUG-43).
    const box = document.activeElement;
    const typing = box instanceof HTMLTextAreaElement && box.matches("textarea.edit-input") && el.contains(box) ? box : null;
    const caret = typing && ([typing.selectionStart, typing.selectionEnd, typing.selectionDirection] as const);
    // Likewise a button or checkbox in a redrawn message (it changes whenever someone reacts, §20.3, or it is
    // selected, §21.1): focus its replacement.
    const held =
      !typing && (box instanceof HTMLButtonElement || box instanceof HTMLInputElement) && el.contains(box) ? sameButton(box) : null;
    reconcile(el, nodes);
    if (anchor) restoreAnchor(el, anchor);
    if (typing && caret && !typing.isConnected && editing && !focusAfter) {
      const next = el.querySelector<HTMLTextAreaElement>(`${byId(editing)} textarea.edit-input`);
      next?.focus();
      next?.setSelectionRange(...caret);
    }
    if (held && box instanceof HTMLElement && !box.isConnected && !focusAfter)
      find(held.id, held.selectors)?.focus({ preventScroll: true });

    // forget elements for messages no longer in the window
    const live = new Set(win.items.map((m) => m.id));
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    attachments.prune();

    if (focusAfter) {
      const target = find(focusAfter.id, focusAfter.selector);
      target?.focus();
      if (focusAfter.caretToEnd && target instanceof HTMLTextAreaElement) {
        target.setSelectionRange(target.value.length, target.value.length);
        // The whole message, its "Enter to save" line too: focus only scrolls the box into view (QA BUG-187).
        target.closest("li")?.scrollIntoView?.({ block: "nearest" });
      }
      focusAfter = null;
    }
  }

  /** Where the focused button `b` will be once its message is redrawn: the same button, or the nearest one left. */
  function sameButton(b: HTMLButtonElement | HTMLInputElement): { id: string; selectors: readonly string[] } | null {
    const id = b.closest<HTMLElement>("li.msg")?.dataset.id;
    if (!id) return null;
    if (b instanceof HTMLInputElement) return { id, selectors: ["input.select"] };
    const emoji = b.closest<HTMLElement>(".reactions [data-emoji]")?.dataset.emoji;
    if (emoji) return { id, selectors: reactionFocus(emoji) };
    const cls = b.classList[0];
    const parent = b.parentElement?.classList[0];
    return cls && parent ? { id, selectors: [`.${parent} > .${cls}`] } : null;
  }

  function find(id: string, selector: string | readonly string[]): HTMLElement | null {
    for (const s of typeof selector === "string" ? [selector] : selector) {
      const found = el.querySelector<HTMLElement>(`${byId(id)} ${s}`);
      if (found) return found;
    }
    return null;
  }

  const list: MessageList = {
    el,
    topSentinel,
    bottomSentinel,
    render,
    startEdit(id) {
      editing = id;
      editText = null;
      confirmDelete = null;
      focusAfter = { id, selector: "textarea.edit-input", caretToEnd: true };
      render();
    },
    stopEdit() {
      editing = null;
      editText = null;
    },
    setError(id, error) {
      if (error) errors.set(id, error);
      else errors.delete(id);
    },
    focusIn(id, selectors, later) {
      if (later) focusAfter = { id, selector: selectors };
      else find(id, selectors)?.focus();
    },
    setUpload(id, fraction) {
      uploads.set(id, fraction);
      const bar = el.querySelector<HTMLProgressElement>(`${byId(id)} progress.att-progress`);
      if (bar) bar.value = fraction;
    },
  };
  return list;
}
