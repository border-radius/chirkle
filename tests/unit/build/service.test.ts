import { describe, expect, it } from "vitest";
import { parseArgs, unitFile } from "../../../scripts/service.mjs";

const unit = (...args: string[]) => unitFile(parseArgs(args));
const line = (text: string, key: string) => text.split("\n").find((l) => l.startsWith(`${key}=`));

describe("install-service unit file", () => {
  it("serves a domain with HTTPS on the privileged ports", () => {
    const text = unit("chat.example.com");
    expect(line(text, "ExecStart")).toBe(
      "ExecStart=/opt/chirkle/chirkle-server serve chat.example.com --dir=/opt/chirkle/pb_data --publicDir=/opt/chirkle/pb_public --migrationsDir=/opt/chirkle/pb_migrations --hooksDir=/opt/chirkle/pb_hooks --hooksPool=100 --hooksWatch=false",
    );
    expect(line(text, "AmbientCapabilities")).toBe("AmbientCapabilities=CAP_NET_BIND_SERVICE");
    expect(line(text, "Environment")).toBeUndefined();
    expect(line(text, "User")).toBe("User=chirkle");
  });

  it("behind a proxy on loopback, trusts its forwarded client IP and binds no low ports", () => {
    const text = unit();
    expect(line(text, "ExecStart")).toContain(" serve --http=127.0.0.1:8090 ");
    expect(line(text, "Environment")).toBe("Environment=TRUSTED_PROXY=X-Forwarded-For");
    expect(line(text, "AmbientCapabilities")).toBeUndefined();
    expect(line(text, "CapabilityBoundingSet")).toBe("CapabilityBoundingSet=");
  });

  it("does not trust X-Forwarded-For when clients can reach it directly", () => {
    const text = unit("--http=0.0.0.0:8090");
    expect(line(text, "Environment")).toBeUndefined();
    expect(line(text, "ExecStart")).not.toContain("127.0.0.1");
  });

  it("takes its own options, passes the rest to serve, and quotes paths", () => {
    const opts = parseArgs(["--prefix", "/srv/my chat", "--user=chat", "--data=/var/lib/chat", "-n", "--dev"]);
    expect(opts).toMatchObject({ prefix: "/srv/my chat", user: "chat", data: "/var/lib/chat", dryRun: true, serve: ["--dev"] });
    const text = unitFile(opts);
    expect(line(text, "ExecStart")).toMatch(/^ExecStart="\/srv\/my chat\/chirkle-server" serve --dev /);
    expect(line(text, "ExecStart")).toContain(" --dir=/var/lib/chat ");
    expect(line(text, "ReadWritePaths")).toBe("ReadWritePaths=/var/lib/chat");
  });
});
