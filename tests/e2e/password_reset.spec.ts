// Forgot password (DESIGN.md §39) in a real browser: with the server's mail settings on, "Forgot password?" emails a
// link (caught by a test SMTP server); its page sets a new password and logs in with it, and the old one stops working.

import { expect } from "@playwright/test";
import { SUPERUSER } from "../support/pocketbase.ts";
import { resetToken, type SmtpSink, smtpSink } from "../support/smtp.ts";
import { apiUser, atPath, test } from "./fixtures.ts";
import { E2E_BASE } from "./paths.ts";

async function admin(method: string, path: string, body?: unknown) {
  const auth = await fetch(`${E2E_BASE}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: SUPERUSER.email, password: SUPERUSER.password }),
  });
  const { token } = (await auth.json()) as { token: string };
  const res = await fetch(`${E2E_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", Authorization: token },
    body: body === undefined ? null : JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as Record<string, unknown>;
}

let sink: SmtpSink;
let smtp: Record<string, unknown>;

test.beforeAll(async () => {
  sink = await smtpSink();
  smtp = (await admin("GET", "/api/settings")).smtp as Record<string, unknown>;
  await admin("PATCH", "/api/settings", { smtp: { ...smtp, enabled: true, host: "127.0.0.1", port: sink.port, tls: false } });
});
test.afterAll(async () => {
  await admin("PATCH", "/api/settings", { smtp });
  await sink.close();
});

test("forgot password: the emailed link sets a new password and logs in", async ({ page }) => {
  const ada = await apiUser("Ada");
  await page.goto("/login");
  await page.getByLabel("Email").fill(ada.email.toUpperCase());
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Reset password" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveValue(ada.email.toUpperCase());
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(page.getByRole("status")).toContainText("a link to set a new password is on its way");

  await expect.poll(() => sink.mails.filter((m) => m.to.includes(ada.email)).length, { timeout: 5_000 }).toBe(1);
  const token = resetToken(sink.mails.find((m) => m.to.includes(ada.email))!);
  await page.goto(`/reset-password/${token}`);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill("brand-new-pass");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page).toHaveURL(atPath("/"));
  await expect(page.locator(".app-bar:visible, .side-foot")).toContainText("Ada");

  // The link worked once, and the old password is gone.
  const old = await fetch(`${E2E_BASE}/api/collections/users/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: ada.email, password: ada.password }),
  });
  expect(old.status).toBe(400);
  await page.goto(`/reset-password/${token}`);
  await page.getByLabel("New password", { exact: true }).fill("another-pass-1");
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("alert")).toHaveText("This link has expired or was already used. Ask for a new one.");
});
