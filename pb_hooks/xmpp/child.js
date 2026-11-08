/// <reference path="../../types/pocketbase.d.ts" />
// The child (DESIGN.md §38.3): the Go program that holds the XMPP connection. PocketBase starts it on `serve`, and the
// worker starts it again when it stops sending its status (every 10 s). Each start makes a new secret, which both
// sides send with every request: a child left from before is refused, and exits.
//
// Its standard input is a pipe kept open here and never written to: once PocketBase exits, even killed, the pipe
// closes and the child exits. The pipe and the process live in the app store, which the JS runtimes of the pool
// share; and holding the pipe there keeps Go from closing it when nothing else refers to it.

const { bin, inbound } = require(`${__hooks}/xmpp/config.js`);

const KEY = "xmpp.child";
const RESTART = "xmpp.restart";
/** What the child and these hooks say to each other (xmpp-bridge/main.go `protocol`). */
const PROTOCOL = 1;
/** A child that hasn't said anything for this long is stuck, or gone: started again (shorter in tests). */
const STALE_MS = Number($os.getenv("CHIRKLE_XMPP_STALE_MS")) || 30_000;
/** Backoff between starts of a child that keeps failing: 5 s, 10 s, 20 s… up to 5 min. */
const BACKOFF_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;
/** A child that ran this long before it stopped wasn't failing: the backoff starts again. */
const HEALTHY_MS = 60_000;

/**
 * @typedef {object} Child
 * @property {any} cmd the exec.Cmd
 * @property {any} pipe its stdin
 * @property {string} secret
 * @property {number} startedAt
 * @property {number} beatAt when it last posted, 0 for never
 * @property {string} boot its hello's, "" until then
 * @property {number} port its API's, 0 until its hello
 */

/** @param {core.App} app @returns {Child | null} */
const current = (app) => /** @type {Child | null} */ (app.store().get(KEY) || null);

/**
 * Start the child, unless one runs.
 * @param {core.App} app
 */
function start(app) {
  if (current(app)) return;
  const secret = $security.randomString(40);
  const { url, addr } = inbound($os.args);
  const cmd = $os.cmd(bin());
  cmd.env = [
    ...cmd.environ().filter((v) => !v.startsWith("CHIRKLE_XMPP_")),
    `CHIRKLE_XMPP_SECRET=${secret}`,
    `CHIRKLE_XMPP_IN=${url}`,
    ...(addr ? [`CHIRKLE_XMPP_IN_ADDR=${addr}`] : []),
  ];
  const pipe = cmd.stdinPipe();
  /** @type {Child} */
  const child = { cmd, pipe, secret, startedAt: Date.now(), beatAt: 0, boot: "", port: 0 };
  // Stored first: its hello may come before start() returns, and is refused without its secret here.
  app.store().set(KEY, child);
  try {
    cmd.start();
  } catch (err) {
    app.store().remove(KEY);
    throw err;
  }
  app.logger().info("xmpp: child started", "pid", cmd.process?.pid, "posts to", url);
}

/**
 * Stop the child: its stdin closed (it exits on that), then killed, and waited for.
 * @param {core.App} app
 */
function stop(app) {
  const child = current(app);
  if (!child) return;
  app.store().remove(KEY);
  try {
    child.pipe.close();
  } catch {}
  try {
    child.cmd.process.kill();
  } catch {}
  try {
    child.cmd.wait();
  } catch {}
}

/**
 * The worker's look at the child, each pass: started when there is none (after the backoff), started again when it
 * has gone quiet.
 * @param {core.App} app
 */
function supervise(app) {
  const now = Date.now();
  const child = current(app);
  if (child) {
    if (now - Math.max(child.startedAt, child.beatAt) < STALE_MS) return;
    app.logger().warn("xmpp: child went quiet: starting it again", "pid", child.cmd.process.pid);
    stop(app);
    const ran = now - child.startedAt;
    app.store().setFunc(RESTART, (old) => {
      const fails = ran >= HEALTHY_MS ? 1 : Number(old?.fails || 0) + 1;
      return { fails, at: now + Math.min(BACKOFF_MS * 2 ** (fails - 1), BACKOFF_MAX_MS) };
    });
  }
  const restart = app.store().get(RESTART);
  if (restart && now < Number(restart.at)) return;
  try {
    start(app);
  } catch (err) {
    app.logger().error("xmpp: child didn't start", "bin", bin(), "error", String(err));
    app.store().setFunc(RESTART, (old) => {
      const fails = Number(old?.fails || 0) + 1;
      return { fails, at: now + Math.min(BACKOFF_MS * 2 ** (fails - 1), BACKOFF_MAX_MS) };
    });
  }
}

/**
 * Is this request from our child? Its secret, compared in constant time.
 * @param {core.App} app
 * @param {string} secret
 */
function isOurs(app, secret) {
  const child = current(app);
  return !!child && !!secret && $security.equal(secret, child.secret);
}

/**
 * The child's hello: its API's port, and the protocol it speaks. A child of another protocol is stopped (and left
 * stopped until a restart: the binary doesn't match these hooks).
 * @param {core.App} app
 * @param {any} ev
 */
function hello(app, ev) {
  if (ev.protocol !== PROTOCOL) {
    app
      .logger()
      .error(
        "xmpp: the child speaks another protocol: CHIRKLE_XMPP_BIN isn't this version's",
        "protocol",
        ev.protocol,
        "version",
        ev.version,
      );
    stop(app);
    app.store().set(RESTART, { fails: 99, at: Date.now() + 365 * 24 * 3600_000 });
    return;
  }
  update(app, (c) => ({ ...c, boot: String(ev.boot || ""), port: Number(ev.port) || 0, beatAt: Date.now() }));
  app.logger().info("xmpp: child ready", "version", ev.version, "port", ev.port);
}

/**
 * The child said something: it is alive.
 * @param {core.App} app
 */
function beat(app) {
  update(app, (c) => ({ ...c, beatAt: Date.now() }));
}

/**
 * @param {core.App} app
 * @param {(c: Child) => Child} fn
 */
function update(app, fn) {
  app.store().setFunc(KEY, (old) => (old ? fn(/** @type {Child} */ (old)) : old));
}

/** A request to the child that failed; transient when it may work later. */
class ChildError extends Error {
  /** @param {string} message @param {boolean} transient @param {string} [code] why an upload can't be ("unsupported", "too_large") */
  constructor(message, transient, code = "") {
    super(message);
    this.transient = transient;
    this.code = code;
  }
}

/**
 * POST to the child's API (xmpp-bridge/api.go). Throws a ChildError.
 * @param {core.App} app
 * @param {string} path
 * @param {any} body
 * @param {number} [timeout] seconds
 */
function call(app, path, body, timeout = 30) {
  const child = current(app);
  if (!child?.port) throw new ChildError("the child isn't running", true);
  let res;
  try {
    res = $http.send({
      url: `http://127.0.0.1:${child.port}${path}`,
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-chirkle-bridge": child.secret },
      timeout,
    });
  } catch (err) {
    throw new ChildError(String(err), true);
  }
  if (res.statusCode === 200) return res.json;
  const error = res.json?.error || `HTTP ${res.statusCode}`;
  throw new ChildError(error, res.statusCode >= 500 || !!res.json?.transient, String(res.json?.code || ""));
}

module.exports = { start, stop, supervise, isOurs, hello, beat, call, current, ChildError };
