// Duplicate-activity detection and merge (ISC-306..317). A pure detector plus
// the dismissal/tombstone/merge persistence around it. This module is ONLY
// ever driven on demand by the /api/duplicates routes. Nothing in the Garmin
// sync path or the scheduler ever calls findDuplicateCandidates or mergePair
// (ISC-314, ISC-317). The sync path only ever READS the tombstone set, to
// avoid resurrecting a merged-away Garmin id (ISC-315).
//
// Heuristic (ISC-306), documented here as the single source of truth. Two
// activities A and B are flagged as a duplicate candidate when ALL of:
//   1. Same New York calendar day (nyDateString(startA) === nyDateString(startB)).
//   2. Their time ranges overlap: startA < endB AND startB < endA, where
//      end = start + duration. Strict inequality, so two genuinely
//      back-to-back sessions (B starts exactly when A ends) do NOT overlap and
//      are never flagged (ISC-307).
//   3. Their durations are similar, meaning EITHER within 5 minutes
//      (abs diff <= 300 s) OR within 20 percent (abs diff <= 0.20 * the longer
//      duration). Either condition qualifies.
// Cross-source pairs (a Garmin/Zwift row versus a manual row) are the most
// likely real duplicates, so candidates are ordered cross-source first
// (ISC-306, "distinct sources preferred"); same-source pairs still surface,
// just after them.

import { db } from "../db";
import type { ActivityRow } from "../db";
import { nyDateString } from "../week";

const FIVE_MINUTES_S = 300;
const DURATION_TOLERANCE = 0.2; // 20 percent

export type DuplicateCandidate = {
  aId: number; // the lower activity id (stable key, min)
  bId: number; // the higher activity id (stable key, max)
  crossSource: boolean; // true when the two rows come from different sources
};

function startMs(row: ActivityRow): number {
  return new Date(row.start_time).getTime();
}

function endMs(row: ActivityRow): number {
  return startMs(row) + row.duration_s * 1000;
}

function overlaps(a: ActivityRow, b: ActivityRow): boolean {
  return startMs(a) < endMs(b) && startMs(b) < endMs(a);
}

function durationsSimilar(a: ActivityRow, b: ActivityRow): boolean {
  const diff = Math.abs(a.duration_s - b.duration_s);
  if (diff <= FIVE_MINUTES_S) return true;
  const longer = Math.max(a.duration_s, b.duration_s);
  return longer > 0 && diff <= DURATION_TOLERANCE * longer;
}

function sameNyDay(a: ActivityRow, b: ActivityRow): boolean {
  return nyDateString(new Date(a.start_time)) === nyDateString(new Date(b.start_time));
}

// Pure detector over a set of activity rows. No DB access, no side effects.
// Returns candidate pairs with the lower id first, cross-source pairs ordered
// ahead of same-source ones.
export function findDuplicateCandidates(rows: ActivityRow[]): DuplicateCandidate[] {
  const out: DuplicateCandidate[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i] as ActivityRow;
      const b = rows[j] as ActivityRow;
      if (!sameNyDay(a, b)) continue;
      if (!overlaps(a, b)) continue;
      if (!durationsSimilar(a, b)) continue;
      const lowFirst = a.id < b.id;
      out.push({
        aId: lowFirst ? a.id : b.id,
        bId: lowFirst ? b.id : a.id,
        crossSource: a.source !== b.source,
      });
    }
  }
  // Cross-source candidates first (most likely real duplicates), then by id.
  out.sort((x, y) => {
    if (x.crossSource !== y.crossSource) return x.crossSource ? -1 : 1;
    if (x.aId !== y.aId) return x.aId - y.aId;
    return x.bId - y.bId;
  });
  return out;
}

// --- Persistence around the detector -----------------------------------

function allActivities(): ActivityRow[] {
  return db.query("SELECT * FROM activities ORDER BY start_time ASC").all() as ActivityRow[];
}

// Normalize a pair to (min,max) so a dismissal is stable regardless of which
// order the two ids arrive in.
function orderPair(aId: number, bId: number): { lo: number; hi: number } {
  return aId <= bId ? { lo: aId, hi: bId } : { lo: bId, hi: aId };
}

export function isDismissed(aId: number, bId: number): boolean {
  const { lo, hi } = orderPair(aId, bId);
  const row = db
    .query("SELECT 1 AS present FROM duplicate_dismissals WHERE a_id = ? AND b_id = ?")
    .get(lo, hi) as { present: number } | null;
  return row !== null;
}

export function dismissPair(aId: number, bId: number): void {
  const { lo, hi } = orderPair(aId, bId);
  db.query(
    "INSERT OR IGNORE INTO duplicate_dismissals (a_id, b_id) VALUES (?, ?)",
  ).run(lo, hi);
}

export function undismissPair(aId: number, bId: number): void {
  const { lo, hi } = orderPair(aId, bId);
  db.query("DELETE FROM duplicate_dismissals WHERE a_id = ? AND b_id = ?").run(lo, hi);
}

export function listDismissedPairs(): { a_id: number; b_id: number }[] {
  return db
    .query("SELECT a_id, b_id FROM duplicate_dismissals ORDER BY a_id, b_id")
    .all() as { a_id: number; b_id: number }[];
}

// Live candidates from the current activities table with dismissed pairs
// excluded. This is the ONLY caller of findDuplicateCandidates in production,
// invoked from the GET /api/duplicates route (ISC-317).
export function currentCandidates(): DuplicateCandidate[] {
  return findDuplicateCandidates(allActivities()).filter(
    (c) => !isDismissed(c.aId, c.bId),
  );
}

// --- Garmin tombstone (ISC-315) ----------------------------------------

export function isGarminIdTombstoned(garminId: string): boolean {
  const row = db
    .query("SELECT 1 AS present FROM merged_garmin_ids WHERE garmin_id = ?")
    .get(garminId) as { present: number } | null;
  return row !== null;
}

function tombstoneGarminId(garminId: string): void {
  db.query("INSERT OR IGNORE INTO merged_garmin_ids (garmin_id) VALUES (?)").run(garminId);
}

export type MergeResult =
  | { ok: true; keptId: number; deletedId: number }
  | { ok: false; error: string };

// Merge a duplicate pair by keeping one row exactly as it is (including every
// user edit: notes/title/sport/rpe are never blended, ISC-313) and deleting
// the loser. If the loser is Garmin-sourced, its garmin id is tombstoned so a
// later re-sync cannot resurrect it (ISC-315). Both ids are explicit and must
// differ (ISC-312). There is no implicit "pick the richer one" here; the
// caller (the human, via the UI) chooses which to keep.
export function mergePair(keepId: number, deleteId: number): MergeResult {
  if (keepId === deleteId) {
    return { ok: false, error: "keepId and deleteId must be different activities" };
  }
  const keep = db.query("SELECT * FROM activities WHERE id = ?").get(keepId) as ActivityRow | null;
  const loser = db.query("SELECT * FROM activities WHERE id = ?").get(deleteId) as ActivityRow | null;
  if (keep === null) return { ok: false, error: `Activity ${keepId} not found` };
  if (loser === null) return { ok: false, error: `Activity ${deleteId} not found` };

  // Tombstone the loser's Garmin id BEFORE deleting the row, so a concurrent or
  // subsequent sync cannot re-insert it.
  if (loser.garmin_id !== null) tombstoneGarminId(loser.garmin_id);

  // Delete only the loser; the kept row is left completely untouched.
  db.query("DELETE FROM activities WHERE id = ?").run(deleteId);
  // Any dismissal that referenced the now-deleted pair is moot; drop it so it
  // does not linger as a stale dismissed entry.
  const { lo, hi } = orderPair(keepId, deleteId);
  db.query("DELETE FROM duplicate_dismissals WHERE a_id = ? AND b_id = ?").run(lo, hi);

  return { ok: true, keptId: keepId, deletedId: deleteId };
}
