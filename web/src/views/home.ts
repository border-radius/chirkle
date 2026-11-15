// Home (§7.1): what the pane next to the room list shows when no room is open. A guest is told what they can read and
// how to join in (§23.3).

import type { Ctx } from "../context.ts";
import { clear, h } from "../dom.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import * as S from "../strings/home.ts";

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? "";

export function createHomeView({ store }: Pick<Ctx, "store">): View {
  const scope = createScope();
  let root: HTMLElement;
  const title = h("h1", {});
  const text = h("p", {});
  const render = () => {
    const user = store.get().user;
    const name = firstName(user?.name ?? "");
    title.textContent = name ? S.welcome(name) : S.WELCOME;
    if (user) text.replaceChildren(S.PICK_A_ROOM_OR_A_CONVERSATION);
    else
      text.replaceChildren(
        S.READ_ANY_OF_THE_OPEN_AIR,
        h("a", { href: "/login" }, S.LOG_IN),
        S.OR,
        h("a", { href: "/signup" }, S.SIGN_UP),
        S.TO_JOIN,
      );
  };

  return {
    mount(el) {
      root = el;
      render();
      clear(root);
      root.append(h("section", { class: "welcome" }, [title, text]));
      scope.defer(
        store.subscribe((s, prev) => {
          if (s.user !== prev.user) render();
        }),
      );
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
