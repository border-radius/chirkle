/// <reference path="../../types/pocketbase.d.ts" />
// The optional features that act on the core collections' saves: linked instances (§33, federation/), the
// Telegram bridge (§26, telegram/) and the XMPP bridge (§38, xmpp/). main.pb.js registers every hook on messages,
// rooms and users and calls them from there, in one stated order: the federation's part first (it reads a record as
// it was, before the core's hooks change it), then the core's, then the bridges'; after the save, the other way round.
// Each feature's own collections (fed_*, tg_*, xmpp_*), routes and worker stay in its .pb.js file.

/**
 * The federation's modules while this server is linked with any other (federation/config.js `inUse`), else null.
 * @param {core.App} app
 */
function federation(app) {
  if (!require(`${__hooks}/federation/config.js`).inUse(app)) return null;
  return {
    rooms: require(`${__hooks}/federation/rooms.js`),
    mirror: require(`${__hooks}/federation/mirror.js`),
    people: require(`${__hooks}/federation/people.js`),
    messages: require(`${__hooks}/federation/messages.js`),
  };
}

/** The bridge's modules while it is on (TELEGRAM_BOT_TOKEN), else null. */
function telegram() {
  if (!$os.getenv("TELEGRAM_BOT_TOKEN").trim()) return null;
  return {
    outbound: require(`${__hooks}/telegram/outbound.js`),
    people: require(`${__hooks}/telegram/people.js`),
  };
}

/** The XMPP bridge's modules while it is on (XMPP_JID, XMPP_PASSWORD and the child's binary), else null. */
function xmpp() {
  if (!require(`${__hooks}/xmpp/config.js`).on()) return null;
  return {
    outbound: require(`${__hooks}/xmpp/outbound.js`),
    people: require(`${__hooks}/xmpp/people.js`),
  };
}

module.exports = { federation, telegram, xmpp };
