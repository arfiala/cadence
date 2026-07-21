// GET /api/settings + PATCH /api/settings (ISC-42) — the weekly G1 targets
// (sessions, hours), editable without a redeploy (ISC-3).

import { db } from "../db";
import { jsonError, readJsonBody } from "../lib/http";
import { getSettings } from "../services/weekSummary";

// Nutrition targets live in the same settings table but are read directly here
// (not via getSettings, which stays in weekSummary.ts and must carry zero
// nutrition references, ISC-214). Defaults mirror the migration seed (ISC-191).
const DEFAULT_NUTRITION_TARGET_KCAL = 2200;
const DEFAULT_NUTRITION_TARGET_PROTEIN_G = 150;

function nutritionTargets(): { nutrition_target_kcal: number; nutrition_target_protein_g: number } {
  const rows = db
    .query(
      "SELECT key, value FROM settings WHERE key IN ('nutrition_target_kcal','nutrition_target_protein_g')",
    )
    .all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const kcal = Number(map.get("nutrition_target_kcal") ?? String(DEFAULT_NUTRITION_TARGET_KCAL));
  const protein = Number(
    map.get("nutrition_target_protein_g") ?? String(DEFAULT_NUTRITION_TARGET_PROTEIN_G),
  );
  return {
    nutrition_target_kcal: Number.isFinite(kcal) ? kcal : DEFAULT_NUTRITION_TARGET_KCAL,
    nutrition_target_protein_g: Number.isFinite(protein)
      ? protein
      : DEFAULT_NUTRITION_TARGET_PROTEIN_G,
  };
}

// Race target (ISC-332): a race name and ISO date the user is training toward.
// Both nullable and stored as ordinary settings rows (absent === unset), read
// here directly rather than through getSettings (which stays the load-engine
// shape). Clearing a value deletes the row so it reads back as null.
export function raceTarget(): { race_name: string | null; race_date: string | null } {
  const rows = db
    .query("SELECT key, value FROM settings WHERE key IN ('race_name','race_date')")
    .all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    race_name: map.get("race_name") ?? null,
    race_date: map.get("race_date") ?? null,
  };
}

// A calendar date in YYYY-MM-DD form that is also a real date (ISC-333). Rejects
// junk like "2026-13-40" that a bare regex would pass but Date normalizes away.
function isValidIsoDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  // Round-trip guard: reject dates the Date constructor silently rolled over.
  return d.toISOString().slice(0, 10) === value;
}

export function getSettingsRoute(): Response {
  return Response.json({ ...getSettings(), ...nutritionTargets(), ...raceTarget() });
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

  // Nutrition targets (ISC-191): kcal a positive integer, protein a positive
  // number of grams. Editable here without a redeploy, same as the G1 targets.
  if ("nutrition_target_kcal" in body) {
    const v = body.nutrition_target_kcal;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return jsonError("nutrition_target_kcal must be a positive integer", 400);
    }
    updates.push(["nutrition_target_kcal", String(v)]);
  }
  if ("nutrition_target_protein_g" in body) {
    const v = body.nutrition_target_protein_g;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return jsonError("nutrition_target_protein_g must be a positive number", 400);
    }
    updates.push(["nutrition_target_protein_g", String(v)]);
  }

  // Race target (ISC-332, ISC-333). race_name: a non-empty string or null to
  // clear. race_date: a valid YYYY-MM-DD or null to clear.
  if ("race_name" in body) {
    const v = body.race_name;
    if (v === null || (typeof v === "string" && v.trim().length === 0)) {
      clears.push("race_name");
    } else if (typeof v !== "string") {
      return jsonError("race_name must be a string or null", 400);
    } else {
      updates.push(["race_name", v]);
    }
  }
  if ("race_date" in body) {
    const v = body.race_date;
    if (v === null) {
      clears.push("race_date");
    } else if (!isValidIsoDateOnly(v)) {
      return jsonError("race_date must be a valid ISO date (YYYY-MM-DD) or null", 400);
    } else {
      updates.push(["race_date", v]);
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

  return Response.json({ ...getSettings(), ...nutritionTargets(), ...raceTarget() });
}
