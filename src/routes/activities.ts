// /api/activities: manual CRUD over the activities table (ISC-36..39).
// Garmin-sourced rows are editable too, but sport/title/notes edits set a
// per-field "edited" flag (ISC-27's field-level merge policy, enforced here
// on write and honored by src/garmin/sync.ts on the next sync) while
// duration/distance/calories/avg_hr always reflect whatever was last written
// — Garmin's re-sync is the one place those get overwritten again, by
// design (Garmin owns the numbers, the human owns the labels).

import { db, isValidSport } from "../db";
import type { ActivityRow, Source } from "../db";
import { jsonError, readJsonBody } from "../lib/http";

function serializeActivity(row: ActivityRow) {
  return {
    id: row.id,
    source: row.source,
    garmin_id: row.garmin_id,
    sport: row.sport,
    raw_type: row.raw_type,
    start_time: row.start_time,
    duration_s: row.duration_s,
    distance_m: row.distance_m,
    calories: row.calories,
    avg_hr: row.avg_hr,
    title: row.title,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms);
}

// GET /api/activities?from=&to=&sport=&limit= — filtered, newest-first
// (ISC-36). `from`/`to` are ISO instants (inclusive/exclusive on start_time);
// `sport` filters to one vocab value; `limit` defaults to 100, capped at 500.
export function listActivities(url: URL): Response {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const sport = url.searchParams.get("sport");
  const limitParam = url.searchParams.get("limit");

  if (from !== null && !isValidIsoDate(from)) {
    return jsonError("Invalid 'from' date", 400);
  }
  if (to !== null && !isValidIsoDate(to)) {
    return jsonError("Invalid 'to' date", 400);
  }
  if (sport !== null && !isValidSport(sport)) {
    return jsonError("Invalid 'sport'", 400);
  }

  let limit = 100;
  if (limitParam !== null) {
    const parsed = Number(limitParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return jsonError("Invalid 'limit'", 400);
    }
    limit = Math.min(parsed, 500);
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (from !== null) {
    conditions.push("start_time >= ?");
    params.push(new Date(from).toISOString());
  }
  if (to !== null) {
    conditions.push("start_time < ?");
    params.push(new Date(to).toISOString());
  }
  if (sport !== null) {
    conditions.push("sport = ?");
    params.push(sport);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = db
    .query(`SELECT * FROM activities ${where} ORDER BY start_time DESC LIMIT ?`)
    .all(...params) as ActivityRow[];

  return Response.json({ activities: rows.map(serializeActivity) });
}

type CreateActivityInput = {
  sport: string;
  start_time: string;
  duration_s: number;
  distance_m?: number | null;
  calories?: number | null;
  avg_hr?: number | null;
  title?: string | null;
  notes?: string | null;
};

function validateCreateBody(
  body: Record<string, unknown>,
): { ok: true; value: CreateActivityInput } | { ok: false; error: string } {
  if (!isValidSport(body.sport)) {
    return { ok: false, error: "sport must be one of the supported activity types" };
  }
  if (!isValidIsoDate(body.start_time)) {
    return { ok: false, error: "start_time must be a valid ISO-8601 date" };
  }
  const duration = body.duration_s;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return { ok: false, error: "duration_s must be a positive number" };
  }
  const distance = body.distance_m;
  if (distance !== undefined && distance !== null) {
    if (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) {
      return { ok: false, error: "distance_m must be a non-negative number" };
    }
  }
  const title = body.title;
  if (title !== undefined && title !== null && typeof title !== "string") {
    return { ok: false, error: "title must be a string" };
  }
  const notes = body.notes;
  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    return { ok: false, error: "notes must be a string" };
  }
  return {
    ok: true,
    value: {
      sport: body.sport,
      start_time: new Date(body.start_time as string).toISOString(),
      duration_s: duration,
      distance_m: (distance as number | null | undefined) ?? null,
      calories: null,
      avg_hr: null,
      title: (title as string | null | undefined) ?? null,
      notes: (notes as string | null | undefined) ?? null,
    },
  };
}

// POST /api/activities — manual entry (ISC-37).
export async function createActivity(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);

  const validated = validateCreateBody(body);
  if (!validated.ok) return jsonError(validated.error, 400);
  const input = validated.value;

  const source: Source = "manual";
  const row = db
    .query(
      `INSERT INTO activities (source, sport, start_time, duration_s, distance_m, calories, avg_hr, title, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      source,
      input.sport,
      input.start_time,
      input.duration_s,
      input.distance_m ?? null,
      input.calories ?? null,
      input.avg_hr ?? null,
      input.title ?? null,
      input.notes ?? null,
    ) as ActivityRow;

  return Response.json({ activity: serializeActivity(row) }, { status: 201 });
}

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// PATCH /api/activities/:id — partial edit (ISC-38). sport/title/notes edits
// on a Garmin-sourced row set the corresponding *_edited flag so a later
// sync never overwrites the human's correction (ISC-27).
export async function updateActivity(req: Request, idParam: string): Promise<Response> {
  const id = parseId(idParam);
  if (id === null) return jsonError("Invalid activity id", 400);

  const existing = db.query("SELECT * FROM activities WHERE id = ?").get(id) as
    | ActivityRow
    | null;
  if (existing === null) return jsonError("Activity not found", 404);

  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if ("sport" in body) {
    if (!isValidSport(body.sport)) return jsonError("Invalid sport", 400);
    sets.push("sport = ?", "sport_edited = 1");
    params.push(body.sport);
  }
  if ("title" in body) {
    if (body.title !== null && typeof body.title !== "string") {
      return jsonError("title must be a string or null", 400);
    }
    sets.push("title = ?", "title_edited = 1");
    params.push(body.title as string | null);
  }
  if ("notes" in body) {
    if (body.notes !== null && typeof body.notes !== "string") {
      return jsonError("notes must be a string or null", 400);
    }
    sets.push("notes = ?", "notes_edited = 1");
    params.push(body.notes as string | null);
  }
  if ("start_time" in body) {
    if (!isValidIsoDate(body.start_time)) return jsonError("Invalid start_time", 400);
    sets.push("start_time = ?");
    params.push(new Date(body.start_time as string).toISOString());
  }
  if ("duration_s" in body) {
    const d = body.duration_s;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) {
      return jsonError("duration_s must be a positive number", 400);
    }
    sets.push("duration_s = ?");
    params.push(d);
  }
  if ("distance_m" in body) {
    const d = body.distance_m;
    if (d !== null && (typeof d !== "number" || !Number.isFinite(d) || d < 0)) {
      return jsonError("distance_m must be a non-negative number or null", 400);
    }
    sets.push("distance_m = ?");
    params.push(d as number | null);
  }

  if (sets.length === 0) return jsonError("No editable fields provided", 400);

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  params.push(id);

  const row = db
    .query(`UPDATE activities SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .get(...params) as ActivityRow;

  return Response.json({ activity: serializeActivity(row) });
}

// DELETE /api/activities/:id — manual rows delete freely; Garmin rows
// require ?confirm=true (ISC-39), since a bare delete would silently be
// re-created by the next sync anyway and the confirm step makes that clear.
export function deleteActivity(url: URL, idParam: string): Response {
  const id = parseId(idParam);
  if (id === null) return jsonError("Invalid activity id", 400);

  const existing = db.query("SELECT * FROM activities WHERE id = ?").get(id) as
    | ActivityRow
    | null;
  if (existing === null) return jsonError("Activity not found", 404);

  if (existing.source === "garmin" && url.searchParams.get("confirm") !== "true") {
    return jsonError(
      "Deleting a Garmin-sourced activity requires ?confirm=true (it will reappear on the next sync unless Garmin also deletes it).",
      400,
    );
  }

  db.query("DELETE FROM activities WHERE id = ?").run(id);
  return Response.json({ message: "Activity deleted." });
}
