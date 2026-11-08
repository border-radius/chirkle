// A stand-in for the XMPP bridge's child (xmpp-bridge/, DESIGN.md §38.3) that PocketBase starts in the tests: it
// listens as the child does and passes every request PocketBase makes to the test's hub (tests/support/xmpp.ts),
// which decides the answer. Everything the child would post to PocketBase, the hub posts itself. Like the child, it
// exits once its standard input closes.

import { createServer } from "node:http";

const hub = process.env.XMPP_STUB_HUB;
const secret = process.env.CHIRKLE_XMPP_SECRET;

process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    if (req.headers["x-chirkle-bridge"] !== secret) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"error":"wrong secret"}');
    }
    try {
      const r = await fetch(`${hub}/request`, {
        method: "POST",
        body: JSON.stringify({ pid: process.pid, path: req.url, body: JSON.parse(body || "{}") }),
      });
      const { status, json } = await r.json();
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  fetch(`${hub}/started`, {
    method: "POST",
    body: JSON.stringify({
      pid: process.pid,
      port,
      secret,
      in: process.env.CHIRKLE_XMPP_IN,
      inAddr: process.env.CHIRKLE_XMPP_IN_ADDR || "",
      jid: process.env.XMPP_JID,
    }),
  }).catch(() => process.exit(1));
});
