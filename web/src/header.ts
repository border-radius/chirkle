// The app bar (§7.1), shown on phones and on the pages without a sidebar: the site's logo and title (§24), then
// "Jump to" (§32) and who is logged in (a link to the profile, §22.2) or, for a guest, the way in (§23.3). Drawn
// again when the site or the user changes. Next to the sidebar the sidebar shows the same (rooms.ts).

import type { Api } from "./api.ts";
import { h } from "./dom.ts";
import { JUMP } from "./jump.ts";
import type { Site } from "./lib/types.ts";
import type { AppState, Store } from "./store.ts";
import { avatar } from "./ui/avatar.ts";

/** The site's logo and title, a link home. `by`: with "chirps on Chirkle" under the title (byLine), the title then
 *  being the link home, stretched over the whole brand, so that line can hold a link of its own. */
export function brand(site: Site, by = false): HTMLElement {
  const { title, logo } = site;
  const cls = logo ? "brand has-logo" : "brand";
  const img = logo ? h("img", { src: logo, alt: "", class: "brand-logo" }) : null;
  const line = by ? byLine(site) : null;
  if (!line) return h("a", { href: "/", class: cls }, [img, h("span", { class: "brand-title" }, title)]);
  return h("div", { class: cls }, [img, h("span", { class: "brand-name" }, [h("a", { href: "/", class: "brand-title" }, title), line])]);
}

/** "chirps on Chirkle", linking to chirkle.com: the small print under a site's own name in the sidebar and on the login
 *  page. None for a site still called Chirkle, which would say it twice. */
export function byLine({ title }: Site, tag: "span" | "p" = "span"): HTMLElement | null {
  if (title.trim().toLowerCase() === "chirkle") return null;
  return h(tag, { class: "brand-by" }, [
    "chirps on ",
    h("a", { href: "https://chirkle.com", target: "_blank", rel: "noopener" }, "Chirkle"),
  ]);
}

/** Opens Jump to (§32); `text` shows its name and shortcut next to the icon. */
export function jumpButton(text: boolean): HTMLElement {
  const mac = /Mac|iP/.test(navigator.platform);
  return h(
    "button",
    {
      type: "button",
      class: text ? "jump-button ic i-search" : "icon-button ic i-search",
      "aria-label": "Jump to",
      title: `Jump to (${mac ? "⌘" : "Ctrl+"}K)`,
      on: { click: () => document.dispatchEvent(new Event(JUMP)) },
    },
    text ? [h("span", {}, "Jump to…"), h("kbd", { "aria-hidden": "true" }, mac ? "⌘K" : "Ctrl K")] : [],
  );
}

export function createHeader({ api, store }: { api: Api; store: Store<AppState> }): { el: HTMLElement; stop: () => void } {
  const el = h("header", { class: "app-bar" });

  function render() {
    const user = store.get().user;
    el.replaceChildren(
      brand(store.get().site),
      user
        ? h("div", { class: "bar-end" }, [
            jumpButton(false),
            h("a", { href: "/me", class: "me-link", title: "Your profile" }, [
              avatar(user, 32, api.avatarUrl),
              h("span", { class: "who" }, user.name),
            ]),
          ])
        : h("nav", { class: "guest-links", "aria-label": "Account" }, [
            h("a", { href: "/login", class: "guest-link" }, "Log in"),
            h("a", { href: "/signup", class: "guest-link primary" }, "Sign up"),
          ]),
    );
  }

  const stop = store.subscribe((s, prev) => {
    if (s.site !== prev.site || s.user !== prev.user) render();
  });
  render();
  return { el, stop };
}
