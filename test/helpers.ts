// Shared test helpers. The db singleton is bound to an isolated temp file by
// test/setup.ts (preload); resetDb() clears every table between tests so the
// shared-process, sequential Bun test runner gets a clean slate each time.

import { db } from "../src/db";
import { hashPassword } from "../src/auth/password";
import { hashToken } from "../src/auth/session";
import { randomBytes } from "node:crypto";
import { fetchHandler } from "../src/server";

export function resetDb(): void {
  db.exec("DELETE FROM sessions;");
  db.exec("DELETE FROM api_tokens;");
  db.exec("DELETE FROM activities;");
  db.exec("DELETE FROM sync_runs;");
  db.exec("DELETE FROM zwiftpower_results;");
  db.exec("DELETE FROM zwiftpower_sync_runs;");
  db.exec("DELETE FROM nutrition_items;");
  db.exec("DELETE FROM nutrition_entries;");
  db.exec("DELETE FROM users;");
  db.exec("DELETE FROM settings;");
  db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('target_sessions','5');");
  db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('target_hours','8');");
  db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('nutrition_target_kcal','2200');");
  db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('nutrition_target_protein_g','150');");
}

export const TEST_EMAIL = "austin@example.com";
export const TEST_PASSWORD = "correct-horse-battery-staple";

export async function seedUser(
  email = TEST_EMAIL,
  password = TEST_PASSWORD,
): Promise<number> {
  const hash = await hashPassword(password);
  const row = db
    .query(
      "INSERT INTO users (email, password_hash, failed_login_attempts, locked_until) VALUES (?, ?, 0, NULL) RETURNING id",
    )
    .get(email.toLowerCase(), hash) as { id: number };
  return row.id;
}

// Issue a bearer token directly against the DB (mirrors bin/issue-token.ts)
// and return the raw token for use in Authorization headers.
export function seedToken(label = "test"): string {
  const token = randomBytes(32).toString("hex");
  db.query("INSERT INTO api_tokens (token_hash, label) VALUES (?, ?)").run(
    hashToken(token),
    label,
  );
  return token;
}

// A stub IP provider matching the shape fetchHandler expects for its second
// argument (Bun's server.requestIP), so route tests can call the handler
// directly without binding a socket.
const stubServer = {
  requestIP: (_req: Request) => ({ address: "127.0.0.1" }),
};

// Call the real fetch handler with a token-authenticated request. Returns the
// Response. Used by route tests to exercise the full server routing without
// starting a listener.
export function apiRequest(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  return fetchHandler(req, stubServer);
}

// Insert an activity row directly for fixture setup. Returns the new id.
export function insertActivity(fields: {
  source?: "garmin" | "manual";
  garmin_id?: string | null;
  sport: string;
  raw_type?: string | null;
  start_time: string;
  duration_s: number;
  distance_m?: number | null;
  title?: string | null;
  notes?: string | null;
}): number {
  const row = db
    .query(
      `INSERT INTO activities (source, garmin_id, sport, raw_type, start_time, duration_s, distance_m, title, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      fields.source ?? "manual",
      fields.garmin_id ?? null,
      fields.sport,
      fields.raw_type ?? null,
      fields.start_time,
      fields.duration_s,
      fields.distance_m ?? null,
      fields.title ?? null,
      fields.notes ?? null,
    ) as { id: number };
  return row.id;
}
