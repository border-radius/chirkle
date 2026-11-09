// Message composer (§7.6, §17.4): auto-growing textarea, character counter, Enter to send, Shift+Enter for a
// newline, Up arrow in an empty composer to edit your last message, Ctrl+Up/Down to pick the message replied to, attachments (picker, paste, drop) shown
// in a tray above the textarea, the message being replied to (§19) above that, and an emoji button (§20.4). Typing
// ":name" asks for emoji suggestions (§20.6). Ctrl+/ (⌘/) anywhere in the room focuses it, which a key badge says while
// it isn't focused (§7.6).

import { h } from "../../dom.ts";
import { checkFiles, formatBytes, isVideo } from "../../lib/files.ts";
import { prepareImage } from "../../lib/image.ts";
import { LIMITS, textLength } from "../../lib/limits.ts";
import type { LocalFile } from "../../lib/types.ts";
import { collectionIcon } from "../../ui/icon.ts";
import { createActionMenu } from "../../ui/menu.ts";

const MAX_LEN = LIMITS.messageText;
const COUNTER_FROM = 1800;
const MAX_ROWS = 6;

/** Zero-width and bidi format characters: text made only of these is blank to the server (INVISIBLE in pb_hooks/lib/text.js). */
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** Does trimmed `t` show anything? The server refuses text that doesn't (QA BUG-42). */
const isBlank = (t: string) => t.replace(INVISIBLE, "").trim() === "";

/** Trimmed text that may be sent or saved, or null. Length in code points, as the server counts it. */
export function validText(raw: string): string | null {
  const t = raw.trim();
  return !isBlank(t) && textLength(t) <= MAX_LEN ? t : null;
}

/** Like validText, but next to attachments the text may be empty (§17.1). */
export function validEdit(raw: string, hasFiles: boolean): string | null {
  if (!hasFiles) return validText(raw);
  const t = raw.trim();
  return textLength(t) <= MAX_LEN ? t : null;
}

/** Longest edge of an attached image after preparation (§15.3). */
const IMAGE_EDGE = 2048;

/** Images get a preview in the tray (never SVG: it is shown as a file), and so do videos (their first frame). */
const previewable = (f: File) => f.type.startsWith("image/") && f.type !== "image/svg+xml";

/**
 * Why an edit of `raw` can't be saved, as a sentence; "" when it can. A message with attachments may be left
 * without text (§17.1).
 */
export function editProblem(raw: string, hasFiles = false): string {
  const len = textLength(raw.trim());
  if (isBlank(raw) && !hasFiles) return "A message can't be empty. Use Delete to remove it.";
  return len > MAX_LEN ? `Too long: ${len - MAX_LEN} characters over the ${MAX_LEN} limit.` : "";
}

/**
 * Is this key part of typing with an input method (IME)? Safari ends the composition before the keydown of the Enter
 * that confirms it, so only its keyCode (229) says so: without it, picking a Japanese or Chinese word would send.
 */
export const composing = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229;

/** Rows for a textarea showing `text` (grows with its lines, up to 6). */
export const rowsFor = (text: string) => Math.min(MAX_ROWS, text.split("\n").length);

/**
 * Size a textarea to its content, up to 6 rows, counting lines that wrap as well as explicit newlines.
 * Without layout (scrollHeight 0, e.g. in tests) it falls back to counting newlines.
 */
export function fitRows(t: HTMLTextAreaElement): void {
  t.rows = 1;
  const style = getComputedStyle(t);
  const line = Number.parseFloat(style.lineHeight) || 1.2 * (Number.parseFloat(style.fontSize) || 16);
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const wrapped = t.scrollHeight > 0 ? Math.round((t.scrollHeight - padding) / line) : 0;
  t.rows = Math.min(MAX_ROWS, Math.max(rowsFor(t.value), wrapped, 1));
}

export interface Composer {
  readonly el: HTMLFormElement;
  /** The text typed so far (a draft to keep), and replacing it. */
  text(): string;
  setText(text: string): void;
  setPlaceholder(text: string): void;
  focus(): void;
  /** Add attachments (e.g. dropped on the room). Images are prepared first (§15.3). */
  addFiles(files: readonly File[]): Promise<void>;
  /** Add items from collections (§31): they go after the uploads, as the server attaches them. */
  addItems(items: readonly LocalFile[]): void;
  /** Show who and what the next message replies to (§19), or nothing. */
  setReply(reply: { name: string; text: string } | null): void;
}

export function createComposer(opts: {
  id: string;
  /**
   * Called with trimmed text (valid, or "" when there are attachments) and the attachments. Return false to
   * refuse (everything stays in the composer). On true, the attachments' preview URLs belong to the caller.
   */
  onSend: (text: string, files: LocalFile[]) => boolean;
  /** Up arrow in an empty composer. Return true if it was handled (an edit started). */
  onEditLast: () => boolean;
  /** Ctrl+Up / Ctrl+Down: reply to an older (-1) or newer (1) message. Return true if it was handled. */
  onStepReply?: (dir: -1 | 1) => boolean;
  /** The reply bar's × (or Escape in the textarea while replying). */
  onCancelReply: () => void;
  /** The emoji button: open the picker next to it; `insert` puts the chosen emoji at the caret. */
  onEmoji: (opener: HTMLElement, insert: (emoji: string) => void) => void;
  /** ":" and two letters typed before the caret: offer emoji by name (§20.6). Those follow the textarea from then on. */
  onEmojiName?: (textarea: HTMLTextAreaElement) => void;
  /** An "@" typed (§41): offer people by handle. Those follow the textarea from then on. */
  onMention?: (textarea: HTMLTextAreaElement) => void;
  /** The text changed (typed, inserted, sent or replaced): e.g. to keep it as a draft. */
  onChange?: (text: string) => void;
  /** Attach from collections (§31): offer at most `room` items next to `opener` (they come back through addItems). */
  onCollections?: (opener: HTMLElement, room: number) => void;
  signal: AbortSignal;
}): Composer {
  const { signal } = opts;
  const mac = /Mac|iP/.test(navigator.platform);
  const textarea = h("textarea", {
    name: "text",
    rows: 1,
    id: opts.id,
    autocomplete: "off",
    "aria-keyshortcuts": mac ? "Meta+/" : "Control+/",
  });
  // The placeholder as given, and cut to the box with "…": browsers ignore text-overflow on a textarea's placeholder,
  // so a long room or person name was cut off mid-word.
  let placeholder = "";
  let measure: CanvasRenderingContext2D | null | undefined;
  function fitPlaceholder() {
    let text = placeholder;
    measure ??= document.createElement("canvas").getContext?.("2d");
    const width = textarea.clientWidth - 12;
    if (measure && width > 0) {
      // Not the `font` shorthand: it reads "" while font-feature-settings is set (BUG-191).
      const css = getComputedStyle(textarea);
      measure.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
      while (text.length > 1 && measure.measureText(text === placeholder ? text : `${text}…`).width > width) text = text.slice(0, -1);
      if (text !== placeholder) text = `${text.trimEnd()}…`;
    }
    if (textarea.placeholder !== text) textarea.placeholder = text;
  }
  if (typeof ResizeObserver === "function") {
    const resizes = new ResizeObserver(fitPlaceholder);
    resizes.observe(textarea);
    signal.addEventListener("abort", () => resizes.disconnect());
  }
  const counter = h("span", { class: "counter", "aria-live": "polite" });
  const sendBtn = h("button", { type: "submit", class: "send ic i-send", "aria-label": "Send", title: "Send", disabled: true });
  const fileInput = h("input", {
    id: `${opts.id}-files`,
    type: "file",
    multiple: true,
    class: "visually-hidden",
    tabindex: -1,
    "aria-label": "Attach files",
  });
  const { onCollections } = opts;
  // With collections (§31) the paperclip offers both; without, it opens the file chooser.
  const attachMenu = onCollections && createActionMenu({ label: "Attach", icon: "i-clip", className: "attach", signal });
  attachMenu?.update([
    { label: "Upload file", hint: "Photo, video or document", icon: "i-upload", run: () => fileInput.click() },
    {
      label: "From collection",
      hint: "Pick from your saved media",
      icon: "i-media",
      run: () => onCollections!(attachMenu.el.firstElementChild as HTMLElement, Math.max(0, LIMITS.attachments - files.length)),
    },
  ]);
  const attach =
    attachMenu?.el ??
    h("button", { type: "button", class: "icon-button attach ic i-clip", title: "Attach files", "aria-label": "Attach files" });
  const emojiBtn = h("button", {
    type: "button",
    class: "icon-button emoji-button ic i-smile",
    title: "Emoji",
    "aria-label": "Emoji",
    "aria-haspopup": "dialog",
    "aria-expanded": "false",
    on: { click: () => opts.onEmoji(emojiBtn, insertEmoji) },
    signal,
  });
  const tray = h("ul", { class: "tray", "aria-label": "Attachments" });
  const trayError = h("p", { class: "tray-error", role: "alert" });
  const replyLabel = h("span", { class: "replying-label" });
  const replyBar = h("div", { class: "replying ic i-reply", hidden: true }, [
    replyLabel,
    h("button", {
      type: "button",
      class: "icon-button remove ic i-x",
      "aria-label": "Cancel reply",
      title: "Cancel reply",
      on: { click: () => cancelReply() },
      signal,
    }),
  ]);

  /** Put `emoji` where the caret is (replacing any selection), and the caret after it. */
  function insertEmoji(emoji: string) {
    if (signal.aborted) return;
    textarea.focus();
    textarea.setRangeText(emoji, textarea.selectionStart, textarea.selectionEnd, "end");
    onInput();
  }

  function cancelReply() {
    opts.onCancelReply();
    textarea.focus();
  }

  let files: LocalFile[] = [];
  /** Attachments still being prepared: Send waits for them. */
  let preparing = 0;

  /** What Send would send: valid text, or attachments with text that isn't too long. */
  function sendable(): string | null {
    return validEdit(textarea.value, files.length > 0);
  }

  function onInput() {
    // Count what would be sent (trimmed, in code points), so the counter agrees with the Send button.
    const len = textLength(textarea.value.trim());
    counter.textContent = len <= COUNTER_FROM ? "" : len <= MAX_LEN ? `${MAX_LEN - len} left` : `${len - MAX_LEN} over`;
    fitRows(textarea);
    sendBtn.disabled = preparing > 0 || sendable() === null;
    opts.onChange?.(textarea.value);
  }

  function renderTray() {
    tray.replaceChildren(
      ...files.map((f) =>
        h("li", { class: "tray-item" }, [
          f.item && !f.url
            ? collectionIcon()
            : !f.url
              ? h("span", { class: "tray-icon", "aria-hidden": "true" }, "📄")
              : h(isVideo(f.file.name) && !f.item ? "video" : "img", {
                  class: "tray-thumb",
                  src: isVideo(f.file.name) && !f.item ? `${f.url}#t=0.001` : f.url,
                  width: 40,
                  height: 40,
                  alt: "",
                }),
          h("span", { class: "tray-name" }, f.file.name),
          h("span", { class: "tray-size" }, f.item ? "From a collection" : formatBytes(f.file.size)),
          h(
            "button",
            { type: "button", class: "remove", "aria-label": `Remove ${f.file.name}`, on: { click: () => removeFile(f) }, signal },
            "×",
          ),
        ]),
      ),
    );
    tray.hidden = files.length === 0;
    onInput();
  }

  function removeFile(f: LocalFile) {
    if (f.url && !f.item) URL.revokeObjectURL(f.url);
    files = files.filter((x) => x !== f);
    trayError.textContent = "";
    renderTray();
    textarea.focus();
  }

  async function addFiles(added: readonly File[]) {
    if (!added.length || signal.aborted) return;
    preparing++;
    onInput();
    const prepared = await Promise.all(added.map((f) => (previewable(f) ? prepareImage(f, IMAGE_EDGE) : Promise.resolve(f))));
    preparing--;
    if (signal.aborted) return;
    const { accepted, rejected } = checkFiles(
      files.map((f) => f.file),
      prepared,
    );
    files = [
      ...files.filter((f) => !f.item),
      ...accepted.map((file) => ({ file, url: previewable(file) || isVideo(file.name) ? URL.createObjectURL(file) : "" })),
      ...files.filter((f) => f.item),
    ];
    trayError.textContent = rejected.map((r) => `“${r.name}”: ${r.reason}.`).join(" ");
    renderTray();
  }

  function addItems(items: readonly LocalFile[]) {
    if (signal.aborted) return;
    const fresh = items.filter((it) => !files.some((f) => f.item?.id === it.item?.id));
    const room = Math.max(0, LIMITS.attachments - files.length);
    files = [...files, ...fresh.slice(0, room)];
    trayError.textContent = fresh.length > room ? `At most ${LIMITS.attachments} files per message.` : "";
    renderTray();
    textarea.focus();
  }

  function submit() {
    const text = sendable();
    if (text === null || preparing > 0 || !opts.onSend(text, files)) return;
    textarea.value = "";
    files = []; // the sent message owns their preview URLs now
    trayError.textContent = "";
    renderTray();
  }

  if (!attachMenu) attach.addEventListener("click", () => fileInput.click(), { signal });
  fileInput.addEventListener(
    "change",
    () => {
      const picked = [...(fileInput.files ?? [])];
      fileInput.value = "";
      void addFiles(picked);
    },
    { signal },
  );
  textarea.addEventListener(
    "paste",
    (e) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (!pasted.length) return;
      e.preventDefault();
      void addFiles(pasted);
    },
    { signal },
  );
  signal.addEventListener(
    "abort",
    () => {
      for (const f of files) if (f.url && !f.item) URL.revokeObjectURL(f.url);
    },
    { once: true },
  );

  textarea.addEventListener("input", onInput, { signal });
  textarea.addEventListener(
    "input",
    () => {
      const before = textarea.value.slice(0, textarea.selectionStart);
      if (/(?<=^|[\s(]):[\w+-]{2,}$/.test(before)) opts.onEmojiName?.(textarea);
      if (/(^|[^\w@./])@\w*$/.test(before)) opts.onMention?.(textarea);
    },
    { signal },
  );
  textarea.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey && !composing(e)) {
        e.preventDefault();
        submit();
      } else if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        e.ctrlKey &&
        !(e.altKey || e.metaKey || e.shiftKey) &&
        opts.onStepReply?.(e.key === "ArrowUp" ? -1 : 1)
      ) {
        e.preventDefault();
      } else if (e.key === "ArrowUp" && !e.ctrlKey && textarea.value === "" && opts.onEditLast()) {
        e.preventDefault();
      } else if (e.key === "Escape" && !composing(e) && !replyBar.hidden) {
        // (While composing, Escape belongs to the input method: it cancels the composition.)
        e.preventDefault();
        cancelReply();
      }
    },
    { signal },
  );

  const el = h(
    "form",
    {
      class: "composer",
      on: {
        submit: (e) => {
          e.preventDefault();
          submit();
        },
      },
      signal,
    },
    [
      replyBar,
      h("div", { class: "tray-wrap" }, [tray, trayError]),
      h("div", { class: "composer-row" }, [
        fileInput,
        attach,
        h("label", { for: opts.id, class: "visually-hidden" }, "Message"),
        textarea,
        h("kbd", { class: "focus-key", "aria-hidden": "true", title: "Focus the message box" }, mac ? "⌘/" : "Ctrl /"),
        counter,
        emojiBtn,
        sendBtn,
      ]),
    ],
  );
  tray.hidden = true;

  return {
    el,
    addFiles,
    addItems,
    text: () => textarea.value,
    setText(text) {
      textarea.value = text;
      onInput();
    },
    setPlaceholder(text) {
      placeholder = text;
      fitPlaceholder();
    },
    focus() {
      textarea.focus();
    },
    setReply(reply) {
      replyBar.hidden = !reply;
      replyLabel.replaceChildren(
        ...(reply ? ["Replying to ", h("strong", {}, reply.name), h("span", { class: "replying-text" }, reply.text)] : []),
      );
    },
  };
}
