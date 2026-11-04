// The web's and the hooks' copies of what clients and server share (shared/contract.json, docs/API.md). The app's
// are checked by android/core/data/src/test/kotlin/chirkle/android/data/lib/ContractTest.kt.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import contract from "../../shared/contract.json" with { type: "json" };
import { ACTIVITY_FIELDS, HIDDEN_FIELDS, MSG_FIELDS, ROOM_FIELDS, USER_FIELDS } from "../../web/src/api.ts";
import { isAudio, isImage, isVideo } from "../../web/src/lib/files.ts";
import { LIMITS, MAX_SELECTED } from "../../web/src/lib/limits.ts";
import { ITEM_FIELDS } from "../../web/src/views/collection/calls.ts";
import { ACCEPT, MEDIA } from "../../web/src/views/collection/shared.ts";

/** A constant of a hooks module, read from its source (paths from the repo root): the modules need PocketBase's runtime to load. */
function hookConst(file: string, name: string): unknown {
  const src = readFileSync(`pb_hooks/${file}`, "utf8");
  const m = new RegExp(`^const ${name} = (.+);$`, "m").exec(src);
  if (!m) throw new Error(`${name} not in pb_hooks/${file}`);
  return JSON.parse(m[1]!);
}

describe("shared contract", () => {
  it("the web asks for the fields the contract lists", () => {
    expect(MSG_FIELDS).toBe(contract.fields.message);
    expect(ROOM_FIELDS).toBe(contract.fields.room);
    expect(USER_FIELDS).toBe(contract.fields.user);
    expect(HIDDEN_FIELDS).toBe(contract.fields.roomRow);
    expect(ITEM_FIELDS).toBe(contract.fields.collectionItem);
    // The web's notifications (§34) also look at replies; the app's come from its periodic check instead.
    expect(ACTIVITY_FIELDS).toBe(`${contract.fields.activity},reply_to`);
  });

  it("the web's limits are the contract's", () => {
    expect({ ...LIMITS, maxSelected: MAX_SELECTED }).toEqual(contract.limits);
  });

  it("the hooks' limits are the contract's", () => {
    expect(hookConst("lib/bulk.js", "MAX_MESSAGES")).toBe(contract.limits.maxSelected);
    expect(hookConst("lib/access.js", "MAX_MEMBERS")).toBe(contract.limits.roomMembers);
  });

  it("the web and the server's shared files (pb_hooks/lib/files.js: the media grid, the worker) show the same files inline", () => {
    for (const e of contract.files.image) expect(isImage(`a.${e}`)).toBe(true);
    for (const e of contract.files.video) expect(isVideo(`a.${e}`)).toBe(true);
    for (const e of contract.files.audio) expect(isAudio(`a.${e}`)).toBe(true);
    for (const e of ["pdf", "txt", "svg", "html"]) expect(isImage(`a.${e}`) || isVideo(`a.${e}`) || isAudio(`a.${e}`)).toBe(false);
    expect(hookConst("lib/files.js", "IMAGE_EXT")).toEqual(contract.files.image);
    expect(hookConst("lib/files.js", "VIDEO_EXT")).toEqual(contract.files.video);
  });

  it("collections take the images and videos (their chunk has its own list: it can't import lib/files.ts)", () => {
    const media = [...contract.files.image, ...contract.files.video];
    expect(ACCEPT.split(",")).toEqual(media.map((e) => `.${e}`));
    for (const e of media) expect(MEDIA.test(`a.${e}`)).toBe(true);
    for (const e of [...contract.files.audio, "pdf", "svg"]) expect(MEDIA.test(`a.${e}`)).toBe(false);
  });
});
