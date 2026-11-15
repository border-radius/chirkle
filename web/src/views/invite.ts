// The invite page (DESIGN.md §44.2): /invite/<token>, a private room's invite link. It says which room the link is to,
// who made it and how many are in it; someone signed in joins with one button and lands in the room, a guest is asked
// to log in or sign up first (and comes back here), and someone in the room already is taken to it. A link that doesn't
// work says so, without saying why (expired, revoked, or the room no longer private).
//
// A lazy chunk (app.ts), with its calls in invite-api.ts.

import { ApiError, errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h } from "../dom.ts";
import type { InviteApi, InvitePreview } from "../invite-api.ts";
import { formatFull, parsePb } from "../lib/time.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import * as S from "../strings/invite.ts";

/** A link that doesn't work: the server answers 404. */
const isGone = (e: unknown) => e instanceof ApiError && e.status === 404;

export function createInviteView({ api, store, sync, navigate }: Pick<Ctx, "api" | "store" | "sync" | "navigate">): View {
  let scope = createScope();
  let root: HTMLElement | null = null;
  let token = "";
  let invites: Promise<InviteApi> | null = null;
  const loadApi = () => (invites ??= api.invites());

  const section = (children: (Node | string)[]) => h("section", { class: "welcome invite-page" }, children);

  function show(children: (Node | string)[]) {
    if (!root) return;
    clear(root);
    root.append(section(children));
  }

  function gone() {
    show([
      h("h1", {}, S.THIS_LINK_DOESNT_WORK),
      h("p", {}, S.IT_HAS_EXPIRED_OR_WAS_REVOKED),
      h("p", {}, h("a", { href: "/" }, S.BACK_TO_ROOMS)),
    ]);
  }

  function render(p: InvitePreview) {
    const user = store.get().user;
    const title = h("h1", {}, S.joinRoom(p.room.name));
    const about = h("p", {}, S.about(p.by, p.room.members, formatFull(parsePb(p.expires))));
    if (p.member) {
      show([title, h("p", {}, S.YOURE_IN_THIS_ROOM_ALREADY), h("p", {}, h("a", { href: `/r/${p.room.id}` }, S.OPEN_THE_ROOM))]);
      return;
    }
    if (!user) {
      show([
        title,
        about,
        h("p", {}, [S.TO_JOIN, h("a", { href: "/login" }, S.LOG_IN), S.OR, h("a", { href: "/signup" }, S.SIGN_UP), S.FIRST]),
      ]);
      return;
    }
    const error = h("p", { class: "field-error", role: "alert" });
    const s = scope;
    const join = h(
      "button",
      {
        type: "button",
        class: "primary",
        on: {
          click: async () => {
            join.disabled = true;
            error.textContent = "";
            try {
              const room = await (await loadApi()).join(token);
              // The room list has it before the room opens, so the room doesn't say it doesn't exist.
              await sync.reload().catch(() => {});
              if (s.active) navigate(`/r/${room}`);
            } catch (e) {
              if (!s.active) return;
              if (isGone(e)) return gone();
              join.disabled = false;
              error.textContent = S.couldntJoin(errorMessage(e));
            }
          },
        },
        signal: s.signal,
      },
      S.JOIN,
    );
    show([title, about, h("p", {}, join), error]);
  }

  function load() {
    const s = scope;
    show([h("p", { class: "empty", role: "status" }, S.LOADING)]);
    loadApi()
      .then((a) => a.preview(token, s.signal))
      .then(
        (p) => {
          if (s.active) render(p);
        },
        (e: unknown) => {
          if (!s.active) return;
          if (isGone(e)) return gone();
          show([h("p", { class: "empty", role: "alert" }, S.couldntOpen(errorMessage(e)))]);
        },
      );
  }

  return {
    mount(el, params) {
      root = el;
      token = params.token ?? "";
      scope = createScope();
      load();
      // Logged in or out on another tab, or here: what it offers changes.
      const s = scope;
      s.defer(
        store.subscribe((st, prev) => {
          if (st.user?.id !== prev.user?.id && s.active) load();
        }),
      );
    },
    update(params) {
      if ((params.token ?? "") === token) return;
      scope.dispose();
      scope = createScope();
      token = params.token ?? "";
      load();
    },
    unmount() {
      scope.dispose();
      if (root) clear(root);
      root = null;
    },
  };
}
