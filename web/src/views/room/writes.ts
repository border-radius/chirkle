// What the room controller (controller.ts) writes: sending (§7.5, §17.4, §19), edits and deletes, deleting several
// messages at once (§21) and reactions (§20). Each is shown at once and then made good, or undone, by the server's
// answer; writes go one at a time per message, in the order they were made.

import { type Api, ApiError } from "../../api.ts";
import { newId } from "../../lib/id.ts";
import { type MessageWindow, merge, quoteOf, remove, trim } from "../../lib/messages.ts";
import { setReaction } from "../../lib/reactions.ts";
import { parsePb, toPb } from "../../lib/time.ts";
import type { LocalFile, Message, Reaction, User } from "../../lib/types.ts";
import type { Scope } from "../../scope.ts";
import type { Change } from "./controller.ts";

/**
 * Sends that failed, by room, kept for its next view when the view went: those that failed after it had gone (another
 * room was opened while they were on their way), and those it showed as not sent (QA BUG-119). The next view shows
 * them as not sent, with Retry: otherwise what was written would be lost without a word, as the composer and the draft
 * were cleared on sending.
 */
const strays = new Map<string, Message[]>();
/** Keep a failed send for the room's next view. Its previews went with the view: its files show by name. */
export function stray(m: Message) {
  const files = m.localFiles?.map((f) => ({ ...f, url: "" }));
  strays.set(m.room, [...(strays.get(m.room) ?? []), { ...m, ...(files && { localFiles: files }) }]);
}
/** The failed sends kept for this room's view (taken: the next view won't get them again). */
export function takeStrays(roomId: string): Message[] {
  const out = strays.get(roomId) ?? [];
  strays.delete(roomId);
  return out;
}

/** Release a local message's preview URLs (sent, discarded, or the room is going away). */
export const revokeLocal = (m: Message | undefined) => {
  for (const f of m?.localFiles ?? []) if (f.url) URL.revokeObjectURL(f.url);
};

/** What the writes use of the controller. */
export interface WriteCtx {
  api: Api;
  roomId: string;
  scope: Scope;
  me: () => User | null;
  posting: () => boolean;
  editable: (m: Message) => boolean;
  deletable: (m: Message) => boolean;
  /** The window, and replacing it as it is (no unsent messages are set aside: these writes keep them). */
  win: () => MessageWindow;
  put: (next: MessageWindow) => void;
  find: (id: string) => Message | undefined;
  /** Local optimistic change that must win regardless of `updated` (edit/delete/revert). */
  patchLocal: (id: string, patch: Partial<Message>) => void;
  emit: (change?: Change) => void;
  /** The change for messages changed where they are. */
  inPlace: () => Change;
  /** Go back to the live edge, for a message sent from history. */
  toLatest: () => Promise<void>;
  /** A message sent: no pill. */
  clearPill: () => void;
  /** Unsent messages the window dropped (controller.ts), updated as their sends end. */
  unsent: Map<string, Message>;
  onUpload?: ((id: string, fraction: number) => void) | undefined;
}

export function createWrites(ctx: WriteCtx) {
  const { api, roomId, scope, me, find, patchLocal, emit, inPlace, unsent } = ctx;
  /**
   * My reaction changes still on their way, by message id and emoji: whether it should be there, and which change said
   * so last. They show over every copy of the message until that change is answered (§20.3).
   */
  const reacting = new Map<string, Map<string, { on: boolean; seq: number }>>();
  /**
   * Writes go one at a time, so the server applies them in the order they were made: sends (key ""), and each message's
   * edits, deletes and reactions (key: its id). Two at once can land the other way round: a message with an attachment
   * after the text sent just after it, or an older edit over a newer one.
   */
  const queues = new Map<string, Promise<unknown>>();
  const inTurn = <T>(key: string, write: () => Promise<T>): Promise<T> => {
    const run = (queues.get(key) ?? Promise.resolve()).then(write);
    const done = run.catch(() => {});
    queues.set(key, done);
    void done.then(() => queues.get(key) === done && queues.delete(key));
    return run;
  };
  let reactSeq = 0;

  // ---------------------------------------------------------------- sending

  function send(text: string, files: LocalFile[] = [], replyTo?: Message): boolean {
    const user = me();
    if (!user || !ctx.posting()) return false;
    const quoted = replyTo ? quoteOf(replyTo) : undefined;
    void (async () => {
      if (ctx.win().hasNewer) await ctx.toLatest();
      const last = ctx.win().items.at(-1);
      const created = toPb(Math.max(Date.now(), last ? parsePb(last.created) + 1 : 0));
      const msg: Message = {
        id: newId(),
        room: roomId,
        author: user.id,
        text,
        created,
        updated: created,
        edited_at: "",
        deleted: false,
        expand: { author: { id: user.id, name: user.name, avatar: user.avatar ?? "" }, ...(quoted ? { reply_to: quoted } : {}) },
        ...(quoted ? { reply_to: quoted.id } : {}),
        status: "pending",
        ...(files.length ? { localFiles: files } : {}),
      };
      ctx.put(trim(merge(ctx.win(), [msg]), "top").win);
      ctx.clearPill();
      emit({ render: {}, scroll: "bottom" });
      await inTurn("", () => deliver(msg));
    })();
    return true;
  }

  async function deliver(msg: Message) {
    // A reply whose original has been deleted meanwhile can only go without its quote (§19): Retry sends it so.
    const quoted = msg.expand?.reply_to;
    const replyTo = msg.reply_to && !(find(msg.reply_to) ?? quoted)?.deleted ? msg.reply_to : undefined;
    let saved: Message | null = null;
    let failed: Message | null = null;
    try {
      const files = msg.localFiles?.filter((f) => !f.item).map((f) => f.file);
      const items = msg.localFiles?.flatMap((f) => (f.item ? [f.item.id] : []));
      saved = await api.send(
        {
          id: msg.id,
          room: msg.room,
          text: msg.text,
          ...(files?.length ? { files } : {}),
          ...(items?.length ? { items } : {}),
          ...(replyTo ? { replyTo } : {}),
        },
        (fraction) => ctx.onUpload?.(msg.id, fraction),
      );
    } catch (e) {
      // A retry of a send that already reached the server fails with a duplicate id: it was sent after all.
      const recovered = e instanceof ApiError && e.status === 400 ? await api.getMessage(msg.id).catch(() => null) : null;
      if (recovered && recovered.author === me()?.id) saved = recovered;
      else {
        const replyGone = e instanceof ApiError && "reply_to" in e.fields && quoted;
        failed = {
          ...msg,
          status: "failed",
          ...(replyGone ? { expand: { ...msg.expand, reply_to: { ...quoted, text: "", deleted: true } } } : {}),
        };
        // The server says the original is deleted, though the window may not have heard yet.
        if (replyGone && find(quoted.id)) patchLocal(quoted.id, { text: "", deleted: true });
      }
    }
    // The server has the files now: the previews can go, even if the room was left meanwhile (its echo may already have
    // replaced the pending copy, whose previews nothing else would release; QA BUG-70).
    if (saved) revokeLocal(msg);
    if (!scope.active) {
      if (failed) stray(failed);
      return;
    }
    // The window may have moved back in history meanwhile (a quote, a jump): then the message isn't in it, and
    // must not be put after older messages. Sent, it shows once the window is back at the live edge.
    if (saved) {
      unsent.delete(msg.id);
      if (find(msg.id)) ctx.put(merge(ctx.win(), [saved]));
    } else if (failed && find(msg.id)?.status) ctx.put(merge(ctx.win(), [failed]));
    else if (failed && unsent.has(msg.id)) unsent.set(msg.id, failed);
    emit({ render: {} });
  }

  async function retrySend(id: string) {
    const m = find(id);
    if (m?.status !== "failed") return;
    patchLocal(id, { status: "pending" });
    emit({ render: {} });
    await inTurn("", () => deliver({ ...m, status: "pending" }));
  }

  function discard(id: string) {
    revokeLocal(find(id));
    ctx.put(remove(ctx.win(), id));
    emit({ render: {} });
  }

  // ---------------------------------------------------------------- edit / delete

  /** Show `patch` right away; keep the server's copy, or put `before` back if the request fails. */
  async function optimistic(id: string, patch: Partial<Message>, before: Partial<Message>, request: () => Promise<Message>) {
    patchLocal(id, patch);
    emit(inPlace());
    let ok = true;
    try {
      const saved = await inTurn(id, request);
      if (scope.active) ctx.put(merge(ctx.win(), [saved]));
    } catch {
      if (!scope.active) return false;
      patchLocal(id, before);
      ok = false;
    }
    emit(inPlace());
    return ok;
  }

  function edit(id: string, text: string) {
    const m = find(id);
    // Deleted elsewhere or the room was archived while the edit box was open: nothing left to save.
    if (!m || !ctx.editable(m) || text === m.text) return null;
    return optimistic(id, { text, previews: [] }, { text: m.text, edited_at: m.edited_at, previews: m.previews ?? [] }, () =>
      api.edit(id, text),
    );
  }

  function removeMessage(id: string) {
    const m = find(id);
    if (!m) return null;
    // Someone else's, or a moderator's own where they can't post (§36): only the delete route allows it.
    const own = m.author === me()?.id && ctx.posting();
    const remove = own ? () => api.softDelete(id) : async () => (await api.deleteMany([id]))[0]!;
    return optimistic(id, { text: "", deleted: true }, { text: m.text, deleted: false }, remove);
  }

  function removeMany(ids: readonly string[]) {
    const ms = ids.flatMap((id) => {
      const m = find(id);
      return m && ctx.deletable(m) ? [m] : [];
    });
    return ms.length ? deleteAll(ms) : null;
  }

  async function deleteAll(ms: Message[]): Promise<unknown> {
    for (const m of ms) patchLocal(m.id, { text: "", deleted: true });
    emit(inPlace());
    let failure: unknown = null;
    try {
      const saved = await api.deleteMany(ms.map((m) => m.id));
      if (scope.active)
        ctx.put(
          merge(
            ctx.win(),
            saved.filter((m) => find(m.id)),
          ),
        );
    } catch (e) {
      if (!scope.active) return e;
      for (const m of ms) patchLocal(m.id, { text: m.text, deleted: false });
      failure = e;
    }
    emit(inPlace());
    return failure;
  }

  // ---------------------------------------------------------------- reactions

  function reactions(m: Message): readonly Reaction[] {
    let list: readonly Reaction[] = m.reactions ?? [];
    const mine = reacting.get(m.id);
    const user = me()?.id;
    if (mine && user) for (const [emoji, p] of mine) list = setReaction(list, emoji, user, p.on);
    return list;
  }

  async function react(id: string, emoji: string, on: boolean): Promise<boolean> {
    const seq = ++reactSeq;
    const mine = reacting.get(id) ?? new Map();
    const latest = () => mine.get(emoji)?.seq === seq;
    const request = async () => {
      if (!latest()) return true; // changed again before it went out: the later change says what to send
      try {
        const saved = await api.react(id, emoji, on);
        // The whole message comes back: kept like any other copy (the newest wins).
        if (scope.active && find(id)) ctx.put(merge(ctx.win(), [saved]));
        return true;
      } catch {
        return false;
      }
    };
    const queue = inTurn(id, request);
    reacting.set(id, mine.set(emoji, { on, seq }));
    emit(inPlace());
    const ok = await queue;
    // Changed again meanwhile: the later change shows, and says whether it worked.
    if (!latest()) return true;
    if (!scope.active) return ok;
    mine.delete(emoji);
    if (!mine.size && reacting.get(id) === mine) reacting.delete(id);
    emit(inPlace());
    return ok;
  }

  return { send, retrySend, discard, edit, remove: removeMessage, removeMany, reactions, react };
}
