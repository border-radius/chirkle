/// <reference path="../../types/pocketbase.d.ts" />
// The XMPP bridge's settings (DESIGN.md §38.2), all from the environment. The child reads XMPP_* itself, from the
// environment it inherits; the hooks only need to know whether the bridge is on, and where the child is.

/** The child's binary: start.mjs and the Docker image set it (§38.9). */
const bin = () => $os.getenv("CHIRKLE_XMPP_BIN").trim();

/** The bridge is set up: an account, and a binary to hold it. */
const configured = () => !!($os.getenv("XMPP_JID").trim() && $os.getenv("XMPP_PASSWORD") && bin());

/** Whether the binary is there, looked for once per JS runtime (the pool's). */
let found = /** @type {boolean | null} */ (null);

/** The bridge is on: set up, and its binary is there. */
function on() {
  if (!configured()) return false;
  if (found === null) {
    try {
      found = !$os.stat(bin()).isDir();
    } catch {
      found = false;
    }
  }
  return found;
}

/**
 * Where the child posts its events (`url`), and the address to connect to for it when that isn't the URL's host
 * (`addr`: PocketBase serving HTTPS for a domain, whose certificate names the domain, not 127.0.0.1). Read from the
 * `serve` command's own flags, as PocketBase reads them.
 * @param {string[]} args
 * @returns {{ url: string, addr: string }}
 */
function inbound(args) {
  const at = args.indexOf("serve");
  const rest = at < 0 ? [] : args.slice(at + 1);
  /** @param {string} name */
  const flag = (name) => {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith(`--${name}=`)) return rest[i].slice(name.length + 3);
      if (rest[i] === `--${name}` && i + 1 < rest.length) return rest[i + 1];
    }
    return "";
  };
  const domains = rest.filter(
    (a, i) =>
      !a.startsWith("-") &&
      !/^--(http|https|dir|hooksDir|publicDir|migrationsDir|encryptionEnv|origins|hooksPool)$/.test(rest[i - 1] || ""),
  );
  const https = flag("https") || (domains.length && !flag("http") ? "0.0.0.0:443" : "");
  if (https && domains.length) {
    return { url: `https://${domains[0]}/api/xmpp/in`, addr: local(https, "443") };
  }
  return { url: `http://${local(flag("http") || "127.0.0.1:8090", "8090")}/api/xmpp/in`, addr: "" };
}

/**
 * host:port PocketBase listens on, as an address to reach it on this machine: 127.0.0.1 for any address.
 * @param {string} listen
 * @param {string} port when it says none
 */
function local(listen, port) {
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(listen);
  const host = m ? m[1] : "";
  const any = ["", "0.0.0.0", "[::]", "::"].includes(host);
  return `${any ? "127.0.0.1" : host}:${m?.[2] || port}`;
}

module.exports = { bin, configured, on, inbound };
