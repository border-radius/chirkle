// Profile (§15.5, §22.2): change or remove your avatar, change your display name (unique, §22.1), pick this
// device's theme (§7.8) and notifications (§34, a lazy chunk), change your password, log out.
//
// A lazy chunk: app.ts loads it for /me. It imports types only, and gets what it uses of app.js in `kit` (lazy.ts
// PROFILE_KIT).

import type { ApiError, errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import type { clear, h, uniqueId } from "../dom.ts";
import type { prepareImage } from "../lib/image.ts";
import type { LIMITS, textLength } from "../lib/limits.ts";
import type { User } from "../lib/types.ts";
import type { View } from "../router.ts";
import type { createScope } from "../scope.ts";
import type { savedTheme, setTheme, THEME_KEY, THEMES, Theme } from "../theme.ts";
import type { avatar } from "../ui/avatar.ts";

export interface ProfileKit {
  h: typeof h;
  clear: typeof clear;
  uniqueId: typeof uniqueId;
  avatar: typeof avatar;
  ApiError: typeof ApiError;
  errorMessage: typeof errorMessage;
  prepareImage: typeof prepareImage;
  LIMITS: typeof LIMITS;
  textLength: typeof textLength;
  createScope: typeof createScope;
  savedTheme: typeof savedTheme;
  setTheme: typeof setTheme;
  THEME_KEY: typeof THEME_KEY;
  THEMES: typeof THEMES;
}

/** Longest edge of an uploaded avatar (§15.3). */
const AVATAR_EDGE = 512;

const NOT_AN_IMAGE = "Choose a JPEG, PNG, WebP or GIF image.";

/** Why `file` can't be an avatar (after preparation), or "". */
export function avatarProblem(file: File, LIMITS: ProfileKit["LIMITS"]): string {
  if (!(LIMITS.avatarTypes as readonly string[]).includes(file.type)) return NOT_AN_IMAGE;
  if (file.size > LIMITS.avatarBytes) return `That image is too large (max ${LIMITS.avatarBytes / 1024 / 1024} MB).`;
  return "";
}

/** Why a new password can't be used, or "" (the server checks again). */
export function passwordProblem(
  current: string,
  next: string,
  confirm: string,
  LIMITS: ProfileKit["LIMITS"],
): Partial<Record<"current" | "next" | "confirm", string>> {
  if (!current) return { current: "Enter your current password." };
  if (next.length < LIMITS.passwordMin) return { next: `Must be at least ${LIMITS.passwordMin} characters.` };
  if (next === current) return { next: "That is your current password. Choose a new one." };
  if (confirm !== next) return { confirm: "The passwords don't match." };
  return {};
}

export function createProfileView({
  kit,
  api,
  store,
  logOut,
  notify,
}: Pick<Ctx, "api" | "store" | "logOut" | "notify"> & { kit: ProfileKit }): View {
  const { h, clear, uniqueId, avatar, ApiError, errorMessage, prepareImage, LIMITS, textLength, createScope } = kit;
  const { savedTheme, setTheme, THEME_KEY, THEMES } = kit;
  const fieldMessage = (e: unknown, field: string) => (e instanceof ApiError && e.fields[field]) || errorMessage(e);
  const vid = uniqueId("profile");
  const scope = createScope();
  const { signal } = scope;
  let root: HTMLElement;
  let preview: string | null = null;
  let busy = false;

  const me = () => store.get().user;

  const picture = h("div", { class: "profile-picture" });
  const fileInput = h("input", {
    id: `${vid}-file`,
    type: "file",
    accept: LIMITS.avatarTypes.join(","),
    class: "visually-hidden",
  });
  const changeLabel = h("label", { for: `${vid}-file`, class: "button" }, "Change picture");
  const removeBtn = h("button", { type: "button" }, "Remove");
  const avatarError = h("p", { class: "field-error", role: "alert" });

  const signedIn = h("p", { class: "field-status" });
  const showSignedIn = () => (signedIn.textContent = `Signed in as ${me()?.name ?? ""} on this device.`);
  showSignedIn();
  const nameInput = h("input", { id: `${vid}-name`, name: "name", autocomplete: "nickname", "aria-describedby": `${vid}-name-status` });
  const saveBtn = h("button", { type: "submit", class: "primary" }, "Save");
  const nameStatus = h("p", { id: `${vid}-name-status`, class: "field-status", role: "status" });
  // The handle (§41): what "@handle" names in messages.
  const handleInput = h("input", {
    id: `${vid}-handle`,
    name: "handle",
    autocomplete: "username",
    autocapitalize: "none",
    spellcheck: false,
    "aria-describedby": `${vid}-handle-status`,
  });
  const handleBtn = h("button", { type: "submit", class: "primary" }, "Save");
  const handleStatus = h("p", { id: `${vid}-handle-status`, class: "field-status", role: "status" }, "People mention you by it: @handle.");

  // Password (§22.2): each field with its own error under it.
  const pwField = (key: "current" | "next" | "confirm", label: string, autocomplete: string) => {
    const id = `${vid}-pw-${key}`;
    const input = h("input", {
      id,
      type: "password",
      name: key,
      autocomplete,
      required: true,
      ...(key === "current" ? {} : { minlength: LIMITS.passwordMin }),
      "aria-describedby": `${id}-error`,
    });
    const error = h("p", { id: `${id}-error`, class: "field-error" });
    const el = h("div", { class: "field" }, [h("label", { for: id }, label), input, error]);
    return { input, error, el };
  };
  const pw = {
    current: pwField("current", "Current password", "current-password"),
    next: pwField("next", "New password", "new-password"),
    confirm: pwField("confirm", "Confirm new password", "new-password"),
  };
  const pwBtn = h("button", { type: "submit", class: "primary" }, "Change password");
  const pwStatus = h("p", { class: "field-status", role: "status" });

  // Appearance (§7.8): this device's theme, not the account's.
  const THEME_LABELS: Record<Theme, string> = { auto: "Auto", light: "Light", dark: "Dark" };
  const themeRadios = new Map<Theme, HTMLInputElement>();
  const themeChoices = h("div", { class: "segmented" }, [
    ...THEMES.map((t) => {
      const input = h("input", { type: "radio", name: `${vid}-theme`, value: t });
      themeRadios.set(t, input);
      return h("label", {}, [input, THEME_LABELS[t]]);
    }),
  ]);
  const showTheme = () => {
    const theme = savedTheme();
    for (const [t, input] of themeRadios) input.checked = t === theme;
  };

  // Notifications (§34): their settings come with notify.ts, a lazy chunk.
  const notifyBox = h("div");

  function dropPreview() {
    if (preview) URL.revokeObjectURL(preview);
    preview = null;
  }

  function renderPicture() {
    const user = me();
    if (!user) return;
    const shown = preview
      ? h("img", { class: "avatar s96", src: preview, width: 96, height: 96, alt: "" })
      : avatar(user, 96, api.avatarUrl);
    picture.replaceChildren(shown);
    picture.classList.toggle("busy", busy);
    removeBtn.hidden = !user.avatar || busy;
    fileInput.disabled = busy;
    changeLabel.classList.toggle("disabled", busy);
  }

  async function upload(file: File | undefined) {
    if (!file || busy) return;
    avatarError.textContent = "";
    // Check the type before decoding; the size after preparation (which usually shrinks it).
    const typeProblem = avatarProblem(new File([], file.name, { type: file.type }), LIMITS);
    if (typeProblem) {
      avatarError.textContent = typeProblem;
      return;
    }
    busy = true;
    const prepared = await prepareImage(file, AVATAR_EDGE);
    if (!scope.active) return;
    const problem = avatarProblem(prepared, LIMITS);
    if (problem) {
      busy = false;
      avatarError.textContent = problem;
      return;
    }
    dropPreview();
    preview = URL.createObjectURL(prepared);
    renderPicture();
    await save(() => api.setAvatar(prepared));
  }

  async function save(call: () => Promise<User>) {
    busy = true;
    renderPicture();
    try {
      const user = await call();
      if (!scope.active) return;
      store.set({ user });
    } catch (e) {
      // The server goes by what the file is, not its name: one that only looks like an image (QA BUG-122).
      const notImage = e instanceof ApiError && e.codes.avatar === "validation_invalid_mime_type";
      if (scope.active) avatarError.textContent = notImage ? NOT_AN_IMAGE : fieldMessage(e, "avatar");
    } finally {
      if (scope.active) {
        busy = false;
        dropPreview();
        renderPicture();
      }
    }
  }

  /** Save the display name (§22.1) or the handle (§41), with what is wrong with it said under it. */
  async function saveField(e: Event, key: "name" | "handle") {
    e.preventDefault();
    const [input, status, btn] = key === "name" ? [nameInput, nameStatus, saveBtn] : [handleInput, handleStatus, handleBtn];
    const value = key === "name" ? input.value.trim() : input.value.trim().replace(/^@/, "").toLowerCase();
    status.classList.remove("error");
    const problem =
      key === "handle"
        ? /^[a-z0-9_]{3,24}$/.test(value)
          ? ""
          : "Use 3 to 24 letters a–z, digits or underscores."
        : !value
          ? "A display name can't be empty."
          : textLength(value) > LIMITS.userName
            ? `Must be no more than ${LIMITS.userName} characters.`
            : "";
    if (problem) {
      status.textContent = problem;
      status.classList.add("error");
      input.setAttribute("aria-invalid", "true");
      return;
    }
    // Your own one back (after "taken", say): nothing to save, and nothing wrong any more (QA BUG-56).
    status.textContent = "";
    input.removeAttribute("aria-invalid");
    if (value === me()?.[key]) return;
    btn.disabled = true;
    try {
      const user = await (key === "name" ? api.rename(value) : api.setHandle(value));
      if (!scope.active) return;
      store.set({ user });
      input.value = user[key] ?? "";
      status.textContent = "Saved.";
    } catch (err) {
      if (!scope.active) return;
      status.textContent = fieldMessage(err, key);
      status.classList.add("error");
      input.setAttribute("aria-invalid", "true");
    } finally {
      btn.disabled = false;
    }
  }

  function showPasswordErrors(errors: Partial<Record<keyof typeof pw, string>>) {
    for (const [key, f] of Object.entries(pw) as [keyof typeof pw, (typeof pw)[keyof typeof pw]][]) {
      const msg = errors[key] ?? "";
      f.error.textContent = msg;
      if (msg) f.input.setAttribute("aria-invalid", "true");
      else f.input.removeAttribute("aria-invalid");
    }
    const first = (Object.keys(pw) as (keyof typeof pw)[]).find((k) => errors[k]);
    if (first) pw[first].input.focus();
  }

  async function changePassword(e: Event) {
    e.preventDefault();
    const current = pw.current.input.value;
    const next = pw.next.input.value;
    pwStatus.textContent = "";
    pwStatus.classList.remove("error");
    const problem = passwordProblem(current, next, pw.confirm.input.value, LIMITS);
    showPasswordErrors(problem);
    if (Object.keys(problem).length) return;
    pwBtn.disabled = true;
    try {
      const user = await api.changePassword(current, next);
      if (!scope.active) return;
      store.set({ user });
      for (const f of Object.values(pw)) f.input.value = "";
      pwStatus.textContent = "Password changed. You were logged out everywhere else.";
    } catch (err) {
      if (!scope.active) return;
      const fields = err instanceof ApiError ? err.fields : {};
      if (fields.oldPassword || fields.password) {
        showPasswordErrors({
          ...(fields.oldPassword ? { current: fields.oldPassword } : {}),
          ...(fields.password ? { next: fields.password } : {}),
        });
      } else {
        pwStatus.textContent = errorMessage(err);
        pwStatus.classList.add("error");
      }
    } finally {
      if (scope.active) pwBtn.disabled = false;
    }
  }

  return {
    mount(el) {
      root = el;
      nameInput.value = me()?.name ?? "";
      handleInput.value = me()?.handle ?? "";
      fileInput.addEventListener(
        "change",
        () => {
          const file = fileInput.files?.[0];
          fileInput.value = ""; // picking the same file again must fire `change` again
          void upload(file);
        },
        { signal },
      );
      removeBtn.addEventListener("click", () => void save(() => api.removeAvatar()), { signal });
      // Drag and drop an image onto the picture.
      picture.addEventListener("dragover", (e) => e.preventDefault(), { signal });
      picture.addEventListener(
        "drop",
        (e) => {
          e.preventDefault();
          void upload(e.dataTransfer?.files[0]);
        },
        { signal },
      );

      const shell = h("section", { class: "profile", "aria-labelledby": `${vid}-title` }, [
        h("header", { class: "room-header" }, [
          h("a", { href: "/", class: "back ic i-back", "aria-label": "Back to rooms" }),
          h("h1", { id: `${vid}-title` }, "Settings"),
        ]),
        // A card for each: the picture and name, Appearance, Notifications, Password, Session.
        h("div", { class: "profile-body" }, [
          h("section", { class: "card", "aria-label": "Profile" }, [
            h("div", { class: "profile-avatar" }, [
              picture,
              h("div", {}, [
                h("h2", {}, "Profile picture"),
                h("div", { class: "profile-avatar-actions" }, [fileInput, changeLabel, removeBtn]),
              ]),
            ]),
            avatarError,
            h("form", { class: "profile-name", on: { submit: (e) => void saveField(e, "name") }, signal }, [
              h("label", { for: `${vid}-name` }, "Display name"),
              h("div", { class: "row" }, [nameInput, saveBtn]),
              nameStatus,
            ]),
            h("form", { class: "profile-name", on: { submit: (e) => void saveField(e, "handle") }, signal }, [
              h("label", { for: `${vid}-handle` }, "Handle"),
              h("div", { class: "row" }, [handleInput, handleBtn]),
              handleStatus,
            ]),
          ]),
          h("fieldset", { class: "card profile-theme", "aria-describedby": `${vid}-theme-hint` }, [
            h("legend", {}, "Appearance"),
            h("p", { id: `${vid}-theme-hint`, class: "field-status" }, "Auto follows your system. Saved on this device."),
            themeChoices,
          ]),
          notifyBox,
          h(
            "form",
            {
              class: "card profile-password",
              "aria-labelledby": `${vid}-pw-title`,
              novalidate: true, // the errors are ours, next to each field
              on: { submit: (e) => void changePassword(e) },
              signal,
            },
            [h("h2", { id: `${vid}-pw-title` }, "Password"), pw.current.el, pw.next.el, pw.confirm.el, pwBtn, pwStatus],
          ),
          // Moderators see the usage statistics (§40), a page of its own.
          store.get().user?.moderator
            ? h("section", { class: "card profile-session", "aria-labelledby": `${vid}-stats-title` }, [
                h("div", {}, [
                  h("h2", { id: `${vid}-stats-title` }, "Moderation"),
                  h("p", { class: "field-status" }, "How many people are online and use the app, as counts."),
                ]),
                h("a", { href: "/stats" }, "Usage statistics"),
              ])
            : null,
          h("section", { class: "card profile-session", "aria-labelledby": `${vid}-session-title` }, [
            h("div", {}, [h("h2", { id: `${vid}-session-title` }, "Session"), signedIn]),
            h("button", { type: "button", class: "danger", on: { click: () => logOut() }, signal }, "Log out"),
          ]),
        ]),
      ]);
      clear(root);
      root.append(shell);
      renderPicture();
      showTheme();
      void import("../notify.ts").then(
        (m) => scope.active && notifyBox.replaceWith(m.notifySettings({ h, id: vid, onChange: notify, signal })),
        () => {},
      );
      themeChoices.addEventListener(
        "change",
        (e) => {
          const t = (e.target as HTMLInputElement).value as Theme;
          if ((THEMES as readonly string[]).includes(t)) setTheme(t);
        },
        { signal },
      );
      // Chosen in another tab (theme.ts applies it): show it here too.
      addEventListener("storage", (e) => (e.key === THEME_KEY || e.key === null) && showTheme(), { signal });
      scope.defer(
        store.subscribe((s, prev) => {
          if (s.user === prev.user) return;
          renderPicture();
          showSignedIn(); // renamed here or in another tab (QA BUG-203)
          // Renamed in another tab: show the new name, unless a change is being typed here. Saving the old one
          // would quietly undo the rename.
          if (s.user && nameInput.value.trim() === prev.user?.name) nameInput.value = s.user.name;
          if (s.user && handleInput.value.trim() === (prev.user?.handle ?? "")) handleInput.value = s.user.handle ?? "";
        }),
      );
      scope.defer(dropPreview);
    },
    unmount() {
      scope.dispose();
      clear(root);
    },
  };
}
