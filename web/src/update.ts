// A new version (§27.4): when a deploy changed the app, a line above the app says so, with a button that reloads the page.
// The page names its build's script (/assets/app-HASH.js); a newer index.html names another one. It is checked after
// realtime reconnects (a deploy restarts the server), when the tab comes back into view, and every half hour.

import type { Api } from "./api.ts";
import { h } from "./dom.ts";

/** At most one check this often from the tab coming into view (a reconnect checks anyway). */
const MIN_GAP = 60_000;
const EVERY = 30 * 60_000;
/** After a reconnect, every open tab checks at once: spread over this long. */
const SPREAD = 10_000;

/** The build's script in an index.html, e.g. "/assets/app-AB12CD34.js". */
export const appScript = (html: string) => /<script type="module" src="(\/assets\/app[^"]*\.js)"/.exec(html)?.[1];

/**
 * Watch for a new version; the line goes at the top of `root` (#app). `current`: this page's script (none: nothing to
 * compare). Returns a function that stops it.
 */
export function startUpdates(
  api: Api,
  root: HTMLElement,
  current = document.querySelector('script[src^="/assets/app"]')?.getAttribute("src"),
  load = () => fetch("/", { cache: "no-store" }).then((r) => r.text()),
): () => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shown = () => root.querySelector(".update-bar");
  const check = async (force?: boolean) => {
    if (!current || shown() || (!force && Date.now() - last < MIN_GAP)) return;
    last = Date.now();
    // Offline, a server mid-restart, a proxy's error page: no script named, nothing to say yet.
    const next = appScript(await load().catch(() => ""));
    if (next && next !== current && !shown()) {
      root.prepend(
        h("div", { class: "update-bar", role: "status" }, [
          "A new version of the app is out.",
          h("button", { type: "button", class: "primary", on: { click: () => location.reload() } }, "Reload"),
        ]),
      );
    }
  };
  const onVisible = () => document.visibilityState === "visible" && void check();
  document.addEventListener("visibilitychange", onVisible);
  const every = setInterval(check, EVERY);
  const offConnect = api.onConnect((reconnect) => {
    clearTimeout(timer);
    if (reconnect) timer = setTimeout(check, Math.random() * SPREAD, true);
  });
  return () => {
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(every);
    clearTimeout(timer);
    offConnect();
    shown()?.remove();
  };
}
