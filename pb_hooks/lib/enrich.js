/// <reference path="../../types/pocketbase.d.ts" />
// What the messages enrich hook (main.pb.js) needs before it loads lib/messages.js: whether a message needs anything
// at all, and the list routes' mark on the rooms they checked. No require here: under load PocketBase runs a hook
// beyond --hooksPool in a JS runtime made for that one call, which loads every module it requires from scratch, and
// lib/messages.js with what it requires made a room page several times slower (docs/PERF.md).

/**
 * The query parameter a list route (lib/lists.js) adds while it enriches its page: the rooms it has checked the caller
 * can see, every listed message being in one of them. The hooks then leave those messages to the route (lib/messages.js
 * showOriginals), and a page costs no query per message. The hooks see a copy of the request's info, but its query is
 * the same map. A client can send the parameter too, so its value starts with a secret of this process.
 */
const CHECKED = "__chirkle_checked";
const SECRET_KEY = "enrich.checkedSecret";

/** @param {core.App} app */
const secret = (app) => String(app.store().getOrSet(SECRET_KEY, () => $security.randomString(32)));

/**
 * Run `enrich` (a call of $apis.enrichRecords) with the mark that rooms `rooms` were checked.
 * @template T
 * @param {core.RequestEvent} e
 * @param {string[]} rooms
 * @param {() => T} enrich
 * @returns {T}
 */
function markChecked(e, rooms, enrich) {
  const query = e.requestInfo().query;
  query[CHECKED] = `${secret(e.app)} ${rooms.join(",")}`;
  try {
    return enrich();
  } finally {
    delete query[CHECKED];
  }
}

/**
 * Did a list route check this message's room?
 * @param {core.RecordEnrichEvent} e
 */
function inCheckedRoom(e) {
  const mark = String(e.requestInfo?.query?.[CHECKED] ?? "");
  if (!mark) return false;
  const s = secret(e.app);
  return (
    mark.startsWith(`${s} `) &&
    mark
      .slice(s.length + 1)
      .split(",")
      .includes(e.record?.getString("room") ?? "")
  );
}

/**
 * Has lib/messages.js anything to do for this message (showOriginal: a forward; keepToRoom: a reply or reactions)?
 * Most messages have neither.
 * @param {core.RecordEnrichEvent} e
 */
function needsWork(e) {
  const rec = e.record;
  if (!rec || inCheckedRoom(e)) return false;
  if (rec.getString("forward_of") && !rec.getBool("deleted")) return true;
  const reactions = rec.getString("reactions");
  return !!rec.getString("reply_to") || !(reactions === "" || reactions === "[]" || reactions === "null");
}

/**
 * Is anything about this message's author kept to themselves (lib/anonymous.js, DESIGN.md §35), or the author of the
 * message it replies to? Checked for every message, the list routes' too.
 * @param {core.RecordEnrichEvent} e
 */
const isAnonymous = (e) =>
  !!e.record && (e.record.getBool("anonymous") || e.record.getBool("forwarded_anonymous") || !!e.record.expand()?.reply_to);

module.exports = { markChecked, inCheckedRoom, needsWork, isAnonymous };
