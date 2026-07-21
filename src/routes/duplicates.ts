// /api/duplicates: on-demand duplicate review (ISC-310..312, ISC-317). All
// routes sit under /api/ so they are already auth-gated (ISC-346). The scan is
// only ever run here, never inside the Garmin sync or the scheduler (ISC-317).

import { db } from "../db";
import type { ActivityRow } from "../db";
import { jsonError, readJsonBody } from "../lib/http";
import {
  currentCandidates,
  dismissPair,
  undismissPair,
  listDismissedPairs,
  mergePair,
} from "../metrics/duplicates";

// A compact summary of an activity for the side-by-side duplicate view.
function summarize(row: ActivityRow) {
  return {
    id: row.id,
    source: row.source,
    garmin_id: row.garmin_id,
    sport: row.sport,
    start_time: row.start_time,
    duration_s: row.duration_s,
    distance_m: row.distance_m,
    avg_hr: row.avg_hr,
    avg_power: row.avg_power,
    title: row.title,
    notes: row.notes,
    rpe: row.rpe,
  };
}

function activityById(id: number): ActivityRow | null {
  return db.query("SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | null;
}

// GET /api/duplicates returns current candidate pairs (dismissed pairs excluded),
// each with both activities' summaries, plus the list of dismissed pairs so the
// UI can offer an undismiss (advisor, ISC-310).
export function getDuplicates(): Response {
  const candidates = currentCandidates()
    .map((c) => {
      const a = activityById(c.aId);
      const b = activityById(c.bId);
      if (a === null || b === null) return null;
      return { a_id: c.aId, b_id: c.bId, cross_source: c.crossSource, a: summarize(a), b: summarize(b) };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const dismissed = listDismissedPairs().map((p) => {
    const a = activityById(p.a_id);
    const b = activityById(p.b_id);
    return {
      a_id: p.a_id,
      b_id: p.b_id,
      a: a !== null ? summarize(a) : null,
      b: b !== null ? summarize(b) : null,
    };
  });

  return Response.json({ candidates, dismissed });
}

function readPairIds(
  body: Record<string, unknown>,
): { aId: number; bId: number } | null {
  const aId = body.aId;
  const bId = body.bId;
  if (
    typeof aId !== "number" ||
    !Number.isInteger(aId) ||
    aId <= 0 ||
    typeof bId !== "number" ||
    !Number.isInteger(bId) ||
    bId <= 0 ||
    aId === bId
  ) {
    return null;
  }
  return { aId, bId };
}

// POST /api/duplicates/dismiss {aId,bId} marks a pair kept (ISC-311).
export async function postDismissDuplicate(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);
  const pair = readPairIds(body);
  if (pair === null) return jsonError("aId and bId must be two distinct positive activity ids", 400);
  dismissPair(pair.aId, pair.bId);
  return Response.json({ dismissed: true, a_id: Math.min(pair.aId, pair.bId), b_id: Math.max(pair.aId, pair.bId) });
}

// POST /api/duplicates/undismiss {aId,bId} brings a dismissed pair back.
export async function postUndismissDuplicate(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);
  const pair = readPairIds(body);
  if (pair === null) return jsonError("aId and bId must be two distinct positive activity ids", 400);
  undismissPair(pair.aId, pair.bId);
  return Response.json({ dismissed: false, a_id: Math.min(pair.aId, pair.bId), b_id: Math.max(pair.aId, pair.bId) });
}

// POST /api/duplicates/merge {keepId,deleteId} deletes the chosen loser and
// keep the chosen row exactly as-is (ISC-312, ISC-313). Both ids explicit.
export async function postMergeDuplicate(req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body === null) return jsonError("Invalid JSON body", 400);
  const keepId = body.keepId;
  const deleteId = body.deleteId;
  if (
    typeof keepId !== "number" ||
    !Number.isInteger(keepId) ||
    keepId <= 0 ||
    typeof deleteId !== "number" ||
    !Number.isInteger(deleteId) ||
    deleteId <= 0
  ) {
    return jsonError("keepId and deleteId must be positive activity ids", 400);
  }
  const result = mergePair(keepId, deleteId);
  if (!result.ok) return jsonError(result.error, 400);
  const kept = activityById(result.keptId);
  return Response.json({
    merged: true,
    kept_id: result.keptId,
    deleted_id: result.deletedId,
    kept: kept !== null ? summarize(kept) : null,
  });
}
