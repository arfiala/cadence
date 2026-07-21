// ZwiftPower sync engine: pulls the rider's results, upserts by event_id with
// idempotency (ISC-122), records every attempt in zwiftpower_sync_runs
// (ISC-124), and collapses concurrent triggers. Mirrors src/garmin/sync.ts.
// This engine NEVER writes to the activities table (ISC-128), race results
// are their own thing, not training activities. It is the single
// implementation the manual "sync ZwiftPower" route and the scheduler both
// call through.

import { db } from "../db";
import type { ZwiftPowerResultRow } from "../db";
import type { ZwiftPowerClient, ZwiftPowerResult } from "./types";
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
