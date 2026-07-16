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

  if (updates.length === 0) {
    return jsonError("No editable settings provided", 400);
  }

  const stmt = db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  for (const [key, value] of updates) {
    stmt.run(key, value);
  }

  return Response.json(getSettings());
}
