// A minimal SMTP server for tests: accepts every message (no auth, no TLS) and keeps it, decoded from
// quoted-printable, so a test can read the links PocketBase emails.
import { createServer } from "node:net";

export interface Mail {
  to: string;
  subject: string;
  /** The whole message, soft line breaks joined and `=XX` escapes decoded. */
  text: string;
}

export interface SmtpSink {
  port: number;
  mails: Mail[];
  close(): Promise<void>;
}

const decodeQp = (s: string) =>
  s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

export function smtpSink(): Promise<SmtpSink> {
  const mails: Mail[] = [];
  const srv = createServer((sock) => {
    let buf = "";
    let data = false;
    let msg = "";
    sock.write("220 sink\r\n");
    sock.on("data", (d: Buffer) => {
      buf += d.toString("latin1");
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data) {
          if (line !== ".") {
            msg += `${line.startsWith("..") ? line.slice(1) : line}\n`;
            continue;
          }
          data = false;
          const text = decodeQp(msg);
          mails.push({ to: /^To: (.*)$/m.exec(msg)?.[1] ?? "", subject: /^Subject: (.*)$/m.exec(msg)?.[1] ?? "", text });
          msg = "";
          sock.write("250 ok\r\n");
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") sock.write("250-sink\r\n250 OK\r\n");
        else if (cmd === "DATA") {
          data = true;
          sock.write("354 go on\r\n");
        } else if (cmd === "QUIT") sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((ok, fail) => {
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (!addr || typeof addr !== "object") return fail(new Error("no port"));
      ok({ port: addr.port, mails, close: () => new Promise((done) => srv.close(() => done())) });
    });
  });
}

/** The token of the first password reset link (`/reset-password/{token}`) in `mail`. */
export const resetToken = (mail: Mail): string => /\/reset-password\/([\w.-]+)/.exec(mail.text)?.[1] ?? "";
