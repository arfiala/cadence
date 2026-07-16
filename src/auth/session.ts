// Session + bearer-token authentication middleware. Every /api/* route
// except /health and /auth/login accepts EITHER a valid session cookie OR a
// valid API bearer token (ISC-19) — the web UI uses the former, the MCP
// server uses the latter, and they carry identical single-user scope.

import { randomUUID, createHash } from "node:crypto";
import { db } from "../db";
import type { SessionRow, UserRow } from "../db";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (ISC-15)
export const SESSION_COOKIE_NAME = "cadence_session";

export type AuthedUser = {
  user_id: number;
  via: "session" | "token";
  session_id?: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

// Build the Set-Cookie header for a fresh session. HttpOnly + Secure +
// SameSite=Lax, 30-day Max-Age (ISC-15). Secure is always set — Cadence only
// ever runs behind HTTPS in production, and in local dev the cookie simply
// won't round-trip over plain http, which is the correct conservative
// default for a single-user health-data app.
export function createSession(userId: number): string {
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.query("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").run(
    sessionId,
    userId,
    expiresAt,
  );
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function destroySessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === null) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key.length > 0) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sessionFromCookie(req: Request): AuthedUser | null {
  const cookies = parseCookies(req.headers.get("cookie"));
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (sessionId === undefined || sessionId.length === 0) return null;

  const row = db
    .query("SELECT * FROM sessions WHERE id = ?")
    .get(sessionId) as SessionRow | null;
  if (row === null) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  return { user_id: row.user_id, via: "session", session_id: row.id };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenFromHeader(req: Request): AuthedUser | null {
  const header = req.headers.get("authorization");
  if (header === null || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (token.length === 0) return null;

  const hash = hashToken(token);
  const row = db
    .query(
      "SELECT id FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
    )
    .get(hash) as { id: number } | null;
  if (row === null) return null;

  // Single-user app: any valid, unrevoked token authenticates as the sole
  // user row. If no user has been created yet (fresh install, no
  // set-password run), there is nothing to authenticate as.
  const user = db.query("SELECT id FROM users LIMIT 1").get() as
    | { id: number }
    | null;
  if (user === null) return null;

  return { user_id: user.id, via: "token" };
}

// Resolve the authenticated user for a request, trying the session cookie
// first, then the bearer token. Returns null when neither is valid.
export function getAuthUser(req: Request): AuthedUser | null {
  return sessionFromCookie(req) ?? tokenFromHeader(req);
}

export function requireAuth(req: Request): AuthedUser | Response {
  const user = getAuthUser(req);
  if (user === null) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }
  return user;
}

export function destroySession(sessionId: string): void {
  db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function getSingleUser(): UserRow | null {
  return db.query("SELECT * FROM users LIMIT 1").get() as UserRow | null;
}
