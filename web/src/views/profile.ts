// Profile (§15.5, §22.2): change or remove your avatar, change your display name (unique, §22.1), pick this
// device's theme (§7.8) and notifications (§34, a lazy chunk), change your password, log out.
//
// A lazy chunk: app.ts loads it for /me.

import { ApiError, errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { clear, h, uniqueId } from "../dom.ts";
import { prepareImage } from "../lib/image.ts";
import { LIMITS, textLength } from "../lib/limits.ts";
import type { User } from "../lib/types.ts";
import type { View } from "../router.ts";
import { createScope } from "../scope.ts";
import * as S from "../strings/profile.ts";
import { savedTheme, setTheme, THEME_KEY, THEMES, type Theme } from "../theme.ts";
import { avatar } from "../ui/avatar.ts";

/** Longest edge of an uploaded avatar (§15.3). */
const AVATAR_EDGE = 512;

const NOT_AN_IMAGE = S.CHOOSE_A_JPEG_PNG_WEBP_OR;

/** Why `file` can't be an avatar (after preparation), or "". */
export function avatarProblem(file: File, limits = LIMITS): string {
  if (!(limits.avatarTypes as readonly string[]).includes(file.type)) return NOT_AN_IMAGE;
  if (file.size > limits.avatarBytes) return S.thatImageIsTooLargeMax(limits.avatarBytes / 1024 / 1024);
  return "";
}

/** Why a new password can't be used, or "" (the server checks again). */
export function passwordProblem(
  current: string,
  next: string,
  confirm: string,
  limits = LIMITS,
): Partial<Record<"current" | "next" | "confirm", string>> {
  if (!current) return { current: S.ENTER_YOUR_CURRENT_PASSWORD };
  if (next.length < limits.passwordMin) return { next: S.mustBeAtLeastCharacters(limits.passwordMin) };
  if (next === current) return { next: S.THAT_IS_YOUR_CURRENT_PASSWORD_CHOOSE };
  if (confirm !== next) return { confirm: S.THE_PASSWORDS_DONT_MATCH };
  return {};
}

export function createProfileView({ api, store, logOut, notify }: Pick<Ctx, "api" | "store" | "logOut" | "notify">): View {
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
  const changeLabel = h("label", { for: `${vid}-file`, class: "button" }, S.CHANGE_PICTURE);
  const removeBtn = h("button", { type: "button" }, S.REMOVE);
  const avatarError = h("p", { class: "field-error", role: "alert" });

  const signedIn = h("p", { class: "field-status" });
  const showSignedIn = () => (signedIn.textContent = S.signedInAsOnThisDevice(me()?.name ?? ""));
  showSignedIn();
  const nameInput = h("input", { id: `${vid}-name`, name: "name", autocomplete: "nickname", "aria-describedby": `${vid}-name-status` });
  const saveBtn = h("button", { type: "submit", class: "primary" }, S.SAVE);
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
  const handleBtn = h("button", { type: "submit", class: "primary" }, S.SAVE);
  const handleStatus = h("p", { id: `${vid}-handle-status`, class: "field-status", role: "status" }, S.PEOPLE_MENTION_YOU_BY_IT_HANDLE);

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
    current: pwField("current", S.CURRENT_PASSWORD, "current-password"),
    next: pwField("next", S.NEW_PASSWORD, "new-password"),
    confirm: pwField("confirm", S.CONFIRM_NEW_PASSWORD, "new-password"),
  };
  const pwBtn = h("button", { type: "submit", class: "primary" }, S.CHANGE_PASSWORD);
  const pwStatus = h("p", { class: "field-status", role: "status" });

  // Appearance (§7.8): this device's theme, not the account's.
  const THEME_LABELS: Record<Theme, string> = { auto: S.AUTO, light: S.LIGHT, dark: S.DARK };
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
          : S.USE_3_TO_24_LETTERS_A
        : !value
          ? S.A_DISPLAY_NAME_CANT_BE_EMPTY
          : textLength(value) > LIMITS.userName
            ? S.mustBeNoMoreThanCharacters(LIMITS.userName)
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
      status.textContent = S.SAVED;
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
      pwStatus.textContent = S.PASSWORD_CHANGED_YOU_WERE_LOGGED_OUT;
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
          h("a", { href: "/", class: "back ic i-back", "aria-label": S.BACK_TO_ROOMS }),
          h("h1", { id: `${vid}-title` }, S.SETTINGS),
        ]),
        // A card for each: the picture and name, Appearance, Notifications, Password, Session.
        h("div", { class: "profile-body" }, [
          h("section", { class: "card", "aria-label": S.PROFILE }, [
            h("div", { class: "profile-avatar" }, [
              picture,
              h("div", {}, [
                h("h2", {}, S.PROFILE_PICTURE),
                h("div", { class: "profile-avatar-actions" }, [fileInput, changeLabel, removeBtn]),
              ]),
            ]),
            avatarError,
            h("form", { class: "profile-name", on: { submit: (e) => void saveField(e, "name") }, signal }, [
              h("label", { for: `${vid}-name` }, S.DISPLAY_NAME),
              h("div", { class: "row" }, [nameInput, saveBtn]),
              nameStatus,
            ]),
            h("form", { class: "profile-name", on: { submit: (e) => void saveField(e, "handle") }, signal }, [
              h("label", { for: `${vid}-handle` }, S.HANDLE),
              h("div", { class: "row" }, [handleInput, handleBtn]),
              handleStatus,
            ]),
          ]),
          h("fieldset", { class: "card profile-theme", "aria-describedby": `${vid}-theme-hint` }, [
            h("legend", {}, S.APPEARANCE),
            h("p", { id: `${vid}-theme-hint`, class: "field-status" }, S.AUTO_FOLLOWS_YOUR_SYSTEM_SAVED_ON),
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
            [h("h2", { id: `${vid}-pw-title` }, S.PASSWORD), pw.current.el, pw.next.el, pw.confirm.el, pwBtn, pwStatus],
          ),
          // Moderators see the usage statistics (§40), a page of its own.
          store.get().user?.moderator
            ? h("section", { class: "card profile-session", "aria-labelledby": `${vid}-stats-title` }, [
                h("div", {}, [
                  h("h2", { id: `${vid}-stats-title` }, S.MODERATION),
                  h("p", { class: "field-status" }, S.HOW_MANY_PEOPLE_ARE_ONLINE_AND),
                ]),
                h("a", { href: "/stats" }, S.USAGE_STATISTICS),
              ])
            : null,
          h("section", { class: "card profile-session", "aria-labelledby": `${vid}-session-title` }, [
            h("div", {}, [h("h2", { id: `${vid}-session-title` }, S.SESSION), signedIn]),
            h("button", { type: "button", class: "danger", on: { click: () => logOut() }, signal }, S.LOG_OUT),
          ]),
        ]),
      ]);
      clear(root);
      root.append(shell);
      renderPicture();
      showTheme();
      void import("../notify.ts").then(
        (m) => scope.active && notifyBox.replaceWith(m.notifySettings({ id: vid, onChange: notify, signal })),
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
