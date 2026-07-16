// Garmin sync engine: pulls recent activities, upserts by garmin_id with the
// field-level merge policy (ISC-27), records every attempt in sync_runs
// (ISC-4, ISC-28), and collapses concurrent triggers (ISC-31). This is the
// SINGLE implementation the "Sync now" HTTP route, the 6h scheduler, and the
// MCP trigger_sync tool (via the HTTP API) all call through — ISC-30.

import { db } from "../db";
import type { ActivityRow } from "../db";
import type { GarminClient, GarminActivity } from "./types";
import { GarminSyncError } from "./types";
import { mapGarminTypeToSport } from "./mapping";

export type SyncOutcome = {
  status: "success" | "error";
  activities_seen: number;
  activities_new: number;
  error: string | null;
};

// In-process mutex. A single Bun server process is the entire deployment
// (ISC-103: exactly one resident process), so a module-level boolean is
// sufficient — no cross-process lock is needed.
let syncInProgress = false;

function nowIso(): string {
  return new Date().toISOString();
}

// Upsert a single Garmin activity. Returns whether it was a brand-new row
// and whether any stored field actually changed (so the caller can decide
// whether to bump updated_at — ISC-26: "same activity twice -> one row,
// updated_at bumped only on change").
function upsertActivity(activity: GarminActivity): { isNew: boolean; changed: boolean } {
  const existing = db
    .query("SELECT * FROM activities WHERE garmin_id = ?")
    .get(activity.garminId) as ActivityRow | null;

  const mappedSport = mapGarminTypeToSport(activity.typeKey);

  if (existing === null) {
    db.query(
      `INSERT INTO activities
         (source, garmin_id, sport, raw_type, start_time, duration_s, distance_m, calories, avg_hr, title, notes)
       VALUES ('garmin', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      activity.garminId,
      mappedSport,
      activity.typeKey,
      activity.startTimeUtc,
      activity.durationSeconds,
      activity.distanceMeters,
      activity.calories,
      activity.avgHr,
      activity.title,
    );
    return { isNew: true, changed: true };
  }

  // Field-level merge (ISC-27): sport/title are only overwritten by Garmin
  // if the human has not edited them; duration/distance/calories/avg_hr and
  // start_time always reflect the latest Garmin numbers ("duration/distance
  // from Garmin win"). notes is a Cadence-only field Garmin never supplies,
  // so it is never touched here regardless of notes_edited.
  const nextSport = existing.sport_edited === 1 ? existing.sport : mappedSport;
  const nextTitle = existing.title_edited === 1 ? existing.title : activity.title;

  const changed =
    nextSport !== existing.sport ||
    nextTitle !== existing.title ||
    existing.raw_type !== activity.typeKey ||
    existing.start_time !== activity.startTimeUtc ||
    existing.duration_s !== activity.durationSeconds ||
    existing.distance_m !== activity.distanceMeters ||
    existing.calories !== activity.calories ||
    existing.avg_hr !== activity.avgHr;

  if (!changed) {
    return { isNew: false, changed: false };
  }

  db.query(
    `UPDATE activities SET
       sport = ?, raw_type = ?, start_time = ?, duration_s = ?, distance_m = ?,
       calories = ?, avg_hr = ?, title = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextSport,
    activity.typeKey,
    activity.startTimeUtc,
    activity.durationSeconds,
    activity.distanceMeters,
    activity.calories,
    activity.avgHr,
    nextTitle,
    nowIso(),
    existing.id,
  );

  return { isNew: false, changed: true };
}

// Runs one sync attempt against the given client and records the result in
// sync_runs, whether it succeeds or fails (ISC-28: a sync failure must never
// crash the server, and must leave a queryable record).
export async function runSyncOnce(client: GarminClient): Promise<SyncOutcome> {
  const startedAt = nowIso();
  const runId = (
    db
      .query(
        "INSERT INTO sync_runs (started_at, status) VALUES (?, 'running') RETURNING id",
      )
      .get(startedAt) as { id: number }
  ).id;

  try {
    const activities = await client.listRecentActivities();
    let newCount = 0;
    for (const activity of activities) {
      const { isNew } = upsertActivity(activity);
      if (isNew) newCount += 1;
    }

    db.query(
      "UPDATE sync_runs SET finished_at = ?, status = 'success', activities_seen = ?, activities_new = ? WHERE id = ?",
    ).run(nowIso(), activities.length, newCount, runId);

    return { status: "success", activities_seen: activities.length, activities_new: newCount, error: null };
  } catch (err) {
    const message =
      err instanceof GarminSyncError || err instanceof Error ? err.message : String(err);
    db.query(
      "UPDATE sync_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?",
    ).run(nowIso(), message, runId);

    return { status: "error", activities_seen: 0, activities_new: 0, error: message };
  }
}

export type TriggerResult =
  | { triggered: true; outcome: SyncOutcome }
  | { triggered: false; message: "already running" };

// The single entry point "Sync now", the scheduler, and (via the API) the
// MCP trigger_sync tool all call. Concurrent calls while a sync is already
// running collapse into an immediate "already running" response rather than
// starting a second overlapping sync (ISC-31).
export async function triggerSync(client: GarminClient): Promise<TriggerResult> {
  if (syncInProgress) {
    return { triggered: false, message: "already running" };
  }
  syncInProgress = true;
  try {
    const outcome = await runSyncOnce(client);
    return { triggered: true, outcome };
  } finally {
    syncInProgress = false;
  }
}

// Exposed for tests only, to reset the mutex between test cases that
// deliberately simulate an in-flight sync.
export function _resetSyncState(): void {
  syncInProgress = false;
}

export function isSyncInProgress(): boolean {
  return syncInProgress;
}

// Recent sync history for GET /api/sync/status.
export function getRecentSyncRuns(limit = 10) {
  return db
    .query("SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?")
    .all(limit);
}

const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000; // ISC-30: every 6h

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

// Starts the in-process 6h scheduler (ISC-30, ISC-103: no external
// cron/worker — this IS the recurring mechanism, inside the one resident
// process). `getClient` is a factory rather than a client instance so the
// scheduler always authenticates fresh/reuses the latest saved session
// rather than closing over a stale client.
export function startScheduler(getClient: () => GarminClient): void {
  if (schedulerHandle !== null) return; // idempotent
  schedulerHandle = setInterval(() => {
    void triggerSync(getClient());
  }, SCHEDULE_INTERVAL_MS);
  // Don't keep the process alive solely for this timer's sake in odd
  // shutdown scenarios (Bun handles this gracefully either way, but being
  // explicit is cheap).
  if (typeof schedulerHandle.unref === "function") schedulerHandle.unref();
}

export function stopScheduler(): void {
  if (schedulerHandle !== null) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}
