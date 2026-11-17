// `chirkle install-service` / `chirkle uninstall-service` (scripts/start.mjs): run Chirkle under systemd in one command.
//
//   sudo npx chirkle install-service chat.example.com      HTTPS (Let's Encrypt) on :80/:443
//   sudo npx chirkle install-service --http=127.0.0.1:8090  behind a reverse proxy (TRUSTED_PROXY=X-Forwarded-For)
//   npx chirkle install-service ... --dry-run               print what it would do, change nothing
//   sudo npx chirkle uninstall-service                      stop, disable and remove the unit (the data stays)
//
// It copies this version of the server, pb_public/, pb_migrations/ and pb_hooks/ to --prefix (/opt/chirkle), creates
// the system user --user (chirkle) that owns the data directory (<prefix>/pb_data, or --data), writes
// /etc/systemd/system/<--name>.service, and enables and (re)starts it. Running it again with a newer version upgrades
// in place: the files are replaced and the service restarted, the data is kept. Any other flags go to `serve`.

import { spawnSync } from "node:child_process";
import { chownSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const UNIT_DIR = "/etc/systemd/system";

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`chirkle: ${message}`);
  process.exit(1);
}

/**
 * Split `args` into our options and the flags passed through to `serve`.
 * @param {string[]} args
 */
export function parseArgs(args) {
  /** @type {{ prefix: string, user: string, name: string, data: string | undefined, dryRun: boolean, serve: string[] }} */
  const opts = { prefix: "/opt/chirkle", user: "chirkle", name: "chirkle", data: undefined, dryRun: false, serve: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = /** @type {string} */ (args[i]);
    const m = /^--(prefix|user|name|data)(?:=(.*))?$/.exec(arg);
    if (m) {
      const value = m[2] ?? args[++i];
      if (!value) fail(`--${m[1]} needs a value`);
      opts[/** @type {"prefix" | "user" | "name" | "data"} */ (m[1])] = value;
    } else if (arg === "--dry-run" || arg === "-n") {
      opts.dryRun = true;
    } else {
      opts.serve.push(arg);
    }
  }
  if (!isAbsolute(opts.prefix)) opts.prefix = resolve(opts.prefix);
  opts.data = opts.data ? resolve(opts.data) : join(opts.prefix, "pb_data");
  if (!/^[a-z_][a-z0-9_-]*$/.test(opts.user)) fail(`not a valid user name: ${opts.user}`);
  if (!/^[A-Za-z0-9_.@-]+$/.test(opts.name)) fail(`not a valid unit name: ${opts.name}`);
  return /** @type {typeof opts & { data: string }} */ (opts);
}

/** systemd's quoting for one ExecStart word. @param {string} s */
const quote = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`);

/**
 * The unit file.
 * @param {ReturnType<typeof parseArgs>} opts
 */
export function unitFile(opts) {
  const { prefix, data, user, serve } = opts;
  /** @param {string} flag */
  const has = (flag) => serve.some((a) => a === flag || a.startsWith(`${flag}=`));
  const domain = serve.find((a) => !a.startsWith("-"));
  const flags = [];
  if (!domain && !has("--https") && !has("--http")) flags.push("--http=127.0.0.1:8090");
  const defaults = {
    "--dir": data,
    "--publicDir": join(prefix, "pb_public"),
    "--migrationsDir": join(prefix, "pb_migrations"),
    "--hooksDir": join(prefix, "pb_hooks"),
    "--hooksPool": "100",
    // Upgrades replace pb_hooks/ and then restart: no reload in between against the old binary.
    "--hooksWatch": "false",
  };
  for (const [flag, value] of Object.entries(defaults)) if (!has(flag)) flags.push(`${flag}=${value}`);
  const argv = [join(prefix, "chirkle-server"), "serve", ...serve, ...flags];

  // On loopback only a proxy on this machine can reach it, so trust the client IP it forwards (docs/site/deploy/reverse-proxy.md).
  const http = [...serve, ...flags].find((a) => a.startsWith("--http="))?.slice("--http=".length) ?? "";
  const loopback = !domain && /^(127\.|localhost:|\[::1\]:)/.test(http);
  const port = Number(/:(\d+)$/.exec(http)?.[1] ?? 0);
  const lowPorts = Boolean(domain) || has("--https") || (port > 0 && port < 1024);

  return `# Written by \`chirkle install-service\`; running it again rewrites this file.
[Unit]
Description=Chirkle chat
After=network-online.target
Wants=network-online.target

[Service]
User=${user}
Group=${user}
WorkingDirectory=${prefix}
ExecStart=${argv.map(quote).join(" ")}
${loopback ? "Environment=TRUSTED_PROXY=X-Forwarded-For\n" : ""}Restart=on-failure
RestartSec=2
LimitNOFILE=65536
${lowPorts ? "AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n" : "CapabilityBoundingSet=\n"}NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${quote(data)}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * @param {string[]} args what followed `install-service`
 * @param {{ root: string, bin: string }} app where this version's files are
 */
export function install(args, { root, bin }) {
  const opts = parseArgs(args);
  const { prefix, data, user, name, dryRun } = opts;
  const unitPath = join(UNIT_DIR, `${name}.service`);
  const unit = unitFile(opts);
  const server = join(prefix, "chirkle-server");

  if (dryRun) {
    console.log(`would copy ${bin} and ${root}/{pb_public,pb_migrations,pb_hooks} to ${prefix}/`);
    console.log(`would create the system user ${user} (if missing) and the data directory ${data}, owned by it`);
    console.log(`would write ${unitPath}, then: systemctl daemon-reload && systemctl enable ${name} && systemctl restart ${name}\n`);
    process.stdout.write(unit);
    return;
  }
  preflight();

  // ---- the user ----
  if (spawnSync("id", ["-u", user], { stdio: "ignore" }).status !== 0) {
    const shell = ["/usr/sbin/nologin", "/sbin/nologin", "/bin/false"].find((s) => existsSync(s)) ?? "/bin/false";
    sh("useradd", ["--system", "--user-group", "--home-dir", data, "--no-create-home", "--shell", shell, user]);
  }

  // ---- the files: each staged next to its place and renamed over it, so a running server keeps its old binary ----
  mkdirSync(prefix, { recursive: true });
  const staged = `${server}.new`;
  cpSync(bin, staged);
  renameSync(staged, server);
  for (const dir of ["pb_public", "pb_migrations", "pb_hooks"]) {
    const dest = join(prefix, dir);
    const next = `${dest}.new`;
    const old = `${dest}.old`;
    rmSync(next, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    cpSync(join(root, dir), next, { recursive: true });
    if (existsSync(dest)) renameSync(dest, old);
    renameSync(next, dest);
    rmSync(old, { recursive: true, force: true });
  }
  if (!existsSync(data)) {
    mkdirSync(data, { recursive: true, mode: 0o750 });
    const ids = (/** @type {string} */ flag) => Number(spawnSync("id", [flag, user], { encoding: "utf8" }).stdout.trim());
    chownSync(data, ids("-u"), ids("-g"));
  }

  // ---- the unit ----
  const upgrade = existsSync(unitPath);
  writeFileSync(unitPath, unit);
  sh("systemctl", ["daemon-reload"]);
  sh("systemctl", ["enable", "--quiet", name]);
  sh("systemctl", ["restart", name]);

  const active = spawnSync("systemctl", ["is-active", "--quiet", name]).status === 0;
  console.log(`
${upgrade ? "Upgraded" : "Installed"} ${name}.service (${prefix}, data in ${data}): ${active ? "running" : "NOT running"}.
${active ? "" : `  See why:       journalctl -u ${name} -e\n`}  Logs:          journalctl -u ${name} -f
  Admin account: sudo -u ${user} ${server} superuser upsert you@example.com <password> --dir=${data}
  Upgrade:       sudo npx chirkle@latest install-service ${args.join(" ")}
  Remove:        sudo npx chirkle uninstall-service${name === "chirkle" ? "" : ` --name=${name}`}`);
  if (!active) process.exit(1);
}

/** @param {string[]} args */
export function uninstall(args) {
  const { name, prefix, data, dryRun } = parseArgs(args);
  const unitPath = join(UNIT_DIR, `${name}.service`);
  if (dryRun) {
    console.log(`would stop and disable ${name}, then remove ${unitPath}`);
    return;
  }
  preflight();
  if (!existsSync(unitPath)) fail(`${unitPath} does not exist`);
  sh("systemctl", ["disable", "--now", "--quiet", name]);
  rmSync(unitPath);
  sh("systemctl", ["daemon-reload"]);
  console.log(`Removed ${name}.service. The files are still in ${prefix} and the data in ${data}: delete them yourself.`);
}

function preflight() {
  if (process.platform !== "linux") fail("install-service needs Linux with systemd");
  if (spawnSync("systemctl", ["--version"], { stdio: "ignore" }).status !== 0) fail("systemctl not found: is this a systemd system?");
  if (process.getuid?.() !== 0) fail("run it as root: sudo npx chirkle install-service ... (or --dry-run to see what it does)");
}

/** @param {string} cmd @param {string[]} argv */
function sh(cmd, argv) {
  const r = spawnSync(cmd, argv, { stdio: "inherit" });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${argv.join(" ")} failed (exit ${r.status})`);
}
