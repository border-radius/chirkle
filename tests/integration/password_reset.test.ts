import type PocketBase from "pocketbase";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { resetToken, type SmtpSink, smtpSink } from "../support/smtp.ts";
import { adminClient, client, eventually, newUser, sleep, status, uniq } from "./helpers.ts";

const reset = (email: string) => client().collection("users").requestPasswordReset(email);
const confirm = (token: string, password: string) => client().collection("users").confirmPasswordReset(token, password, password);
const siteFlag = async () =>
  (await client().collection("site").getList(1, 1, { sort: "created", fields: "id,password_reset" })).items[0]?.password_reset;

describe("forgot password (§39)", () => {
  let admin: PocketBase;
  let sink: SmtpSink;
  let smtp: Record<string, unknown>;

  beforeAll(async () => {
    admin = await adminClient();
    sink = await smtpSink();
    smtp = (await admin.settings.getAll()).smtp as Record<string, unknown>;
  });
  afterAll(async () => {
    await admin.settings.update({ smtp });
    await sink.close();
  });

  const mailOn = () => admin.settings.update({ smtp: { ...smtp, enabled: true, host: "127.0.0.1", port: sink.port, tls: false } });
  const mailsTo = (email: string) => sink.mails.filter((m) => m.to.includes(email));

  it("is offered only while the server can send email", async () => {
    await admin.settings.update({ smtp: { ...smtp, enabled: false } });
    expect(await siteFlag()).toBe(false);
    await mailOn();
    expect(await siteFlag()).toBe(true);
  });

  it("emails a link to the app's page, which sets a new password once and signs out every session", async () => {
    await mailOn();
    const u = await newUser();
    expect(await status(reset(u.email))).toBe(200);
    await eventually(() => expect(mailsTo(u.email)).toHaveLength(1), 5_000);
    const mail = mailsTo(u.email)[0]!;
    expect(mail.text).toContain(`${(await admin.settings.getAll()).meta.appURL}/reset-password/`);
    expect(mail.text).not.toContain("/_/#/auth/");
    const token = resetToken(mail);
    expect(token).not.toBe("");

    // Too long for PocketBase: refused with the reason, and the link still works (QA BUG-267).
    const long = await confirm(token, "z".repeat(100)).then(
      () => null,
      (e: { response: { data: { password?: { message: string } } } }) => e.response.data.password?.message,
    );
    expect(long).toMatch(/^Use at most 71 characters/);
    await confirm(token, "brand-new-pass");
    expect(await status(u.pb.collection("users").authRefresh())).toBe(401);
    expect(await status(client().collection("users").authWithPassword(u.email, u.password))).toBe(400);
    expect(await status(client().collection("users").authWithPassword(u.email, "brand-new-pass"))).toBe(200);
    // Used once: the same link can't set another password.
    expect(await status(confirm(token, "another-pass-1"))).toBe(400);
  });

  it("answers the same for an unknown address, and sends nothing to it", async () => {
    await mailOn();
    const email = `nobody-${uniq()}@test.local`;
    expect(await status(reset(email))).toBe(200);
    await sleep(300);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it("sends nothing to a stand-in's made-up address", async () => {
    await mailOn();
    const email = `tg${Date.now()}.${uniq()
      .toLowerCase()
      .replace(/[^a-z]/g, "")}@telegram.invalid`;
    await admin
      .collection("users")
      .create({ email, password: "password-123", passwordConfirm: "password-123", name: `stand-in-${uniq()}` });
    expect(await status(reset(email))).toBe(200);
    await sleep(300);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it("refuses a short password, and a made-up token", async () => {
    await mailOn();
    const u = await newUser();
    await reset(u.email);
    await eventually(() => expect(mailsTo(u.email)).toHaveLength(1), 5_000);
    expect(await status(confirm(resetToken(mailsTo(u.email)[0]!), "short"))).toBe(400);
    expect(await status(confirm("not-a-token", "long-enough-pass"))).toBe(400);
  });

  it("asking again at once sends no second email, and asking is limited per IP", async () => {
    await mailOn();
    const u = await newUser();
    await reset(u.email);
    await eventually(() => expect(mailsTo(u.email)).toHaveLength(1), 5_000);
    await reset(u.email);
    await sleep(300);
    expect(mailsTo(u.email)).toHaveLength(1);
    expect(inject("bootRateLimits").rules).toContainEqual({
      label: "users:requestPasswordReset",
      audience: "",
      duration: 600,
      maxRequests: 5,
    });
  });
});
