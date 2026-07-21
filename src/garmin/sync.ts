// Garmin sync engine: pulls recent activities, upserts by garmin_id with the
// field-level merge policy (ISC-27), records every attempt in sync_runs
// (ISC-4, ISC-28), and collapses concurrent triggers (ISC-31). This is the
// SINGLE implementation the "Sync now" HTTP route, the 6h scheduler, and the
// MCP trigger_sync tool (via the HTTP API) all call through — ISC-30.

import { db } from "../db";
import type { ActivityRow, SleepRow } from "../db";
import type { GarminClient, GarminActivity, GarminSleep } from "./types";
import { GarminSyncError } from "./types";
import { mapGarminTypeToSport } from "./mapping";
import { isGarminIdTombstoned } from "../metrics/duplicates";

export type SyncOutcome = {
  status: "success" | "error";
  activities_seen: number;
  activities_new: number;
  sleep_seen: number;
  sleep_new: number;
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
  // A Garmin id that was merged away as a duplicate loser is tombstoned
  // (ISC-315): skip it entirely so a re-sync cannot resurrect the row. This is
  // a READ of the tombstone set only. The merge itself is never called from
  // this path (ISC-314).
  if (isGarminIdTombstoned(activity.garminId)) {
    return { isNew: false, changed: false };
  }

  const existing = db
    .query("SELECT * FROM activities WHERE garmin_id = ?")
    .get(activity.garminId) as ActivityRow | null;

  const mappedSport = mapGarminTypeToSport(activity.typeKey);

  if (existing === null) {
    db.query(
      `INSERT INTO activities
         (source, garmin_id, sport, raw_type, start_time, duration_s, distance_m, calories, avg_hr, avg_power, norm_power, title, notes)
       VALUES ('garmin', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      activity.garminId,
      mappedSport,
      activity.typeKey,
      activity.startTimeUtc,
      activity.durationSeconds,
      activity.distanceMeters,
      activity.calories,
      activity.avgHr,
      activity.avgPower,
      activity.normPower,
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
    existing.avg_hr !== activity.avgHr ||
    existing.avg_power !== activity.avgPower ||
    existing.norm_power !== activity.normPower;

  if (!changed) {
    return { isNew: false, changed: false };
  }

  // Power (like duration/distance/calories/HR) is a Garmin-owned number, so it
  // always reflects the latest sync, never subject to the human-edit merge.
  db.query(
    `UPDATE activities SET
       sport = ?, raw_type = ?, start_time = ?, duration_s = ?, distance_m = ?,
       calories = ?, avg_hr = ?, avg_power = ?, norm_power = ?, title = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextSport,
    activity.typeKey,
    activity.startTimeUtc,
    activity.durationSeconds,
    activity.distanceMeters,
    activity.calories,
    activity.avgHr,
    activity.avgPower,
    activity.normPower,
    nextTitle,
    nowIso(),
    existing.id,
  );

  return { isNew: false, changed: true };
}

// Upsert a single night of sleep, keyed on calendar_date (UNIQUE). Sleep is
// entirely Garmin-owned — there is no human-edit merge like activities have —
// so a re-sync always writes Garmin's latest numbers, and updated_at is
// bumped only when a stored value actually changed (ISC-245: same night twice
// -> one row, updated_at bumped only on change). Returns whether the row was
// brand new.
function upsertSleep(sleep: GarminSleep): { isNew: boolean } {
  const existing = db
    .query("SELECT * FROM sleep WHERE calendar_date = ?")
    .get(sleep.calendarDate) as SleepRow | null;

  if (existing === null) {
    db.query(
      `INSERT INTO sleep
         (calendar_date, start_time, end_time, total_sleep_s, deep_s, light_s, rem_s, awake_s, score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sleep.calendarDate,
      sleep.startTimeUtc,
      sleep.endTimeUtc,
      sleep.totalSleepSeconds,
      sleep.deepSeconds,
      sleep.lightSeconds,
      sleep.remSeconds,
      sleep.awakeSeconds,
      sleep.score,
    );
    return { isNew: true };
  }

  const changed =
    existing.start_time !== sleep.startTimeUtc ||
    existing.end_time !== sleep.endTimeUtc ||
    existing.total_sleep_s !== sleep.totalSleepSeconds ||
    existing.deep_s !== sleep.deepSeconds ||
    existing.light_s !== sleep.lightSeconds ||
    existing.rem_s !== sleep.remSeconds ||
    existing.awake_s !== sleep.awakeSeconds ||
    existing.score !== sleep.score;

  if (!changed) return { isNew: false };

  db.query(
    `UPDATE sleep SET
       start_time = ?, end_time = ?, total_sleep_s = ?, deep_s = ?, light_s = ?,
       rem_s = ?, awake_s = ?, score = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    sleep.startTimeUtc,
    sleep.endTimeUtc,
    sleep.totalSleepSeconds,
    sleep.deepSeconds,
    sleep.lightSeconds,
    sleep.remSeconds,
    sleep.awakeSeconds,
    sleep.score,
    nowIso(),
    existing.id,
  );
  return { isNew: false };
}

// Pull recent sleep for the run and upsert it. Best-effort by design
// (ISC-247): a sleep failure must NOT fail an otherwise-successful activity
// sync, so this returns zero counts on error rather than throwing. Returns
// null-ish counts the caller records on the sync_run.
// Upper bound on the sleep fetch, independent of the SDK's own timeouts. A
// try/catch isolates a *thrown* sleep error, but a promise that hangs forever
// would still stall runSyncOnce; racing a timeout guarantees the run always
// completes and records its activity result (advisor pass, ISC-247).
const SLEEP_FETCH_TIMEOUT_MS = 30_000;

async function syncSleep(client: GarminClient): Promise<{ seen: number; new: number }> {
  if (client.listRecentSleep === undefined) return { seen: 0, new: 0 };
  try {
    const nights = await Promise.race([
      client.listRecentSleep(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new GarminSyncError("sleep fetch timed out")), SLEEP_FETCH_TIMEOUT_MS).unref(),
      ),
    ]);
    let newCount = 0;
    for (const night of nights) {
      if (upsertSleep(night).isNew) newCount += 1;
    }
    return { seen: nights.length, new: newCount };
  } catch {
    // Swallow: activities have already committed; sleep is context, not the
    // point of the sync. The next run retries.
    return { seen: 0, new: 0 };
  }
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

    // Sleep rides in the same run (one Garmin session), but never breaks it.
    const sleep = await syncSleep(client);

    db.query(
      "UPDATE sync_runs SET finished_at = ?, status = 'success', activities_seen = ?, activities_new = ?, sleep_seen = ?, sleep_new = ? WHERE id = ?",
    ).run(nowIso(), activities.length, newCount, sleep.seen, sleep.new, runId);

    return {
      status: "success",
      activities_seen: activities.length,
      activities_new: newCount,
      sleep_seen: sleep.seen,
      sleep_new: sleep.new,
      error: null,
    };
  } catch (err) {
    const message =
      err instanceof GarminSyncError || err instanceof Error ? err.message : String(err);
    db.query(
      "UPDATE sync_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?",
    ).run(nowIso(), message, runId);

    return { status: "error", activities_seen: 0, activities_new: 0, sleep_seen: 0, sleep_new: 0, error: message };
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

// Recent nights of sleep, newest first, for GET /api/sleep (ISC-250).
export function getRecentSleep(limit = 14): SleepRow[] {
  return db
    .query("SELECT * FROM sleep ORDER BY calendar_date DESC LIMIT ?")
    .all(limit) as SleepRow[];
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
