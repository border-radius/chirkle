// Login / signup screen (§7.1): /login and /signup, reached from the header (§23.3). Shows the site's title and logo,
// and asks for an invite code to sign up while the site is invite-only (§24).
//
// A lazy chunk: app.ts loads it for /login and /signup (at once for someone not signed in). It imports types only, and
// gets what it uses of app.js in `kit` (lazy.ts LOGIN_KIT).

import type { Api, ApiError, errorMessage, SIGNUP_LOGIN_FAILED } from "../api.ts";
import type { clear, h, uniqueId } from "../dom.ts";
import type { byLine } from "../header.ts";
import type { LIMITS, textLength } from "../lib/limits.ts";
import type { Site, User } from "../lib/types.ts";
import type { View } from "../router.ts";
import type { AppState, Store } from "../store.ts";

export interface LoginKit {
  h: typeof h;
  clear: typeof clear;
  uniqueId: typeof uniqueId;
  byLine: typeof byLine;
  ApiError: typeof ApiError;
  errorMessage: typeof errorMessage;
  SIGNUP_LOGIN_FAILED: typeof SIGNUP_LOGIN_FAILED;
  LIMITS: typeof LIMITS;
  textLength: typeof textLength;
  /** The site without a site record. */
  DEFAULT_SITE: Site;
}

type Mode = "login" | "signup";
type Field = "name" | "email" | "password" | "invite_code";

interface FieldSpec {
  name: Field;
  label: string;
  type: string;
  autocomplete: string;
  extra?: Record<string, string | number>;
}

const fieldSpecs = (LIMITS: LoginKit["LIMITS"]): Record<Mode, FieldSpec[]> => ({
  login: [
    { name: "email", label: "Email", type: "email", autocomplete: "email" },
    { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
  ],
  signup: [
    // No `maxlength`: it counts UTF-16 units (an emoji is 2), the server counts characters. Checked on submit.
    { name: "name", label: "Display name", type: "text", autocomplete: "nickname" },
    { name: "email", label: "Email", type: "email", autocomplete: "email" },
    { name: "password", label: "Password", type: "password", autocomplete: "new-password", extra: { minlength: LIMITS.passwordMin } },
  ],
});

/** Asked for last on signup, while the site is invite-only (§24). */
const INVITE: FieldSpec = { name: "invite_code", label: "Invite code", type: "text", autocomplete: "off" };

const TITLES: Record<Mode, string> = { login: "Log in", signup: "Sign up" };

/** `store`: where the site's branding and signup policy are (§24); the defaults without one. */
export function createLoginView(deps: {
  kit: LoginKit;
  api: Api;
  onLogin: (user: User) => void;
  mode?: Mode;
  store?: Store<AppState>;
}): View {
  const { h, clear, uniqueId, byLine, ApiError, errorMessage, SIGNUP_LOGIN_FAILED, LIMITS, textLength, DEFAULT_SITE } = deps.kit;
  const FIELDS = fieldSpecs(LIMITS);
  let ac: AbortController | null = null;
  let mode: Mode = deps.mode ?? "login";
  let busy = false;
  const values: Record<Field, string> = { name: "", email: "", password: "", invite_code: "" };
  const site = () => deps.store?.get().site ?? DEFAULT_SITE;
  const fieldsOf = (m: Mode) => (m === "signup" && site().inviteOnly ? [...FIELDS.signup, INVITE] : FIELDS[m]);
  let offStore = () => {};
  const prefix = uniqueId("login");
  let root: HTMLElement;

  function render(errors: { form?: string; fields?: Record<string, string> } = {}) {
    ac?.abort();
    ac = new AbortController();
    const { signal } = ac;

    const tabs = (Object.keys(TITLES) as Mode[]).map((m) =>
      h(
        "button",
        {
          type: "button",
          role: "tab",
          "aria-selected": String(m === mode),
          on: {
            click: () => {
              if (m === mode) return;
              mode = m;
              render();
            },
          },
          signal,
        },
        TITLES[m],
      ),
    );

    const submit = h("button", { type: "submit", class: "primary", disabled: busy }, TITLES[mode]);

    const fields = fieldsOf(mode).map((f) => {
      const id = `${prefix}-${f.name}`;
      const errId = `${id}-error`;
      const error = errors.fields?.[f.name];
      return h("div", { class: "field" }, [
        h("label", { for: id }, f.label),
        h("input", {
          id,
          name: f.name,
          type: f.type,
          autocomplete: f.autocomplete,
          required: true,
          value: values[f.name],
          "aria-invalid": error ? "true" : null,
          "aria-describedby": errId,
          ...f.extra,
          on: { input: (e) => (values[f.name] = (e.target as HTMLInputElement).value) },
          signal,
        }),
        h("p", { id: errId, class: "field-error" }, error ?? ""),
      ]);
    });

    const form = h(
      "form",
      {
        class: "auth-form",
        "aria-label": TITLES[mode],
        on: {
          submit: (e) => {
            e.preventDefault();
            // Read the inputs now: autofill/password managers may not fire input events.
            for (const f of fieldsOf(mode)) values[f.name] = (form.elements.namedItem(f.name) as HTMLInputElement).value;
            void onSubmit(submit);
          },
        },
        signal,
      },
      [...fields, h("p", { role: "alert", class: "form-error" }, errors.form ?? ""), submit],
    );

    const { title, logo } = site();
    clear(root);
    root.append(
      h("section", { class: "auth" }, [
        h("h1", { class: logo ? "has-logo" : "" }, [logo ? h("img", { src: logo, alt: "", class: "brand-logo" }) : null, title]),
        byLine(site(), "p"),
        h("div", { class: "auth-card" }, [h("div", { role: "tablist", class: "tabs" }, tabs), form]),
        h("p", { class: "auth-skip" }, h("a", { href: "/" }, "Just looking? Read the Open Air rooms")),
      ]),
    );
  }

  async function onSubmit(button: HTMLButtonElement) {
    if (busy) return;
    if (mode === "signup" && textLength(values.name.trim()) > LIMITS.userName) {
      render({ fields: { name: `Must be no more than ${LIMITS.userName} characters.` } });
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      const user =
        mode === "login"
          ? await deps.api.logIn(values.email, values.password)
          : await deps.api.signUp({
              name: values.name,
              email: values.email,
              password: values.password,
              ...(site().inviteOnly ? { inviteCode: values.invite_code } : {}),
            });
      busy = false;
      button.disabled = false;
      deps.onLogin(user);
    } catch (e) {
      busy = false;
      if (!ac || ac.signal.aborted) return; // unmounted meanwhile
      if (e instanceof ApiError && e.codes.auth === SIGNUP_LOGIN_FAILED) {
        // The account exists now: signing up again would only say the email is taken.
        mode = "login";
        render({ form: `Your account was created, but logging in failed: ${errorMessage(e)} Log in to continue.` });
        return;
      }
      // Errors for fields on screen go next to them; anything else (network, rate limit, …) above the button.
      const all = e instanceof ApiError ? e.fields : {};
      const fields = Object.fromEntries(Object.entries(all).filter(([k]) => fieldsOf(mode).some((f) => f.name === k)));
      // PocketBase says "Value must be unique." (QA BUG-49).
      if (mode === "signup" && e instanceof ApiError && e.codes.email === "validation_not_unique") {
        fields.email = "There is already an account with this email. Log in instead.";
      }
      // A refused login is a 400 without field errors; PocketBase's "Failed to authenticate." doesn't say why (QA BUG-40).
      const badLogin = mode === "login" && e instanceof ApiError && e.status === 400;
      // The site became invite-only after this page loaded (§24): no code field on screen to put the error next to.
      const invite = e instanceof ApiError && !fields.invite_code ? all.invite_code : undefined;
      const form = Object.keys(fields).length ? "" : (invite ?? (badLogin ? "Wrong email or password." : errorMessage(e)));
      render({ form, fields });
    }
  }

  return {
    mount(el) {
      root = el;
      render();
      // The site loaded (or changed) while on this page: its title, and maybe the invite code field.
      offStore =
        deps.store?.subscribe((s, prev) => {
          if (s.site !== prev.site && !busy) render();
        }) ?? (() => {});
    },
    unmount() {
      offStore();
      ac?.abort();
      ac = null;
      clear(root);
    },
  };
}
