import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../web/src/api.ts";
import { LOGIN_KIT } from "../../../web/src/lazy.ts";
import { DEFAULT_SITE, type Site, type User } from "../../../web/src/lib/types.ts";
import { type AppState, createStore, initialState } from "../../../web/src/store.ts";
import { createLoginView } from "../../../web/src/views/login.ts";
import { instrument, intercept, newApi, signedUp, uniq } from "../../support/api.ts";

function fill(root: HTMLElement, values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) {
    const input = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) throw new Error(`no input ${name}`);
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
}
const submit = (root: HTMLElement) => root.querySelector("form")!.requestSubmit();
const tab = (root: HTMLElement, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((t) => t.textContent === name)!;
const fieldNames = (root: HTMLElement) => [...root.querySelectorAll<HTMLInputElement>("form input")].map((i) => i.name);
const alertText = (root: HTMLElement) => root.querySelector('[role="alert"]')!.textContent;

describe("login view (§7.1)", () => {
  let root: HTMLElement;
  let onLogin: (u: User) => void;

  beforeEach(() => {
    root = document.createElement("main");
    document.body.append(root);
    onLogin = vi.fn();
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  const mount = (api = newApi()) => {
    const view = createLoginView({ kit: LOGIN_KIT, api, onLogin });
    view.mount(root, {});
    return { view, api };
  };

  it("starts on the Log in tab with email + password", () => {
    mount();
    expect(tab(root, "Log in").getAttribute("aria-selected")).toBe("true");
    expect(tab(root, "Sign up").getAttribute("aria-selected")).toBe("false");
    expect(fieldNames(root)).toEqual(["email", "password"]);
    expect(root.querySelector<HTMLInputElement>('input[name="password"]')!.type).toBe("password");
  });

  it("the Sign up tab adds a name field", () => {
    mount();
    tab(root, "Sign up").click();
    expect(tab(root, "Sign up").getAttribute("aria-selected")).toBe("true");
    expect(fieldNames(root)).toEqual(["name", "email", "password"]);
  });

  it("logs in and hands the user to onLogin", async () => {
    const ada = await signedUp("Ada");
    const { api } = mount();
    fill(root, { email: ada.email, password: ada.password });
    submit(root);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith({ id: ada.user.id, name: "Ada", avatar: "", handle: ada.user.handle }));
    expect(api.currentUser()).toEqual(ada.user);
  });

  it("signs up and hands the user to onLogin", async () => {
    const { api } = mount();
    tab(root, "Sign up").click();
    fill(root, { name: "Grace", email: `${uniq()}@test.local`, password: "password-123" });
    submit(root);
    await vi.waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({ id: expect.any(String), name: "Grace", avatar: "", handle: expect.any(String) }),
    );
    expect(api.currentUser()?.name).toBe("Grace");
  });

  it("if the account is created but the automatic login fails, it switches to Log in and says so", async () => {
    const api = newApi();
    instrument(api).failNext("logIn", new ApiError("Too many requests.", 429));
    mount(api);
    tab(root, "Sign up").click();
    const email = `${uniq()}@test.local`;
    const name = `Grace ${uniq()}`;
    fill(root, { name, email, password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).toContain("Your account was created"));
    expect(tab(root, "Log in").getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe(email);
    submit(root);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith({ id: expect.any(String), name, avatar: "", handle: expect.any(String) }));
  });

  it("a display name someone else has is refused next to the name field (§22.1)", async () => {
    const taken = await signedUp();
    mount();
    tab(root, "Sign up").click();
    fill(root, { name: taken.user.name.toUpperCase(), email: `${uniq()}@test.local`, password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(root.querySelector(".field-error")!.textContent).toBe("This display name is taken. Choose another one."));
    expect(root.querySelector('input[name="name"]')!.getAttribute("aria-invalid")).toBe("true");
    expect(onLogin).not.toHaveBeenCalled();
    await taken.api.unsubscribeAll();
  });

  it("checks the display name length in characters (an emoji is one), before asking the server", async () => {
    const api = newApi();
    const ctl = instrument(api);
    mount(api);
    tab(root, "Sign up").click();
    expect(root.querySelector('input[name="name"]')!.getAttribute("maxlength")).toBeNull();
    fill(root, { name: "x".repeat(33), email: `${uniq()}@test.local`, password: "password-123" });
    submit(root);
    expect(root.querySelector(".field-error")!.textContent).toBe("Must be no more than 32 characters.");
    expect(ctl.calls("signUp")).toBe(0);
    fill(root, { name: "😀".repeat(32) });
    submit(root);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
  });

  it("QA BUG-40: says the email or password is wrong on a refused login, and keeps the input", async () => {
    mount();
    const email = `${uniq()}@test.local`;
    fill(root, { email, password: "wrong-pass" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).toBe("Wrong email or password."));
    expect(root.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe(email);
    expect(onLogin).not.toHaveBeenCalled();
  });

  it("shows server field errors inline next to their inputs, without a redundant generic alert", async () => {
    mount();
    tab(root, "Sign up").click();
    fill(root, { name: "\u200b", email: `${uniq()}@test.local`, password: "password-123" }); // invisible only: the server refuses it
    submit(root);
    await vi.waitFor(() => expect(root.querySelector('input[name="name"]')!.getAttribute("aria-invalid")).toBe("true"));
    const input = root.querySelector<HTMLInputElement>('input[name="name"]')!;
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toBe("Cannot be blank.");
    expect(alertText(root)).toBe("");
  });

  it("QA BUG-47/49: an email already signed up, in any case, says so in plain words", async () => {
    const taken = await signedUp();
    mount();
    tab(root, "Sign up").click();
    fill(root, { name: "Copycat", email: taken.email.toUpperCase(), password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(root.querySelector('input[name="email"]')!.getAttribute("aria-invalid")).toBe("true"));
    const input = root.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toBe(
      "There is already an account with this email. Log in instead.",
    );
    expect(alertText(root)).toBe("");
  });

  it("explains rate limiting (429) in plain words", async () => {
    const api = newApi();
    instrument(api).failNext("logIn", new ApiError("Too Many Requests.", 429));
    mount(api);
    fill(root, { email: `${uniq()}@test.local`, password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).toBe("Too many attempts. Wait a few seconds and try again."));
  });

  it("explains network failures", async () => {
    const api = newApi();
    instrument(api).failNext("logIn", new ApiError("Failed to fetch", 0));
    mount(api);
    fill(root, { email: `${uniq()}@test.local`, password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).toBe("Can't reach the server. Check your connection."));
  });

  it("clears errors when switching tabs", async () => {
    mount();
    fill(root, { email: `${uniq()}@test.local`, password: "wrong-pass" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).not.toBe(""));
    tab(root, "Sign up").click();
    expect(alertText(root)).toBe("");
  });

  it("disables the submit button while the request is in flight, ignoring double submits", async () => {
    const ada = await signedUp("Ada");
    const api = newApi();
    const ctl = instrument(api);
    const release = ctl.hold("logIn");
    mount(api);
    fill(root, { email: ada.email, password: ada.password });
    submit(root);
    const button = root.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(true);
    submit(root);
    expect(ctl.calls("logIn")).toBe(1);
    release();
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(button.disabled).toBe(false);
  });

  it("unmount removes its listeners and content", async () => {
    const api = newApi();
    const ctl = instrument(api);
    const { view } = mount(api);
    const form = root.querySelector("form")!;
    view.unmount();
    expect(root.childNodes).toHaveLength(0);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctl.calls("logIn")).toBe(0);
  });
});

describe("login view: the site's branding and invite-only signups (§24)", () => {
  let root: HTMLElement;
  let onLogin: (u: User) => void;

  beforeEach(() => {
    root = document.createElement("main");
    document.body.append(root);
    onLogin = vi.fn();
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  const mount = (site: Partial<Site>, api = newApi()) => {
    const store = createStore<AppState>({ ...initialState(), site: { ...DEFAULT_SITE, ...site } });
    const view = createLoginView({ kit: LOGIN_KIT, api, onLogin, store, mode: "signup" });
    view.mount(root, {});
    return { view, api, store };
  };

  it("shows the site's title and logo", () => {
    const { store } = mount({ title: "Acme" });
    expect(root.querySelector("h1")!.textContent).toBe("Acme");
    expect(root.querySelector("h1 img")).toBeNull();
    store.set({ site: { ...DEFAULT_SITE, title: "Acme team", logo: "/logo.png" } });
    expect(root.querySelector("h1")!.textContent).toBe("Acme team");
    expect(root.querySelector<HTMLImageElement>("h1 img")!.getAttribute("src")).toBe("/logo.png");
    expect(root.querySelector("h1 img")!.getAttribute("alt")).toBe("");
  });

  it("asks for the invite code on signup only, and sends it", async () => {
    const api = newApi();
    let sent: Parameters<typeof api.signUp>[0] | undefined;
    intercept(api, "signUp", () => async (input) => {
      sent = input;
      return { id: "u1", name: input.name, avatar: "" };
    });
    mount({ inviteOnly: true }, api);
    expect(fieldNames(root)).toEqual(["name", "email", "password", "invite_code"]);
    tab(root, "Log in").click();
    expect(fieldNames(root)).toEqual(["email", "password"]);
    tab(root, "Sign up").click();
    fill(root, { name: "Grace", email: "grace@test.local", password: "password-123", invite_code: "open-sesame" });
    submit(root);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalled());
    expect(sent).toEqual({ name: "Grace", email: "grace@test.local", password: "password-123", inviteCode: "open-sesame" });
  });

  it("a wrong code is refused next to its field", async () => {
    const api = newApi();
    const refusal = new ApiError(
      "Failed to create record.",
      400,
      { invite_code: "This invite code isn't valid." },
      { invite_code: "validation_invalid_invite" },
    );
    instrument(api).failNext("signUp", refusal);
    mount({ inviteOnly: true }, api);
    fill(root, { name: "Grace", email: `${uniq()}@test.local`, password: "password-123", invite_code: "nope" });
    submit(root);
    await vi.waitFor(() => expect(root.querySelector('input[name="invite_code"]')!.getAttribute("aria-invalid")).toBe("true"));
    const input = root.querySelector<HTMLInputElement>('input[name="invite_code"]')!;
    expect(document.getElementById(input.getAttribute("aria-describedby")!)!.textContent).toBe("This invite code isn't valid.");
    expect(alertText(root)).toBe("");
  });

  it("without the field on screen (the site became invite-only meanwhile), the refusal shows above the button", async () => {
    const api = newApi();
    const refusal = new ApiError(
      "Failed to create record.",
      400,
      { invite_code: "Enter your invite code." },
      { invite_code: "validation_required" },
    );
    instrument(api).failNext("signUp", refusal);
    mount({}, api);
    fill(root, { name: "Grace", email: `${uniq()}@test.local`, password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).toBe("Enter your invite code."));
  });
});

describe("forgot password (§39)", () => {
  let root: HTMLElement;
  let onLogin: (u: User) => void;

  beforeEach(() => {
    root = document.createElement("main");
    document.body.append(root);
    onLogin = vi.fn();
  });
  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
  });

  const mount = (opts: { site?: Partial<Site>; mode?: "login" | "reset"; token?: string }, api = newApi()) => {
    const store = createStore<AppState>({ ...initialState(), site: { ...DEFAULT_SITE, ...opts.site } });
    const view = createLoginView({ api, onLogin, store, mode: opts.mode ?? "login" });
    view.mount(root, opts.token ? { token: opts.token } : {});
    return { view, api, store };
  };
  const button = (name: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === name);
  /** A token shaped like PocketBase's: its claims carry the email. */
  const tokenFor = (email: string) => `x.${btoa(JSON.stringify({ email, type: "passwordReset" })).replace(/=+$/, "")}.sig`;

  it("is offered only while the server sends email", () => {
    const { store } = mount({});
    expect(button("Forgot password?")).toBeUndefined();
    store.set({ site: { ...DEFAULT_SITE, passwordReset: true } });
    expect(button("Forgot password?")).toBeDefined();
    tab(root, "Sign up").click();
    expect(button("Forgot password?")).toBeUndefined();
  });

  it("asks for the email (the one typed to log in), sends the link, and says where it went", async () => {
    const api = newApi();
    let sent = "";
    intercept(api, "requestPasswordReset", () => async (email) => {
      sent = email;
    });
    mount({ site: { passwordReset: true } }, api);
    fill(root, { email: "ada@test.local" });
    button("Forgot password?")!.click();
    expect(root.querySelector("h2")!.textContent).toBe("Reset password");
    expect(root.querySelector('[role="tablist"]')).toBeNull();
    expect(fieldNames(root)).toEqual(["email"]);
    expect(root.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe("ada@test.local");
    submit(root);
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')!.textContent).toContain("If an account uses ada@test.local"));
    expect(sent).toBe("ada@test.local");
    expect(root.querySelector("form")).toBeNull();
    button("Back to log in")!.click();
    expect(tab(root, "Log in").getAttribute("aria-selected")).toBe("true");
  });

  it("the API sends the address in lower case, as emails are stored (QA BUG-47)", async () => {
    const api = newApi();
    await api.requestPasswordReset("  Ada@Test.Local ");
    // Resolves, as for every address: nothing tells whether it has an account.
    await expect(api.requestPasswordReset(`${uniq()}@test.local`)).resolves.toBeUndefined();
  });

  it("the link's page sets the new password and logs in with it", async () => {
    const ada = await signedUp("Ada");
    const api = newApi();
    let got: [string, string] | undefined;
    intercept(api, "confirmPasswordReset", () => async (token, password) => {
      got = [token, password];
    });
    const token = tokenFor(ada.email);
    mount({ mode: "reset", token }, api);
    expect(root.querySelector("h2")!.textContent).toBe("Set a new password");
    expect(fieldNames(root)).toEqual(["password"]);
    expect(root.querySelector('input[name="password"]')!.getAttribute("autocomplete")).toBe("new-password");
    fill(root, { password: ada.password });
    submit(root);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledWith({ id: ada.user.id, name: "Ada", avatar: "" }));
    expect(got).toEqual([token, ada.password]);
    expect(root.querySelector('a[href="/login"]')!.textContent).toBe("Back to log in");
  });

  it("if logging in afterwards fails, it says the password changed and offers Log in with the email filled", async () => {
    const api = newApi();
    intercept(api, "confirmPasswordReset", () => async () => {});
    instrument(api).failNext("logIn", new ApiError("Too many requests.", 429));
    mount({ mode: "reset", token: tokenFor("grace@test.local") }, api);
    fill(root, { password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).toBe("Your password was changed. Log in with it."));
    expect(tab(root, "Log in").getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe("grace@test.local");
  });

  it("an expired or used link says so; a short password is the browser's to refuse (minlength)", async () => {
    const api = newApi();
    mount({ mode: "reset", token: "not-a-token" }, api);
    expect(root.querySelector('input[name="password"]')!.getAttribute("minlength")).toBe("8");
    fill(root, { password: "password-123" });
    submit(root);
    await vi.waitFor(() => expect(alertText(root)).toBe("This link has expired or was already used. Ask for a new one."));
    expect(onLogin).not.toHaveBeenCalled();
  });
});
