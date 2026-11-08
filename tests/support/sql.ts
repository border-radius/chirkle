// Fixture SQL for the test server, through its own write connection: the client side of the test-only route that
// tests/support/pocketbase.ts adds (fixtureRoute). Only fetch, so the component project (happy-dom) can use it too.

export const SUPERUSER = { email: "admin@test.local", password: "test-password-123" } as const;

export interface SqlStatement {
  /** SQL with {:name} placeholders. */
  sql: string;
  params?: Record<string, string | number>;
}

const superuserTokens = new Map<string, Promise<string>>();

/** Run fixture SQL on the test server at `url` (started with `fixtureRoute`), all statements in one transaction. */
export async function runSql(url: string, statements: SqlStatement[], retried = false): Promise<void> {
  let token = superuserTokens.get(url);
  if (!token) {
    token = fetch(`${url}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: SUPERUSER.email, password: SUPERUSER.password }),
    }).then(async (res) => {
      if (!res.ok) throw new Error(`superuser login → ${res.status}`);
      return ((await res.json()) as { token: string }).token;
    });
    superuserTokens.set(url, token);
    token.catch(() => superuserTokens.delete(url));
  }
  const res = await fetch(`${url}/api/test/sql`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: await token },
    body: JSON.stringify({ statements }),
  });
  // A server started again on the same address (and data) has a new superuser token: logged in again.
  if (res.status === 401 && !retried) {
    superuserTokens.delete(url);
    return runSql(url, statements, true);
  }
  if (!res.ok) throw new Error(`POST /api/test/sql → ${res.status} ${await res.text()}`);
}
