// GET /api/settings + PATCH /api/settings (ISC-42) — the weekly G1 targets
// (sessions, hours), editable without a redeploy (ISC-3).

import { db } from "../db";
import { jsonError, readJsonBody } from "../lib/http";
import { getSettings } from "../services/weekSummary";

export function getSettingsRoute(): Response {
  return Response.json(getSettings());
}

export async function patchSettingsRoute(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);

  const updates: [string, string][] = [];

  if ("target_sessions" in body) {
    const v = body.target_sessions;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return jsonError("target_sessions must be a positive integer", 400);
    }
    updates.push(["target_sessions", String(v)]);
  }
  if ("target_hours" in body) {
    const v = body.target_hours;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return jsonError("target_hours must be a positive number", 400);
    }
    updates.push(["target_hours", String(v)]);
  }

  // FTP / LTHR thresholds (ISC-134). A positive number sets the threshold;
  // an explicit null clears it (the row is deleted, so getSettings reports
  // null and the load engine degrades to a lower tier, ISC-144).
  const clears: string[] = [];
  for (const key of ["ftp_watts", "lthr_bpm"] as const) {
    if (key in body) {
      const v = body[key];
      if (v === null) {
        clears.push(key);
      } else if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        return jsonError(`${key} must be a positive integer or null`, 400);
      } else {
        updates.push([key, String(v)]);
      }
    }
  }

  if (updates.length === 0 && clears.length === 0) {
    return jsonError("No editable settings provided", 400);
  }

  const stmt = db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of updates) {
    stmt.run(key, value);
  }
  const del = db.query("DELETE FROM settings WHERE key = ?");
  for (const key of clears) {
    del.run(key);
  }

  return Response.json(getSettings());
}
