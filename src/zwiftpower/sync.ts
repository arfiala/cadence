// ZwiftPower sync engine: pulls the rider's results, upserts by event_id with
// idempotency (ISC-122), records every attempt in zwiftpower_sync_runs
// (ISC-124), and collapses concurrent triggers. Mirrors src/garmin/sync.ts.
// This engine NEVER writes to the activities table (ISC-128), race results
// are their own thing, not training activities. It is the single
// implementation the manual "sync ZwiftPower" route and the scheduler both
// call through.

import { db } from "../db";
import type { ZwiftPowerResultRow } from "../db";
import type { ZwiftPowerClient, ZwiftPowerResult, ZwiftPowerCurvePoint } from "./types";
import { ZwiftPowerSyncError } from "./types";

export type ZpSyncOutcome = {
  status: "success" | "error";
  results_seen: number;
  results_new: number;
  error: string | null;
};

// In-process mutex, same rationale as Garmin's: one resident process is the
// whole deployment, so a module-level boolean suffices (ISC-103).
let zpSyncInProgress = false;

function nowIso(): string {
  return new Date().toISOString();
}

// Upsert a single result keyed on event_id. Returns whether the row was new
// and whether any stored field actually changed (so updated_at is bumped only
// on change). Idempotent: the same result twice yields one row (ISC-122).
function upsertResult(result: ZwiftPowerResult): { isNew: boolean; changed: boolean } {
  const existing = db
    .query("SELECT * FROM zwiftpower_results WHERE event_id = ?")
    .get(result.eventId) as ZwiftPowerResultRow | null;

  if (existing === null) {
    db.query(
      `INSERT INTO zwiftpower_results
         (event_id, event_date, title, category, position, avg_power, norm_power, time_s, weight_kg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      result.eventId,
      result.eventDate,
      result.title,
      result.category,
      result.position,
      result.avgPower,
      result.normPower,
      result.timeSeconds,
      result.weightKg,
    );
    return { isNew: true, changed: true };
  }

  const changed =
    existing.event_date !== result.eventDate ||
    existing.title !== result.title ||
    existing.category !== result.category ||
    existing.position !== result.position ||
    existing.avg_power !== result.avgPower ||
    existing.norm_power !== result.normPower ||
    existing.time_s !== result.timeSeconds ||
    existing.weight_kg !== result.weightKg;

  if (!changed) return { isNew: false, changed: false };

  db.query(
    `UPDATE zwiftpower_results SET
       event_date = ?, title = ?, category = ?, position = ?,
       avg_power = ?, norm_power = ?, time_s = ?, weight_kg = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    result.eventDate,
    result.title,
    result.category,
    result.position,
    result.avgPower,
    result.normPower,
    result.timeSeconds,
    result.weightKg,
    nowIso(),
    existing.id,
  );

  return { isNew: false, changed: true };
}

// Upsert a critical-power best effort, keyed on (duration_s, event_date) so a
// repeated fetch of the same effort is idempotent, keeping the higher watts on
// conflict. event_date falls back to the fetch instant when the profile omits
// it, so the NOT NULL column and the read-time 90-day filter always have a
// value to work with.
function upsertPowerCurvePoint(point: ZwiftPowerCurvePoint): void {
  const eventDate = point.eventDate ?? nowIso();
  db.query(
    `INSERT INTO power_curve_efforts (duration_s, watts, event_date, event_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(duration_s, event_date) DO UPDATE SET
       watts = MAX(power_curve_efforts.watts, excluded.watts),
       event_id = excluded.event_id,
       fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(point.durationSeconds, point.watts, eventDate, point.eventId);
}

// Best-effort power-curve fetch (ISC-342, ISC-344): part of the same sync, but
// a failure NEVER fails the results sync and NEVER crashes the server. The
// read endpoint simply degrades to whatever is already stored. Returns the
// number of points stored (0 on absence or failure).
async function syncPowerCurve(client: ZwiftPowerClient): Promise<number> {
  if (client.getPowerCurve === undefined) return 0;
  try {
    const points = await client.getPowerCurve();
    for (const point of points) upsertPowerCurvePoint(point);
    return points.length;
  } catch {
    return 0;
  }
}

// Runs one sync attempt and records the result whether it succeeds or fails
// (ISC-124: a failure must never crash the server and must leave a queryable
// record).
export async function runZpSyncOnce(client: ZwiftPowerClient): Promise<ZpSyncOutcome> {
  const startedAt = nowIso();
  const runId = (
    db
      .query(
        "INSERT INTO zwiftpower_sync_runs (started_at, status) VALUES (?, 'running') RETURNING id",
      )
      .get(startedAt) as { id: number }
  ).id;

  try {
    const results = await client.listRiderResults();
    let newCount = 0;
    for (const result of results) {
      const { isNew } = upsertResult(result);
      if (isNew) newCount += 1;
    }

    // Power curve rides along in the same session, never breaking the run.
    await syncPowerCurve(client);

    // FTP auto-sync rides along too: mirror Zwift's FTP estimate when it
    // changes (recalibrates zones + future plan targets). Best-effort.
    try {
      const { syncFtpFromZwift } = await import("../services/ftpSync");
      await syncFtpFromZwift(client);
    } catch {
      // never break the results sync over a recalibration hiccup
    }

    db.query(
      "UPDATE zwiftpower_sync_runs SET finished_at = ?, status = 'success', results_seen = ?, results_new = ? WHERE id = ?",
    ).run(nowIso(), results.length, newCount, runId);

    return { status: "success", results_seen: results.length, results_new: newCount, error: null };
  } catch (err) {
    const message =
      err instanceof ZwiftPowerSyncError || err instanceof Error ? err.message : String(err);
    db.query(
      "UPDATE zwiftpower_sync_runs SET finished_at = ?, status = 'error', error = ? WHERE id = ?",
    ).run(nowIso(), message, runId);

    return { status: "error", results_seen: 0, results_new: 0, error: message };
  }
}

export type ZpTriggerResult =
  | { triggered: true; outcome: ZpSyncOutcome }
  | { triggered: false; message: "already running" };

// Concurrent triggers collapse into an immediate "already running" rather than
// starting a second overlapping sync.
export async function triggerZpSync(client: ZwiftPowerClient): Promise<ZpTriggerResult> {
  if (zpSyncInProgress) {
    return { triggered: false, message: "already running" };
  }
  zpSyncInProgress = true;
  try {
    const outcome = await runZpSyncOnce(client);
    return { triggered: true, outcome };
  } finally {
    zpSyncInProgress = false;
  }
}

// Test-only mutex reset.
export function _resetZpSyncState(): void {
  zpSyncInProgress = false;
}

export function listResults(limit = 100): ZwiftPowerResultRow[] {
  return db
    .query(
      "SELECT * FROM zwiftpower_results ORDER BY (event_date IS NULL), event_date DESC, id DESC LIMIT ?",
    )
    .all(limit) as ZwiftPowerResultRow[];
}

export function getRecentZpRuns(limit = 10) {
  return db
    .query("SELECT * FROM zwiftpower_sync_runs ORDER BY id DESC LIMIT ?")
    .all(limit);
}

const ZP_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h, like Garmin

let zpSchedulerHandle: ReturnType<typeof setInterval> | null = null;

// Starts the in-process 6h ZwiftPower scheduler. The caller (server.ts) MUST
// only invoke this when ZwiftPower is configured (ISC-131), with the env
// unset the feature stays fully dormant and no timer is ever registered.
export function startZpScheduler(getClient: () => ZwiftPowerClient): void {
  if (zpSchedulerHandle !== null) return; // idempotent
  zpSchedulerHandle = setInterval(() => {
    void triggerZpSync(getClient());
  }, ZP_SCHEDULE_INTERVAL_MS);
  if (typeof zpSchedulerHandle.unref === "function") zpSchedulerHandle.unref();
}

export function stopZpScheduler(): void {
  if (zpSchedulerHandle !== null) {
    clearInterval(zpSchedulerHandle);
    zpSchedulerHandle = null;
  }
}
