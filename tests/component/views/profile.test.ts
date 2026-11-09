import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../web/src/api.ts";
import { PROFILE_KIT } from "../../../web/src/lazy.ts";
import { LIMITS } from "../../../web/src/lib/limits.ts";
import type { View } from "../../../web/src/router.ts";
import { type AppState, createStore, initialState, type Store } from "../../../web/src/store.ts";
import { avatarProblem, createProfileView, passwordProblem } from "../../../web/src/views/profile.ts";
import { instrument, newApi, type SignedUp, signedUp, viewContext } from "../../support/api.ts";
import { pngFile } from "../../support/files.ts";

describe("avatarProblem (§15.5)", () => {
  it("accepts the server's raster types up to 2 MB", () => {
    expect(avatarProblem(pngFile(), LIMITS)).toBe("");
    expect(avatarProblem(new File(["x"], "a.svg", { type: "image/svg+xml" }), LIMITS)).toMatch(/JPEG, PNG/);
    expect(avatarProblem(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "a.png", { type: "image/png" }), LIMITS)).toMatch(/too large/);
  });
});

describe("passwordProblem (§22.2)", () => {
  it("needs the current password, 8+ characters, a change, and the same text twice", () => {
    expect(passwordProblem("", "new-password", "new-password", LIMITS)).toEqual({ current: "Enter your current password." });
    expect(passwordProblem("old-password", "short", "short", LIMITS)).toEqual({ next: "Must be at least 8 characters." });
    expect(passwordProblem("same-password", "same-password", "same-password", LIMITS).next).toMatch(/current password/);
    expect(passwordProblem("old-password", "new-password", "new-passw0rd", LIMITS)).toEqual({ confirm: "The passwords don't match." });
    expect(passwordProblem("old-password", "new-password", "new-password", LIMITS)).toEqual({});
  });
});

describe("profile view (§15.5)", () => {
  let root: HTMLElement;
  let me: SignedUp;
  let store: Store<AppState>;
  let view: View | undefined;

  beforeEach(async () => {
    root = document.createElement("main");
    document.body.append(root);
    me = await signedUp("Ada Lovelace");
    store = createStore<AppState>({ ...initialState(), user: me.user });
  });
  afterEach(async () => {
    view?.unmount();
    view = undefined;
    root.remove();
    vi.restoreAllMocks();
    await me.api.unsubscribeAll();
  });

  let logOut: ReturnType<typeof vi.fn<() => void>>;
  function mount() {
    const ctx = viewContext(me.api, store, vi.fn());
    logOut = vi.fn<() => void>();
    view = createProfileView({ ...ctx, logOut, kit: PROFILE_KIT });
    view.mount(root, {});
  }

  const picture = () => root.querySelector(".profile-picture .avatar")!;
  const fileInput = () => root.querySelector<HTMLInputElement>("input[type=file]")!;
  const removeButton = () => [...root.querySelectorAll("button")].find((b) => b.textContent === "Remove")!;
  const avatarError = () => root.querySelector(".profile-avatar ~ .field-error")!.textContent;
  const nameInput = () => root.querySelector<HTMLInputElement>("form.profile-name input")!;
  const status = () => root.querySelector(".field-status")!;

  function choose(file: File) {
    Object.defineProperty(fileInput(), "files", { configurable: true, value: [file] });
    fileInput().dispatchEvent(new Event("change"));
  }

  it("shows initials without an avatar, and no Remove", () => {
    mount();
    expect(picture().textContent).toBe("AL");
    expect(removeButton().hidden).toBe(true);
    expect(nameInput().value).toBe("Ada Lovelace");
  });

  it("choosing a picture previews it at once, uploads it, and updates the logged-in user", async () => {
    const ctl = instrument(me.api);
    const release = ctl.hold("setAvatar");
    const created: string[] = [];
    const revoked: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      created.push(`blob:preview-${created.length}`);
      return created.at(-1)!;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
    mount();
    choose(pngFile("me.png"));
    await vi.waitFor(() => expect(picture().getAttribute("src")).toBe("blob:preview-0"));
    release();
    await vi.waitFor(() => expect(store.get().user?.avatar).toMatch(/\.png$/));
    expect(picture().getAttribute("src")).toContain("thumb=96x96");
    expect(revoked).toEqual(["blob:preview-0"]);
    expect(removeButton().hidden).toBe(false);
  });

  it("a failed upload restores the previous picture and says why", async () => {
    const ctl = instrument(me.api);
    ctl.failNext("setAvatar", new ApiError("Failed", 400, { avatar: "Invalid file." }));
    mount();
    choose(pngFile());
    await vi.waitFor(() => expect(avatarError()).toBe("Invalid file."));
    expect(picture().textContent).toBe("AL");
    expect(store.get().user?.avatar ?? "").toBe("");
  });

  it("refuses a non-image without uploading", async () => {
    const ctl = instrument(me.api);
    mount();
    choose(new File(["%PDF"], "doc.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(avatarError()).toMatch(/JPEG, PNG/));
    expect(ctl.calls("setAvatar")).toBe(0);
  });

  it("a file named and typed as an image that isn't one is refused in words, not the server's (QA BUG-122)", async () => {
    mount();
    choose(new File(["not an image at all"], "fake.png", { type: "image/png" }));
    await vi.waitFor(() => expect(avatarError()).toBe("Choose a JPEG, PNG, WebP or GIF image."));
    expect(picture().textContent).toBe("AL");
  });

  it("Remove clears the avatar", async () => {
    store.set({ user: await me.api.setAvatar(pngFile()) });
    mount();
    expect(picture().tagName).toBe("IMG");
    removeButton().click();
    await vi.waitFor(() => expect(store.get().user?.avatar).toBe(""));
    expect(picture().textContent).toBe("AL");
  });

  it("saves a new display name; blank and over-long names are refused locally", async () => {
    const ctl = instrument(me.api);
    mount();
    const submit = () => root.querySelector("form.profile-name")!.dispatchEvent(new Event("submit", { cancelable: true }));
    nameInput().value = "   ";
    submit();
    expect(status().textContent).toMatch(/can't be empty/);
    nameInput().value = "x".repeat(33);
    submit();
    expect(status().textContent).toMatch(/no more than 32/);
    expect(ctl.calls("rename")).toBe(0);

    nameInput().value = " Ada King ";
    submit();
    await vi.waitFor(() => expect(store.get().user?.name).toBe("Ada King"));
    expect(status().textContent).toBe("Saved.");
    expect(nameInput().getAttribute("aria-invalid")).toBeNull();
    // QA BUG-203: the Session card says the new name too.
    expect(root.querySelector(".profile-session")!.textContent).toContain("Signed in as Ada King on this device.");
  });

  it("a display name someone else has is refused (§22.1)", async () => {
    const other = await signedUp();
    mount();
    nameInput().value = other.user.name.toUpperCase();
    root.querySelector("form.profile-name")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(status().textContent).toBe("This display name is taken. Choose another one."));
    expect(nameInput().getAttribute("aria-invalid")).toBe("true");
    expect(store.get().user?.name).toBe("Ada Lovelace");
    await other.api.unsubscribeAll();
  });

  it("QA BUG-75: a rename in another tab shows here, so Save can't quietly undo it; a name being typed stays", () => {
    mount();
    // The other tab saved: the session (shared by the tabs) brings the new name to this one's store (BUG-33).
    store.set({ user: { ...me.user, name: "Ada King" } });
    expect(nameInput().value).toBe("Ada King");
    nameInput().value = "Countess";
    store.set({ user: { ...me.user, name: "Ada Byron" } });
    expect(nameInput().value).toBe("Countess");
  });

  it("QA BUG-56: putting your own name back after a refusal clears the error", async () => {
    const other = await signedUp();
    mount();
    const submit = () => root.querySelector("form.profile-name")!.dispatchEvent(new Event("submit", { cancelable: true }));
    nameInput().value = other.user.name;
    submit();
    await vi.waitFor(() => expect(status().textContent).toBe("This display name is taken. Choose another one."));
    nameInput().value = "Ada Lovelace";
    submit();
    expect(status().textContent).toBe("");
    expect(status().classList.contains("error")).toBe(false);
    expect(nameInput().getAttribute("aria-invalid")).toBeNull();
    await other.api.unsubscribeAll();
  });

  describe("changing the password (§22.2)", () => {
    const pw = (name: string) => root.querySelector<HTMLInputElement>(`form.profile-password input[name="${name}"]`)!;
    const errorOf = (name: string) => document.getElementById(pw(name).getAttribute("aria-describedby")!)!.textContent;
    const pwStatus = () => root.querySelector("form.profile-password .field-status")!.textContent;
    function fill(current: string, next: string, confirm = next) {
      pw("current").value = current;
      pw("next").value = next;
      pw("confirm").value = confirm;
      root.querySelector("form.profile-password")!.dispatchEvent(new Event("submit", { cancelable: true }));
    }

    it("checks the fields locally first, next to each one", () => {
      const ctl = instrument(me.api);
      mount();
      fill(me.password, "new-password-1", "something else");
      expect(errorOf("confirm")).toBe("The passwords don't match.");
      expect(pw("confirm").getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(pw("confirm"));
      fill(me.password, "short");
      expect(errorOf("next")).toBe("Must be at least 8 characters.");
      expect(errorOf("confirm")).toBe("");
      expect(ctl.calls("changePassword")).toBe(0);
    });

    it("a wrong current password is said next to it, and nothing changes", async () => {
      mount();
      fill("not-my-password", "new-password-1");
      await vi.waitFor(() => expect(errorOf("current")).toBe("That isn't your current password."));
      expect(pw("current").getAttribute("aria-invalid")).toBe("true");
      await newApi().logIn(me.email, me.password); // still the old one
    });

    it("changes it: the fields empty, this tab stays logged in, and the new password logs in", async () => {
      mount();
      fill(me.password, "new-password-1");
      await vi.waitFor(() => expect(pwStatus()).toBe("Password changed. You were logged out everywhere else."));
      expect([pw("current").value, pw("next").value, pw("confirm").value]).toEqual(["", "", ""]);
      expect(store.get().user?.id).toBe(me.user.id);
      expect((await me.api.refreshAuth()).id).toBe(me.user.id); // the fresh token works
      const again = newApi();
      await expect(again.logIn(me.email, me.password)).rejects.toThrow();
      expect((await again.logIn(me.email, "new-password-1")).id).toBe(me.user.id);
    });
  });

  it("Appearance switches this device's theme: Auto, Light, Dark (§7.8)", () => {
    localStorage.removeItem("chat.theme");
    mount();
    const radio = (label: string) =>
      [...root.querySelectorAll<HTMLLabelElement>(".profile-theme label")].find((l) => l.textContent === label)!.querySelector("input")!;
    expect(radio("Auto").checked).toBe(true);
    radio("Dark").click();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("chat.theme")).toBe("dark");
    radio("Auto").click();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(localStorage.getItem("chat.theme")).toBeNull();
    // Chosen in another tab.
    localStorage.setItem("chat.theme", "light");
    dispatchEvent(new StorageEvent("storage", { key: "chat.theme" }));
    expect(radio("Light").checked).toBe(true);
    localStorage.removeItem("chat.theme");
  });

  it("Log out is here (§22.2)", () => {
    mount();
    const btn = [...root.querySelectorAll("button")].find((b) => b.textContent === "Log out")!;
    btn.click();
    expect(logOut).toHaveBeenCalledOnce();
  });
});
