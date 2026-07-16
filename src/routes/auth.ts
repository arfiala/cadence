// Auth routes for Cadence's single-user login. Mirrors the Suretas
// email+password pattern (src/routes/auth.ts there, read for reference, not
// modified) but stripped to exactly what a single-user app needs: no
// /auth/register (ISC-18), no forgot-password email flow (there is no email
// sending in Cadence at all — password reset is bin/set-password.ts over
// SSH, per the ISA's constraint that SSH access = reset ability).

import { db } from "../db";
import type { UserRow } from "../db";
import { jsonError, readJsonBody } from "../lib/http";
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from "../auth/password";
import { createSession, destroySession, destroySessionCookieHeader, getAuthUser } from "../auth/session";
import { allowLoginAttempt } from "../auth/rateLimit";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // ISC-102: 15-minute self-expiring lockout

type LoginUserRow = Pick<
  UserRow,
  "id" | "email" | "password_hash" | "failed_login_attempts" | "locked_until"
>;

// THE one and only login-failure response (ISC-14). Every failure mode —
// unknown email, wrong password, no password set, locked account, or no
// user provisioned at all — returns exactly this, so the response can never
// be used to distinguish one failure reason from another.
function loginFailureResponse(): Response {
  return Response.json({ error: "Invalid email or password." }, { status: 401 });
}

function isValidEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 3 &&
    value.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

async function handleLogin(req: Request, clientIp: string): Promise<Response> {
  if (!allowLoginAttempt(clientIp)) {
    return jsonError("Too many login attempts. Try again in a minute.", 429);
  }

  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);

  const email = body.email;
  const password = body.password;
  if (typeof email !== "string" || typeof password !== "string") {
    return jsonError("Email and password are required", 400);
  }
  if (!isValidEmail(email)) {
    // Still burn a dummy verify so this branch doesn't respond faster than a
    // well-formed-but-wrong-password attempt.
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return loginFailureResponse();
  }
  const normalizedEmail = email.toLowerCase();

  const user = db
    .query(
      "SELECT id, email, password_hash, failed_login_attempts, locked_until FROM users WHERE email = ?",
    )
    .get(normalizedEmail) as LoginUserRow | null;

  if (user === null) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return loginFailureResponse();
  }

  if (user.locked_until !== null) {
    const lockedMs = Date.parse(user.locked_until);
    if (!Number.isNaN(lockedMs) && lockedMs > Date.now()) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      return loginFailureResponse();
    }
  }

  if (user.password_hash === null) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return loginFailureResponse();
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    // Atomic increment via RETURNING, not a JS read-modify-write — the
    // Suretas lesson this ISA cites verbatim (ISC-13): concurrent
    // wrong-password requests must not race past the lockout threshold.
    const incremented = db
      .query(
        "UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ? RETURNING failed_login_attempts",
      )
      .get(user.id) as { failed_login_attempts: number };
    if (incremented.failed_login_attempts >= MAX_FAILED_LOGINS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
      db.query("UPDATE users SET locked_until = ? WHERE id = ?").run(lockedUntil, user.id);
    }
    return loginFailureResponse();
  }

  db.query(
    "UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
  ).run(user.id);
  const cookie = createSession(user.id);

  return Response.json({ message: "Logged in." }, { headers: { "Set-Cookie": cookie } });
}

function handleLogout(req: Request): Response {
  const user = getAuthUser(req);
  if (user !== null && user.via === "session" && user.session_id !== undefined) {
    destroySession(user.session_id);
  }
  return Response.json(
    { message: "Logged out." },
    { headers: { "Set-Cookie": destroySessionCookieHeader() } },
  );
}

// Dispatch /auth/* requests. Anything else (including /auth/register, which
// deliberately does not exist — ISC-18) falls through to 404.
export async function handleAuth(req: Request, url: URL, clientIp: string): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/auth/login" && method === "POST") {
    return handleLogin(req, clientIp);
  }
  if (path === "/auth/logout" && method === "POST") {
    return handleLogout(req);
  }

  return jsonError("Not found", 404);
}
