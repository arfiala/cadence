// Auth tests (ISC-11..23, ISC-88). The four mandated hard cases: lockout
// race under parallel wrong-password requests, enumeration byte-equality,
// token revocation, and the unauthenticated sweep across every /api route.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedUser, seedToken, apiRequest, TEST_EMAIL, TEST_PASSWORD } from "./helpers";
import { _resetRateLimitState } from "../src/auth/rateLimit";

beforeEach(async () => {
  resetDb();
  _resetRateLimitState();
  await seedUser();
});

async function login(email: string, password: string): Promise<Response> {
  return apiRequest("POST", "/auth/login", { body: { email, password } });
}

describe("login success + session cookie (ISC-15)", () => {
  test("valid credentials return a HttpOnly, Secure, SameSite=Lax, 30-day cookie", async () => {
    const res = await login(TEST_EMAIL, TEST_PASSWORD);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Max-Age=2592000"); // 30 days in seconds
  });
});

describe("password hashing (ISC-12)", () => {
  test("stored hash is argon2id, not plaintext", () => {
    const row = db.query("SELECT password_hash FROM users LIMIT 1").get() as { password_hash: string };
    expect(row.password_hash).not.toBe(TEST_PASSWORD);
    expect(row.password_hash.startsWith("$argon2id$")).toBe(true);
  });
});

describe("lockout race (ISC-13, ISC-88)", () => {
  test("10 concurrent wrong-password logins increment the counter to 10, not 1", async () => {
    // The whole point of the atomic SQL increment: a JS read-modify-write
    // would leave the counter at 1 here (all reads see 0 before any write).
    await Promise.all(
      Array.from({ length: 10 }, () => login(TEST_EMAIL, "wrong-password-guess")),
    );
    const row = db.query("SELECT failed_login_attempts, locked_until FROM users LIMIT 1").get() as {
      failed_login_attempts: number;
      locked_until: string | null;
    };
    expect(row.failed_login_attempts).toBe(10);
    expect(row.locked_until).not.toBeNull();
  });

  test("account locks after 5 failures and even the correct password then fails", async () => {
    for (let i = 0; i < 5; i++) {
      await login(TEST_EMAIL, "nope");
    }
    const res = await login(TEST_EMAIL, TEST_PASSWORD);
    expect(res.status).toBe(401);
  });
});

describe("lockout auto-expiry (ISC-102)", () => {
  test("a lock in the past no longer blocks a correct login", async () => {
    // Force a locked state that already expired.
    db.query(
      "UPDATE users SET failed_login_attempts = 5, locked_until = ? WHERE email = ?",
    ).run(new Date(Date.now() - 60_000).toISOString(), TEST_EMAIL);
    const res = await login(TEST_EMAIL, TEST_PASSWORD);
    expect(res.status).toBe(200);
  });
});

describe("enumeration byte-equality (ISC-14, ISC-88)", () => {
  test("unknown-email and wrong-password failures return byte-identical bodies", async () => {
    const unknown = await login("nobody@example.com", "whatever-guess-here");
    const wrong = await login(TEST_EMAIL, "wrong-password-here");
    expect(unknown.status).toBe(wrong.status);
    const unknownBody = await unknown.text();
    const wrongBody = await wrong.text();
    expect(unknownBody).toBe(wrongBody);
  });

  test("a locked account and a wrong password also return identical bodies", async () => {
    db.query(
      "UPDATE users SET locked_until = ? WHERE email = ?",
    ).run(new Date(Date.now() + 60_000).toISOString(), TEST_EMAIL);
    const locked = await login(TEST_EMAIL, TEST_PASSWORD);
    // Different account so it's genuinely a wrong-password, not locked.
    const wrong = await login("someone-else@example.com", "bad");
    expect(await locked.text()).toBe(await wrong.text());
  });
});

describe("bearer tokens (ISC-20, ISC-21)", () => {
  test("issued token is stored only as a SHA-256 hash, never raw", () => {
    const token = seedToken();
    const rows = db.query("SELECT token_hash FROM api_tokens").all() as { token_hash: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash.length).toBe(64); // sha256 hex
  });

  test("a valid token authenticates an API request", async () => {
    const token = seedToken();
    const res = await apiRequest("GET", "/api/week", { token });
    expect(res.status).toBe(200);
  });

  test("a revoked token is rejected with 401 (ISC-21, ISC-88)", async () => {
    const token = seedToken();
    db.query("UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();
    const res = await apiRequest("GET", "/api/week", { token });
    expect(res.status).toBe(401);
  });
});

describe("logout destroys the session (ISC-16)", () => {
  test("a session cookie is invalid after logout", async () => {
    const loginRes = await login(TEST_EMAIL, TEST_PASSWORD);
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0]!; // cadence_session=<uuid>

    // Confirm the cookie works first.
    const before = await apiRequest("GET", "/api/week", { cookie });
    expect(before.status).toBe(200);

    await apiRequest("POST", "/auth/logout", { cookie });

    const after = await apiRequest("GET", "/api/week", { cookie });
    expect(after.status).toBe(401);
  });
});

describe("no /register endpoint (ISC-18)", () => {
  test("POST /auth/register is 404", async () => {
    const res = await apiRequest("POST", "/auth/register", { body: { email: "x@y.com", password: "z".repeat(12) } });
    expect(res.status).toBe(404);
  });
});

describe("rate limiting (ISC-23)", () => {
  test("more than 10 login attempts from one IP in a window get 429", async () => {
    _resetRateLimitState();
    let sawRateLimit = false;
    for (let i = 0; i < 15; i++) {
      const res = await login(TEST_EMAIL, "bad-guess-here");
      if (res.status === 429) sawRateLimit = true;
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe("unauthenticated sweep (ISC-19, ISC-88)", () => {
  const protectedRoutes: [string, string][] = [
    ["GET", "/api/activities"],
    ["POST", "/api/activities"],
    ["PATCH", "/api/activities/1"],
    ["DELETE", "/api/activities/1"],
    ["GET", "/api/week"],
    ["GET", "/api/trends"],
    ["GET", "/api/settings"],
    ["PATCH", "/api/settings"],
    ["POST", "/api/sync"],
    ["GET", "/api/sync/status"],
    ["POST", "/api/import/csv"],
  ];

  for (const [method, path] of protectedRoutes) {
    test(`${method} ${path} without auth is 401`, async () => {
      const res = await apiRequest(method, path, {});
      expect(res.status).toBe(401);
    });
  }

  test("/health is reachable WITHOUT auth (ISC-44)", async () => {
    const res = await apiRequest("GET", "/health", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toEqual({ status: "ok", service: "cadence" });
  });
});
