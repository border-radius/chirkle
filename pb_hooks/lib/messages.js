/// <reference path="../../types/pocketbase.d.ts" />
// messages hooks (DESIGN.md §5.6, §17, §19, §20, §21, §28): text, attachments, replies, forwards, soft delete, edit stamps.
// A forward (§21.3) has no text or files of its own: it shows those of the message in `forward_of` (server/enrich.go
// showOriginal, in every answer and live event).

const { accessOf, canSee, canWrite } = require(`${__hooks}/lib/access.js`);
const { fieldError, recordOf } = require(`${__hooks}/lib/records.js`);
const { dmRefusal } = require(`${__hooks}/lib/dms.js`);
const { isDm } = require(`${__hooks}/lib/rooms.js`);
const { cleanText, isBlank, searchKey } = require(`${__hooks}/lib/text.js`);

/**
 * Trim a text field in place (required/min validation then rejects blanks).
 * @param {core.Record} record
 * @param {string} field
 */
function trim(record, field) {
  record.set(field, record.getString(field).trim());
}

/**
 * The message's room, which must be active (not archived). Null when no room is set.
 * @param {core.App} app
 * @param {string} roomId
 */
function activeRoom(app, roomId) {
  if (!roomId) return null; // the relation's own `required` validation reports this
  const room = app.findRecordById("rooms", roomId);
  if (room.getBool("archived")) throw fieldError("room", "This room is archived and read-only.");
  return room;
}

/**
 * Clean (no control characters, QA BUG-105), trimmed text that isn't blank, unless `blankOk` (a message with
 * attachments may have no text, §17.1).
 * @param {core.Record} record
 * @param {boolean} [blankOk]
 */
function assertText(record, blankOk = false) {
  record.set("text", cleanText(record.getString("text")));
  trim(record, "text");
  const text = record.getString("text");
  if (!isBlank(text)) return;
  if (!blankOk) throw fieldError("text", "Cannot be blank.");
  record.set("text", ""); // e.g. only zero-width characters next to an attachment
}

/**
 * What message search matches (§29): the text case folded (`searchKey`), whatever the client sent. Set after
 * every other change to the text, on every save.
 * @param {core.Record} record
 */
function setTextKey(record) {
  record.set("text_key", searchKey(record.getString("text")));
}

/**
 * Attachment names: the stored names of its `files` rows (§37).
 * @param {core.Record} record
 */
const fileNames = (record) => record.getStringSlice("files");

/**
 * Is this message a forward (§21.3)? A forward's text may be blank: it shows the original's, or nothing once that is gone.
 * @param {core.Record} rec
 */
const isForward = (rec) => rec.getString("forwarded_from") !== "";

/**
 * Is this a service message (§5.3): the app's own notice in a room, with no author?
 * @param {core.Record} rec
 */
const isService = (rec) => rec.getString("author") === "";

/**
 * Post a service message (§5.3) in a room that isn't archived: one line of the app's own, no author. It goes through
 * the same hooks as any message, so unread counts and realtime see it.
 * @param {core.App} app
 * @param {string} roomId
 * @param {string} text
 */
function postService(app, roomId, text) {
  const rec = new Record(app.findCollectionByNameOrId("messages"));
  rec.set("room", roomId);
  rec.set("text", text);
  app.save(rec);
}

/**
 * Set on a message by prepareCreate, a custom key (neither stored nor sent): the create request checked it, its
 * mentions included, before the save's transaction, which doesn't do it again.
 */
const CHECKED = "@checked";

/** Was this message checked by its create request already (prepareCreate)? @param {core.Record} rec */
const checked = (rec) => rec.get(CHECKED) === true;

/**
 * messages create: trim + non-empty text, room must be active (§5.6). A create request's message was checked before
 * the transaction (prepareCreate); every other create (service messages, forwards, the bridges) is checked here.
 * @param {core.RecordEvent} e
 */
function beforeMessageCreate(e) {
  const rec = recordOf(e);
  // Set with their rows (setRequestFiles, lib/files.js setMessageFiles); a message without files says so, never null.
  if (!fileNames(rec).length) {
    rec.set("files", []);
    rec.set("file_names", {});
    rec.set("file_dims", {});
  }
  rec.set("reactions", []); // only POST /api/chat/reactions adds them (§20.2)
  rec.set("previews", []); // only the previews worker sets them (§28)
  if (!checked(rec)) checkCreate(e.app, rec, fileNames(rec).length > 0);
}

/**
 * What a new message must be: text that isn't blank unless it has files (`hasFiles`) or is a forward, in a room that
 * is active and that its author can see and post in; a reply or forward of a message that is still there.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {boolean} hasFiles
 */
function checkCreate(app, rec, hasFiles) {
  if (isService(rec)) {
    // Made only by postService (no request can leave out the author): text alone, in any room that isn't archived.
    assertText(rec);
    activeRoom(app, rec.getString("room"));
    return;
  }
  assertText(rec, hasFiles || isForward(rec));
  const room = activeRoom(app, rec.getString("room"));
  // Defense in depth for the members-only create rule (§16.3, §23.1): DMs and private rooms.
  if (room && !canSee(accessOf(room), rec.getString("author"))) {
    throw fieldError("room", isDm(room) ? "You are not a member of this conversation." : "You are not a member of this room.");
  }
  // ... and for who may post in it (§23.6): forwards and the Telegram bridge come through here too.
  if (room && !canWrite(room, rec.getString("author"))) throw fieldError("room", "Only some people can post in this room.");
  if (room && isDm(room)) {
    const refused = dmRefusal(app, rec.getString("author"), room.getStringSlice("members"));
    if (refused) throw fieldError("room", refused);
  }
  // Posted in an anonymous room (§35): its author is kept to themselves for good. DMs never are.
  rec.set("anonymous", !!room && !isDm(room) && room.getBool("anonymous"));
  assertReplyTarget(app, rec);
  rec.set("forwarded_anonymous", assertForwardTarget(app, rec));
}

/**
 * A forward (§21.3) shows an original that is still there: not deleted, and not a forward itself (POST
 * /api/chat/forward points a forward of a forward at its original), so a chain is never more than one step. Returns
 * whether the original's author is kept to themselves (§35).
 * @param {core.App} app
 * @param {core.Record} rec
 */
function assertForwardTarget(app, rec) {
  const id = rec.getString("forward_of");
  if (!id) return false;
  let original = null;
  try {
    original = app.findRecordById("messages", id);
  } catch {
    original = null;
  }
  if (!original || original.getBool("deleted")) throw fieldError("forward_of", "That message was deleted.");
  if (original.getString("forward_of") !== "") throw fieldError("forward_of", "That message is a forward.");
  return original.getBool("anonymous");
}

/**
 * A reply (§19) answers a message of the same room that is still there. Without this check a reply could
 * point into a DM you're not in, and its expanded preview would show you that message.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function assertReplyTarget(app, rec) {
  const id = rec.getString("reply_to");
  if (!id) return;
  let parent = null;
  try {
    parent = app.findRecordById("messages", id);
  } catch {
    parent = null;
  }
  if (!parent || parent.getString("room") !== rec.getString("room")) {
    throw fieldError("reply_to", "That message isn't in this room.");
  }
  if (parent.getBool("deleted")) throw fieldError("reply_to", "That message was deleted.");
  if (isService(parent)) throw fieldError("reply_to", "Service messages can't be replied to.");
}

/**
 * Is this update PocketBase clearing `reply_to` because the message it pointed at no longer exists? Users can't
 * remove messages (only soft-delete them), and the update rule refuses any `reply_to` in a request body.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} orig
 */
function replyTargetRemoved(app, rec, orig) {
  const id = orig.getString("reply_to");
  if (!id || rec.getString("reply_to") !== "") return false;
  try {
    app.findRecordById("messages", id);
    return false;
  } catch {
    return true;
  }
}

/**
 * Is this update PocketBase clearing `forward_of` because the original was deleted for good (by a superuser, or with
 * its room)? The forward then shows nothing (§21.3). The update rule refuses any `forward_of` in a request body.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} orig
 */
function originalRemoved(app, rec, orig) {
  const id = orig.getString("forward_of");
  if (!id || rec.getString("forward_of") !== "") return false;
  try {
    app.findRecordById("messages", id);
    return false;
  } catch {
    return true;
  }
}

/**
 * Is this update PocketBase clearing `forwarded_from` because the user it named was deleted (by a superuser)? The
 * update rule refuses any `forwarded_from` in a request body.
 * @param {core.App} app
 * @param {core.Record} rec
 * @param {core.Record} orig
 */
function forwardSourceRemoved(app, rec, orig) {
  const id = orig.getString("forwarded_from");
  if (!id || rec.getString("forwarded_from") !== "") return false;
  try {
    app.findRecordById("users", id);
    return false;
  } catch {
    return true;
  }
}

/**
 * messages create through the API: only POST /api/chat/forward, whose own saves don't come through here, makes a
 * forward (§21.3). Backs up the create rule against field modifiers.
 * @param {core.RecordRequestEvent} e
 */
function beforeMessageCreateRequest(e) {
  const rec = recordOf(e);
  for (const f of ["forwarded_from", "forward_of"]) if (rec.getString(f) !== "") throw fieldError(f, "This field can't be set.");
  // Only attachItems sets file_sources, from the items named (§31); only the hooks set file_dims (§17.5).
  for (const f of ["file_sources", "file_dims"]) {
    const v = rec.getString(f);
    if (v !== "" && v !== "null" && v !== "{}") throw fieldError(f, "This field can't be set.");
  }
}

/**
 * messages create through the API, before its transaction (docs/PERF.md §12): what beforeMessageCreate and the
 * mentions would check and read inside it, and the uploads, each stored with its `files` row (§37) on its own. The
 * write connection is then held only for the inserts, not for the reads, the JS or the uploads' round trips to S3.
 * The attachments are this request's uploads (`files`) and the collection items it names (`items`, §31), in that
 * order; names in the body are never taken (setRequestFiles replaces them). The create rule was checked before this,
 * outside any transaction too. If the save then fails, `uploaded` are to be dropped (lib/files.js discard).
 * @param {core.RecordRequestEvent} e
 * @returns {{ rows: core.Record[], uploaded: core.Record[], sources: Record<string, string> }}
 */
function prepareCreate(e) {
  const rec = recordOf(e);
  /** @type {filesystem.File[]} */
  const uploads = [];
  for (const key of ["files", "files+"]) {
    try {
      for (const f of e.findUploadedFiles(key)) if (f) uploads.push(f);
    } catch {
      // none under this key
    }
  }
  const files = require(`${__hooks}/lib/files.js`);
  const { rows: items, sources } = require(`${__hooks}/lib/collections.js`).itemsToAttach(e, uploads.length);
  if (uploads.length + items.length > files.MAX_FILES) throw fieldError("files", `At most ${files.MAX_FILES} files.`);
  // The create rule would refuse it anyway: store nothing first.
  if (uploads.length && !e.auth) throw new ForbiddenError("Only signed-in users can post.");
  checkCreate(e.app, rec, uploads.length + items.length > 0);
  const fed = require(`${__hooks}/lib/features.js`).federation(e.app);
  require(`${__hooks}/lib/handles.js`).setMentions(e.app, rec, !!fed && fed.messages.isFromPeer(e.app, rec));
  rec.set(CHECKED, true);
  const uploaded = files.fromUploads(e.app, uploads);
  return { rows: [...uploaded, ...items], uploaded, sources };
}

/**
 * messages create through the API: its attachments (prepareCreate's rows) set on it, linked by its save, in the
 * save's transaction (main.pb.js). Whatever the body said of `files`, `file_names`, `file_dims` or `file_sources`
 * is replaced.
 * @param {core.RecordRequestEvent} e
 * @param {{ rows: core.Record[], sources: Record<string, string> }} prepared
 */
function setRequestFiles(e, prepared) {
  require(`${__hooks}/lib/files.js`).setMessageFiles(e.app, recordOf(e), prepared.rows, prepared.sources, true);
}

/**
 * messages, after a create is committed: a DM records its latest activity (sorts the DM list) and reopens
 * itself for members who had closed it (§16.4).
 * @param {core.RecordEvent} e
 */
function afterMessageCreate(e) {
  const rec = recordOf(e);
  const room = e.app.findRecordById("rooms", rec.getString("room"));
  if (!isDm(room)) return;
  room.set("last_message_at", rec.get("created"));
  e.app.save(room);
  const author = rec.getString("author");
  for (const member of room.getStringSlice("members")) {
    if (member === author) continue;
    const rows = e.app.findRecordsByFilter("hidden_rooms", "user = {:user} && room = {:room}", "", 1, 0, { user: member, room: room.id });
    for (const row of rows) if (row) e.app.delete(row);
  }
}

/**
 * messages update: soft delete, edit stamp, archived guard (§5.6).
 * @param {core.RecordEvent} e
 */
function beforeMessageUpdate(e) {
  const rec = recordOf(e);
  const orig = rec.original();
  // A message deleted for good (by a superuser, or with its room) is already gone when PocketBase unsets the
  // reply_to of its replies (§19.1). Let that save through: the guards below would refuse it, and with it the delete.
  if (replyTargetRemoved(e.app, rec, orig) || forwardSourceRemoved(e.app, rec, orig) || originalRemoved(e.app, rec, orig)) return;
  activeRoom(e.app, orig.getString("room"));

  if (orig.getBool("deleted")) {
    // Deletion is final; API rules already refuse this, so this only guards superuser edits.
    throw fieldError("deleted", "Deleted messages cannot be changed.");
  }
  // Backs up the update rule (§19), superusers included. PocketBase 0.40.4 counts field modifiers (`author+`) as set
  // for `:isset`, so the rule refuses them (QA BUG-150), but nothing else would if a version stopped doing so.
  if (rec.getString("reply_to") !== orig.getString("reply_to")) throw fieldError("reply_to", "This field can't be changed.");
  for (const f of ["author", "room", "forwarded_from", "forward_of"]) {
    if (rec.getString(f) !== orig.getString(f)) throw fieldError(f, "This field can't be changed.");
  }

  if (rec.getBool("deleted")) {
    rec.set("text", "");
    rec.set("files", []); // unlinked once saved: a file nothing else names is deleted (§17.1, §37)
    rec.set("file_names", {});
    rec.set("file_sources", {});
    rec.set("file_dims", {});
    rec.set("reactions", []);
    rec.set("previews", []);
    rec.set("deleted_at", new DateTime());
    rec.set("edited_at", orig.get("edited_at"));
    return;
  }

  rec.set("file_names", orig.get("file_names")); // never changed by an edit
  rec.set("file_sources", orig.get("file_sources")); // nor this (§31)
  // Only the create hook and the media worker set these; the worker's may be newer than the loaded record's.
  rec.set("file_dims", e.app.findRecordById("messages", rec.id).get("file_dims"));
  // Reactions only change through POST /api/chat/reactions (§20.2). Any other save (an edit) keeps the ones stored
  // now, not the ones loaded with the record: a reaction added meanwhile would be lost. (Edits save in a transaction.)
  if (rec.getString("reactions") === orig.getString("reactions")) {
    rec.set("reactions", e.app.findRecordById("messages", rec.id).get("reactions"));
  }
  // Attachments are immutable after sending (backs up the update rule, as above).
  const files = fileNames(rec);
  if (files.join("/") !== orig.getStringSlice("files").join("/")) throw fieldError("files", "Attachments can't be changed.");
  assertText(rec, files.length > 0 || isForward(rec));
  if (rec.getString("text") !== orig.getString("text")) {
    rec.set("previews", []); // the worker looks at the new text's links (§28)
  } else if (rec.getString("previews") === orig.getString("previews")) {
    // As for reactions: the ones stored now, not those loaded with the record (the worker may have saved meanwhile).
    rec.set("previews", e.app.findRecordById("messages", rec.id).get("previews"));
  }
  if (rec.getString("text") !== orig.getString("text")) {
    // A forward's words are someone else's: "Forwarded from Bob" must stay true (§21.3). It can still be deleted.
    if (orig.getString("forwarded_from") !== "") throw fieldError("text", "Forwarded messages can't be edited.");
    rec.set("edited_at", new DateTime());
  }
}

/**
 * messages update through the API: reactions only change through POST /api/chat/reactions, whose own saves don't
 * come through here (§20.2); previews and file_dims only through the workers (§28, §17.5). Backs up the update rule.
 * @param {core.RecordRequestEvent} e
 */
function beforeMessageUpdateRequest(e) {
  const rec = recordOf(e);
  // Uploads and modifiers aren't a file field's any more (§37), so the update rule doesn't see them all: refused
  // here, not dropped.
  const body = /** @type {Record<string, unknown>} */ (e.requestInfo().body);
  for (const key of ["files", "+files", "files+", "files-"]) {
    let n = 0;
    try {
      n = e.findUploadedFiles(key).length;
    } catch {
      n = 0;
    }
    if (n || key in body) throw fieldError("files", "Attachments can't be changed.");
  }
  for (const f of ["reactions", "previews", "file_dims"]) {
    if (rec.getString(f) !== rec.original().getString(f)) throw fieldError(f, "This field can't be changed.");
  }
  // Only the hooks set who a message mentions, from its text (§41).
  if (rec.getStringSlice("mentions").join(",") !== rec.original().getStringSlice("mentions").join(",")) {
    throw fieldError("mentions", "This field can't be changed.");
  }
}

/**
 * Will this update change what forwards of the message show (§21.3)? Called with the update about to be saved.
 * @param {core.Record} rec
 */
function changesForwards(rec) {
  const orig = rec.original();
  return (
    rec.getString("text") !== orig.getString("text") ||
    rec.getBool("deleted") !== orig.getBool("deleted") ||
    rec.getString("previews") !== orig.getString("previews")
  );
}

/**
 * After an edit or delete of a message: its forwards are saved again (nothing in them changes), so everyone who sees
 * one hears of it live, with the original as it is now (server/enrich.go showOriginal). They can't hear of the original itself: it is
 * in a room they may not see. Forwards in archived rooms are left alone: they can't be saved, and show it once loaded.
 * @param {core.App} app
 * @param {core.Record} rec
 */
function touchForwards(app, rec) {
  const forwards = app.findRecordsByFilter("messages", "forward_of = {:id} && deleted = false", "", 0, 0, { id: rec.id });
  for (const fwd of forwards) {
    if (!fwd || app.findRecordById("rooms", fwd.getString("room")).getBool("archived")) continue;
    app.save(fwd);
  }
}

/**
 * users delete (a superuser): refused while they have messages. `author` isn't required (service messages have none,
 * §5.3), so PocketBase would otherwise clear it on their messages, which would then read as the app's own notices.
 * @param {core.RecordEvent} e
 */
function beforeUserDelete(e) {
  const id = recordOf(e).id;
  if (e.app.findRecordsByFilter("messages", "author = {:id}", "", 1, 0, { id }).length) {
    throw new BadRequestError("This user wrote messages, so their account can't be deleted.");
  }
}

module.exports = {
  checked,
  prepareCreate,
  isService,
  setTextKey,
  setRequestFiles,
  beforeUserDelete,
  postService,
  beforeMessageCreate,
  beforeMessageCreateRequest,
  afterMessageCreate,
  beforeMessageUpdate,
  beforeMessageUpdateRequest,
  changesForwards,
  touchForwards,
};
