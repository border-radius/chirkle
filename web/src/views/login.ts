// Login / signup screen (§7.1): /login and /signup, reached from the header (§23.3). Shows the site's title and logo,
// and asks for an invite code to sign up while the site is invite-only (§24). Forgot password (§39): "Forgot
// password?" asks for the email to send a link to, and the link's page (/reset-password/:token) sets the new one.
//
// A lazy chunk: app.ts loads it for /login and /signup (at once for someone not signed in).

import { type Api, ApiError, errorMessage, SIGNUP_LOGIN_FAILED } from "../api.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { byLine } from "../header.ts";
import { LIMITS, textLength } from "../lib/limits.ts";
import { DEFAULT_SITE, type User } from "../lib/types.ts";
import type { View } from "../router.ts";
import type { AppState, Store } from "../store.ts";

type Mode = "login" | "signup" | "forgot" | "reset";
type Field = "name" | "email" | "password" | "invite_code";

interface FieldSpec {
  name: Field;
  label: string;
  type: string;
  autocomplete: string;
  extra?: Record<string, string | number>;
}

const fieldSpecs = (): Record<Mode, FieldSpec[]> => ({
  login: [
    { name: "email", label: "Email", type: "email", autocomplete: "email" },
    { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
  ],
  forgot: [{ name: "email", label: "Email", type: "email", autocomplete: "email" }],
  reset: [
    { name: "password", label: "New password", type: "password", autocomplete: "new-password", extra: { minlength: LIMITS.passwordMin } },
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

const TITLES: Record<Mode, string> = { login: "Log in", signup: "Sign up", forgot: "Reset password", reset: "Set a new password" };
const TABS: Mode[] = ["login", "signup"];
const BUTTONS: Partial<Record<Mode, string>> = { forgot: "Send link", reset: "Set password" };
const hints = (): Partial<Record<Mode, string>> => ({
  forgot: "Enter your account's email, and we'll send you a link to set a new password.",
  reset: `At least ${LIMITS.passwordMin} characters. Every device logged in to this account is logged out.`,
});

/** The email a reset token was made for (its claims), or "". */
function tokenEmail(token: string): string {
  try {
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : "";
  } catch {
    return "";
  }
}

/** `store`: where the site's branding and signup policy are (§24); the defaults without one. */
export function createLoginView(deps: { api: Api; onLogin: (user: User) => void; mode?: Mode; store?: Store<AppState> }): View {
  const FIELDS = fieldSpecs();
  const HINTS = hints();
  let ac: AbortController | null = null;
  let mode: Mode = deps.mode ?? "login";
  let busy = false;
  /** The reset link's token (mode "reset"); where the forgot form's link went, once sent. */
  let token = "";
  let sentTo = "";
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
    const toMode = (m: Mode) => () => {
      mode = m;
      sentTo = "";
      render();
    };

    const tabs = TABS.map((m) =>
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

    const submit = h("button", { type: "submit", class: "primary", disabled: busy }, BUTTONS[mode] ?? TITLES[mode]);
    const forgot =
      mode === "login" && site().passwordReset
        ? h("button", { type: "button", class: "link auth-forgot", on: { click: toMode("forgot") }, signal }, "Forgot password?")
        : null;

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
      [
        HINTS[mode] ? h("p", { class: "auth-hint" }, HINTS[mode]) : null,
        ...fields,
        forgot,
        h("p", { role: "alert", class: "form-error" }, errors.form ?? ""),
        submit,
      ],
    );
    // The link was sent: say where, in place of the form.
    const sent = sentTo
      ? h(
          "p",
          { role: "status", class: "auth-hint" },
          `If an account uses ${sentTo}, a link to set a new password is on its way. It works for 30 minutes.`,
        )
      : null;
    const back =
      mode === "forgot"
        ? h("button", { type: "button", class: "link auth-back", on: { click: toMode("login") }, signal }, "Back to log in")
        : h("a", { href: "/login", class: "auth-back" }, "Back to log in");

    const { title, logo } = site();
    const tabbed = TABS.includes(mode);
    clear(root);
    root.append(
      h("section", { class: "auth" }, [
        h("h1", { class: logo ? "has-logo" : "" }, [logo ? h("img", { src: logo, alt: "", class: "brand-logo" }) : null, title]),
        byLine(site(), "p"),
        h(
          "div",
          { class: "auth-card" },
          tabbed ? [h("div", { role: "tablist", class: "tabs" }, tabs), form] : [h("h2", {}, TITLES[mode]), sent ?? form, back],
        ),
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
    if (mode === "signup" && new TextEncoder().encode(values.password).length > LIMITS.passwordMaxBytes) {
      render({ fields: { password: "Use at most 71 characters (fewer if some aren't plain Latin letters, digits or punctuation)." } });
      return;
    }
    busy = true;
    button.disabled = true;
    try {
      if (mode === "forgot") {
        await deps.api.requestPasswordReset(values.email);
        busy = false;
        sentTo = values.email.trim();
        render();
        return;
      }
      if (mode === "reset") {
        await deps.api.confirmPasswordReset(token, values.password);
        const email = tokenEmail(token);
        try {
          // Logged out everywhere, this tab included: log in with the new password.
          const user = await deps.api.logIn(email, values.password);
          busy = false;
          deps.onLogin(user);
        } catch {
          busy = false;
          mode = "login";
          values.email = email;
          render({ form: "Your password was changed. Log in with it." });
        }
        return;
      }
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
      // A reset link that ran out (30 minutes) or was used already.
      const expired =
        mode === "reset" && e instanceof ApiError && e.codes.token ? "This link has expired or was already used. Ask for a new one." : "";
      const form = Object.keys(fields).length ? "" : invite || expired || (badLogin ? "Wrong email or password." : errorMessage(e));
      render({ form, fields });
    }
  }

  return {
    mount(el, params) {
      root = el;
      token = params.token ?? "";
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
