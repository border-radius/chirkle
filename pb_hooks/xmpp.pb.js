/// <reference path="../types/pocketbase.d.ts" />
// XMPP bridge (DESIGN.md §38): messages go both ways between rooms and the XMPP conferences they are linked to. This
// file, xmpp/ and the xmpp_* collections (pb_migrations/1760000044_xmpp.js); a Go child (xmpp-bridge/) holds the XMPP
// connection. What it does on the core collections' saves (messages, users) main.pb.js calls through
// lib/features.js, which is off without XMPP_JID, XMPP_PASSWORD and the child's binary. Without them this file
// registers nothing either.

if (require(`${__hooks}/xmpp/config.js`).configured()) {
  if (!require(`${__hooks}/xmpp/config.js`).on()) {
    onBootstrap((e) => {
      e.next();
      e.app
        .logger()
        .warn(
          "xmpp: the child's binary isn't there (build it: npm run build:xmpp, or the Docker image with --build-arg XMPP=on): the XMPP bridge is off",
          "CHIRKLE_XMPP_BIN",
          $os.getenv("CHIRKLE_XMPP_BIN"),
        );
    });
  } else {
    // Only when serving: other commands (migrate, superuser…) bootstrap too.
    onBootstrap((e) => {
      e.next();
      if (!$os.args.includes("serve")) return;
      try {
        require(`${__hooks}/xmpp/child.js`).start(e.app);
      } catch (err) {
        e.app.logger().error("xmpp: child didn't start", "error", String(err));
      }
    });

    onTerminate((e) => {
      require(`${__hooks}/xmpp/child.js`).stop(e.app);
      e.next();
    });

    routerAdd("POST", "/api/xmpp/in", (e) => require(`${__hooks}/xmpp/inbound.js`).route(e));
    routerAdd("POST", "/api/xmpp/tick", (e) => require(`${__hooks}/xmpp/worker.js`).tick(e), $apis.requireSuperuserAuth());

    cronAdd("xmpp", "* * * * *", () => require(`${__hooks}/xmpp/worker.js`).run($app));

    // A room says when a conference is connected to it or disconnected from it (a service message, §38.4).
    onRecordCreate((e) => {
      const links = require(`${__hooks}/xmpp/links.js`);
      links.beforeLinkSave(e);
      e.next();
      if (e.record) links.tellLinkChange(e.app, e.record, "", links.linkedRoom(e.record));
    }, "xmpp_links");

    onRecordUpdate((e) => {
      const links = require(`${__hooks}/xmpp/links.js`);
      links.beforeLinkSave(e);
      const rec = e.record;
      if (!rec) return e.next();
      // What it was, as stored, read in the save's transaction: the same change saved twice at once tells the room once.
      e.app.runInTransaction((tx) => {
        e.app = tx;
        const was = links.linkedRoom(tx.findRecordById("xmpp_links", rec.id));
        e.next();
        links.tellLinkChange(tx, rec, was, links.linkedRoom(rec));
      });
    }, "xmpp_links");

    onRecordAfterDeleteSuccess((e) => {
      const links = require(`${__hooks}/xmpp/links.js`);
      // Deleted with its room (cascade), there's no room left to tell.
      if (e.record) links.tellLinkChange(e.app, e.record, links.linkedRoom(e.record), "");
      e.next();
    }, "xmpp_links");
  }
}
