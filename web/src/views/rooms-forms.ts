// The sidebar's new-room and new-collection forms (§23.1, §31; the "sidebar improvements" board's Room creation and
// Collection creation): a small card in place under the section's heading, not a dialog. A lazy chunk: views/rooms.ts
// import()s it on the first "+", as it does the people search. It links the stylesheet of the cards (New message's too).

import { ApiError, errorMessage } from "../api.ts";
import type { Ctx } from "../context.ts";
import { type Child, h, uniqueId } from "../dom.ts";
import { LIMITS, textLength } from "../lib/limits.ts";
import { nameKey, VISIBILITY } from "../lib/rooms.ts";
import type { Visibility } from "../lib/types.ts";
import type { Scope } from "../scope.ts";
import * as S from "../strings/rooms-forms.ts";
import { chunkContext, collectionChunk } from "./collection.ts";

/** The stylesheet's URL, set by the build (scripts/lib/build-utils.mjs). */
declare const FORMS_CSS: string;

let sheet: Promise<void> | null = null;
/** Links the cards' stylesheet; resolves once it is in (or failed: the cards then show unstyled rather than not at all). */
export function loadStylesheet(): Promise<void> {
  sheet ??= new Promise((resolve) => {
    const failed = () => {
      link.remove();
      sheet = null;
      resolve();
    };
    const link = h("link", { rel: "stylesheet", href: FORMS_CSS, on: { load: () => resolve(), error: failed } });
    document.head.append(link);
  });
  return sheet;
}

export type FormKind = "room" | "coll";

/** A form's parts: shown while open, emptied when closed. */
export interface FormParts {
  form: HTMLFormElement;
  input: HTMLInputElement;
  reset: () => void;
}

const isNotUnique = (err: unknown) => err instanceof ApiError && err.codes.name === "validation_not_unique";
/** Why a name was refused: the server's word on the field, else what went wrong. */
const fieldReason = (err: unknown) => (err instanceof ApiError && err.fields.name) || errorMessage(err);

/** What the forms use of the room list. */
export interface FormDeps extends Pick<Ctx, "api" | "store" | "actions" | "navigate" | "collections"> {
  id: string;
  scope: Scope;
  /** Closes (after a create, Cancel or Escape) the form. */
  toggleForm: (which: FormKind, show: boolean) => void;
}

/** Builds the form for `which`, once per mount of the room list. */
export function createForm(which: FormKind, { id, scope, store, actions, navigate, api, collections, toggleForm }: FormDeps): FormParts {
  /**
   * The inline "new room" / "new collection" form (sidebar improvements: Room creation, Collection creation): in place
   * under its section's heading, not a dialog. A name field whose leading icon is the chosen type, a tile per type with
   * a line saying what it means, and Cancel / Create. A name already taken (of those listed, compared as the server
   * compares them) is said as you type and keeps Create disabled until it changes.
   */
  function inlineForm<V extends string>(spec: {
    className: string;
    inputLabel: string;
    placeholder: string;
    legend: string;
    /** The radios' name, what the choice is. */
    choice: string;
    choices: { value: V; label: string; icon: string; hint: string }[];
    submitLabel: string;
    tooLong?: (name: string) => string;
    /** Why the name can't be used, when one listed has it. */
    taken: (name: string) => Child[] | null;
    create: (name: string, chosen: V) => Promise<void>;
    errorOf: (e: unknown, name: string) => Child[];
    close: () => void;
  }): FormParts {
    const inputId = uniqueId(`${id}-name`);
    const errId = `${inputId}-error`;
    const err = h("p", { id: errId, class: "field-error", role: "alert" });
    const input = h("input", {
      id: inputId,
      name: "name",
      required: true,
      // No `maxlength`: it counts UTF-16 units (an emoji is 2), the server counts characters. Checked on submit.
      autocomplete: "off",
      placeholder: spec.placeholder,
      "aria-describedby": errId,
    });
    const lead = h("span", { "aria-hidden": "true" });
    const submit = h("button", { type: "submit", class: "primary" }, spec.submitLabel);
    const hint = h("p", { class: "hint" });
    const radios = spec.choices.map((c) => h("input", { type: "radio", name: spec.choice, value: c.value, class: "visually-hidden" }));
    const chosen = () =>
      spec.choices[
        Math.max(
          0,
          radios.findIndex((r) => r.checked),
        )
      ]!;
    const showChoice = () => {
      const c = chosen();
      hint.textContent = c.hint;
      lead.className = `type-icon ic ${c.icon}`;
    };
    const choose = (v: V) => {
      for (const r of radios) r.checked = r.value === v;
      showChoice();
    };
    const tiles = h("fieldset", { class: `tiles n${spec.choices.length}`, on: { change: showChoice }, signal: scope.signal }, [
      h("legend", { class: "visually-hidden" }, spec.legend),
      ...spec.choices.map((c, i) => h("label", { class: `ic ${c.icon}` }, [radios[i]!, c.label])),
    ]);
    let busy = false;
    let blocked = false;
    const sync = () => {
      submit.disabled = busy || blocked;
      submit.setAttribute("aria-disabled", String(submit.disabled));
    };
    const setError = (msg: Child[] | null) => {
      if (!msg) {
        err.replaceChildren();
        input.removeAttribute("aria-invalid");
        return;
      }
      err.replaceChildren(h("span", { class: "ic i-alert", "aria-hidden": "true" }), h("span", {}, msg));
      input.setAttribute("aria-invalid", "true");
    };
    /** The name as typed, checked against those listed. */
    const check = () => {
      const why = input.value.trim() ? spec.taken(input.value) : null;
      blocked = !!why;
      setError(why);
      sync();
      return why;
    };
    const form = h(
      "form",
      {
        class: `inline-form ${spec.className}`,
        on: {
          input: (e) => {
            if (e.target === input) check();
          },
          keydown: (e) => {
            if (e.key === "Escape") spec.close();
          },
          submit: async (e) => {
            e.preventDefault();
            if (busy || check()) return;
            const name = input.value;
            const long = spec.tooLong?.(name.trim());
            if (long) {
              setError([long]);
              return;
            }
            busy = true;
            sync();
            try {
              await spec.create(name, chosen().value);
            } catch (e) {
              if (scope.active) setError(spec.errorOf(e, name.trim()));
            } finally {
              busy = false;
              sync();
            }
          },
        },
        signal: scope.signal,
      },
      [
        h("label", { class: "name-field" }, [lead, h("span", { class: "visually-hidden" }, spec.inputLabel), input]),
        err,
        tiles,
        hint,
        h("div", { class: "form-buttons" }, [
          h("button", { type: "button", class: "cancel", on: { click: spec.close }, signal: scope.signal }, S.CANCEL),
          submit,
        ]),
      ],
    );
    const reset = () => {
      input.value = "";
      choose(spec.choices[0]!.value);
      blocked = false;
      setError(null);
      sync();
    };
    reset();
    return { form, input, reset };
  }

  /** The new-room form (§23.1): public unless chosen otherwise; members of a private room are added from the room. */
  function newRoomForm(): FormParts {
    const icons: Record<Visibility, string> = { public: "i-hash", private: "i-lock", open: "i-globe" };
    const takenMsg = (name: string): Child[] => [h("b", {}, `#${name.replace(/^[#\s]+/, "")}`), S.ROOM_TAKEN];
    return inlineForm<Visibility>({
      className: "new-room",
      inputLabel: S.ROOM_NAME,
      placeholder: "room-name",
      legend: S.WHO_CAN_SEE_IT,
      choice: "visibility",
      choices: (["public", "private", "open"] as const).map((v) => ({ value: v, ...VISIBILITY[v], icon: icons[v] })),
      submitLabel: S.CREATE_ROOM,
      tooLong: (name) => (textLength(name) > LIMITS.roomName ? S.mustBeNoMoreThanCharacters(LIMITS.roomName) : ""),
      taken: (name) => {
        const key = nameKey(name, true);
        if (!key) return null;
        for (const r of store.get().rooms.values()) if (r.kind !== "dm" && nameKey(r.name, true) === key) return takenMsg(r.name);
        return null;
      },
      create: async (name, visibility) => {
        const room = await actions.create(name, visibility);
        if (!scope.active) return;
        toggleForm("room", false);
        navigate(`/r/${room.id}`);
      },
      errorOf: (e, name) => (isNotUnique(e) ? takenMsg(name) : [fieldReason(e)]),
      close: () => toggleForm("room", false),
    });
  }

  /** The new-collection form (§31): public unless chosen otherwise (then only you can see it). */
  function newCollForm(): FormParts {
    const takenMsg = (name: string): Child[] => [S.A_COLLECTION_CALLED, h("b", {}, name), S.COLLECTION_TAKEN];
    return inlineForm<"public" | "private">({
      className: "new-coll",
      inputLabel: S.COLLECTION_NAME,
      placeholder: S.COLLECTION_NAME,
      legend: S.PRIVACY,
      choice: "privacy",
      choices: [
        { value: "public", label: S.PUBLIC, icon: "i-eye", hint: S.ANYONE_CAN_SEE_IT_AND_SUBSCRIBE },
        { value: "private", label: S.PRIVATE, icon: "i-lock", hint: S.ONLY_YOU_CAN_SEE_IT },
      ],
      submitLabel: S.CREATE_COLLECTION,
      taken: (name) => {
        const key = nameKey(name);
        const hit = key && store.get().collections?.mine.find((c) => nameKey(c.name) === key);
        return hit ? takenMsg(hit.name) : null;
      },
      create: async (name, privacy) => {
        const c = await collectionChunk().catch(() => {
          throw new ApiError(S.COULDNT_OPEN_COLLECTIONS_CHECK_YOUR_CONNECTION, 400);
        });
        const cid = await c.createCollection(chunkContext({ api, store, collections }), name, privacy === "public");
        if (!scope.active) return;
        toggleForm("coll", false);
        navigate(`/c/${cid}`);
      },
      errorOf: (e, name) => (isNotUnique(e) ? takenMsg(name) : [fieldReason(e)]),
      close: () => toggleForm("coll", false),
    });
  }

  return which === "room" ? newRoomForm() : newCollForm();
}
