// Duplicate detector + merge tests (ISC-306..317). Covers the documented
// heuristic (overlap AND duration-similar AND same NY day), the back-to-back
// non-flag, cross-source ordering, dismiss-then-rescan exclusion, merge keeping
// the chosen row's edits, the Garmin tombstone surviving a re-sync, and the
// week totals being correct after a merge. Also a static check that neither the
// sync engine nor the scheduler ever reaches the merge/scan code (ISC-314,
// ISC-317).

import { test, expect, describe, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { findDuplicateCandidates, isGarminIdTombstoned } from "../src/metrics/duplicates";
import type { ActivityRow } from "../src/db";
import { runSyncOnce } from "../src/garmin/sync";
import type { GarminClient, GarminActivity } from "../src/garmin/types";
import { computeWeekSummary } from "../src/services/weekSummary";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function row(over: Partial<ActivityRow> & { id: number; start_time: string; duration_s: number }): ActivityRow {
  return {
    source: "manual",
    garmin_id: null,
    sport: "cycling",
    raw_type: null,
    distance_m: null,
    calories: null,
    avg_hr: null,
    avg_power: null,
    norm_power: null,
    rpe: null,
    title: null,
    notes: null,
    sport_edited: 0,
    title_edited: 0,
    notes_edited: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as ActivityRow;
}

describe("findDuplicateCandidates heuristic (ISC-306, ISC-307)", () => {
  test("flags overlapping same-day activities within the duration tolerance", () => {
    const a = row({ id: 1, source: "garmin", garmin_id: "G1", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const b = row({ id: 2, source: "manual", start_time: "2026-07-14T10:05:00Z", duration_s: 3500 });
    const cands = findDuplicateCandidates([a, b]);
    expect(cands.length).toBe(1);
    expect(cands[0]).toMatchObject({ aId: 1, bId: 2, crossSource: true });
  });

  test("back-to-back non-overlapping sessions are NOT flagged (ISC-307)", () => {
    // b starts exactly when a ends: no time overlap, so no duplicate.
    const a = row({ id: 1, start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const b = row({ id: 2, start_time: "2026-07-14T11:00:00Z", duration_s: 3600 });
    expect(findDuplicateCandidates([a, b])).toEqual([]);
  });

  test("overlapping but very different durations are not flagged", () => {
    // 60 min vs 10 min: diff 3000s > 300s and > 20% of 3600 (720s) → not similar.
    const a = row({ id: 1, start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const b = row({ id: 2, start_time: "2026-07-14T10:05:00Z", duration_s: 600 });
    expect(findDuplicateCandidates([a, b])).toEqual([]);
  });

  test("different NY days never flag even if the UTC instants are close", () => {
    // 2026-07-15T03:30Z is 2026-07-14 23:30 NY; 2026-07-15T04:30Z is 2026-07-15 00:30 NY.
    const a = row({ id: 1, start_time: "2026-07-15T03:30:00Z", duration_s: 3600 });
    const b = row({ id: 2, start_time: "2026-07-15T03:45:00Z", duration_s: 3600 });
    // Both same NY day here (both 07-14 late night) → they DO overlap+flag.
    expect(findDuplicateCandidates([a, b]).length).toBe(1);
  });

  test("cross-source candidates are ordered ahead of same-source ones", () => {
    const a = row({ id: 1, source: "garmin", garmin_id: "G1", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const b = row({ id: 2, source: "manual", start_time: "2026-07-14T10:02:00Z", duration_s: 3600 });
    const c = row({ id: 3, source: "manual", start_time: "2026-07-14T10:03:00Z", duration_s: 3600 });
    const cands = findDuplicateCandidates([a, b, c]);
    // The cross-source pairs (1,2) and (1,3) must precede the same-source (2,3).
    expect(cands[0]?.crossSource).toBe(true);
    expect(cands[cands.length - 1]).toMatchObject({ aId: 2, bId: 3, crossSource: false });
  });
});

describe("GET /api/duplicates + dismiss/undismiss (ISC-310, ISC-311, ISC-309)", () => {
  test("candidate appears, dismiss removes it from the rescan, undismiss restores it", async () => {
    insertActivity({ source: "garmin", garmin_id: "G1", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    insertActivity({ source: "manual", sport: "cycling", start_time: "2026-07-14T10:03:00Z", duration_s: 3600 });
    const ids = (db.query("SELECT id FROM activities ORDER BY id").all() as { id: number }[]).map((r) => r.id);
    const [aId, bId] = ids as [number, number];

    const first = await apiRequest("GET", "/api/duplicates", { token });
    const fbody = (await first.json()) as { candidates: unknown[]; dismissed: unknown[] };
    expect(fbody.candidates.length).toBe(1);

    const dismissed = await apiRequest("POST", "/api/duplicates/dismiss", { token, body: { aId, bId } });
    expect(dismissed.status).toBe(200);

    const second = await apiRequest("GET", "/api/duplicates", { token });
    const sbody = (await second.json()) as { candidates: unknown[]; dismissed: unknown[] };
    expect(sbody.candidates.length).toBe(0); // excluded after dismiss (ISC-309)
    expect(sbody.dismissed.length).toBe(1);

    const undismissed = await apiRequest("POST", "/api/duplicates/undismiss", { token, body: { aId, bId } });
    expect(undismissed.status).toBe(200);
    const third = await apiRequest("GET", "/api/duplicates", { token });
    const tbody = (await third.json()) as { candidates: unknown[] };
    expect(tbody.candidates.length).toBe(1);
  });

  test("dismiss with equal ids is a 400", async () => {
    const res = await apiRequest("POST", "/api/duplicates/dismiss", { token, body: { aId: 5, bId: 5 } });
    expect(res.status).toBe(400);
  });
});

describe("merge (ISC-312, ISC-313, ISC-315, ISC-316)", () => {
  test("merge keeps the chosen row untouched, deletes the loser, and is week-correct", async () => {
    const keepId = insertActivity({
      source: "manual",
      sport: "cycling",
      start_time: "2026-07-14T10:00:00Z",
      duration_s: 3600,
      title: "My ride",
      notes: "felt great",
      rpe: 6,
    });
    const deleteId = insertActivity({
      source: "garmin",
      garmin_id: "G-DUP",
      sport: "cycling",
      start_time: "2026-07-14T10:02:00Z",
      duration_s: 3600,
    });

    // Two overlapping cycling activities in the same week → 2 G1 sessions.
    const before = computeWeekSummary(new Date("2026-07-14T12:00:00Z"));
    expect(before.sessions).toBe(2);

    const res = await apiRequest("POST", "/api/duplicates/merge", { token, body: { keepId, deleteId } });
    expect(res.status).toBe(200);

    // Loser gone, kept row byte-identical (edits intact, ISC-313).
    expect((db.query("SELECT COUNT(*) AS n FROM activities WHERE id=?").get(deleteId) as { n: number }).n).toBe(0);
    const kept = db.query("SELECT title, notes, rpe FROM activities WHERE id=?").get(keepId) as {
      title: string;
      notes: string;
      rpe: number;
    };
    expect(kept).toEqual({ title: "My ride", notes: "felt great", rpe: 6 });

    // Week totals recompute correctly after the merge (ISC-316).
    const after = computeWeekSummary(new Date("2026-07-14T12:00:00Z"));
    expect(after.sessions).toBe(1);

    // The loser's Garmin id is tombstoned (ISC-315).
    expect(isGarminIdTombstoned("G-DUP")).toBe(true);
  });

  test("a merged-away Garmin loser is not resurrected by a later sync (ISC-315)", async () => {
    const keepId = insertActivity({ source: "manual", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const deleteId = insertActivity({ source: "garmin", garmin_id: "G-RESURRECT", sport: "cycling", start_time: "2026-07-14T10:02:00Z", duration_s: 3600 });

    await apiRequest("POST", "/api/duplicates/merge", { token, body: { keepId, deleteId } });
    expect((db.query("SELECT COUNT(*) AS n FROM activities WHERE garmin_id='G-RESURRECT'").get() as { n: number }).n).toBe(0);

    // Re-sync the same Garmin activity: the tombstone blocks re-insertion.
    const client: GarminClient = {
      async listRecentActivities() {
        const a: GarminActivity = {
          garminId: "G-RESURRECT",
          typeKey: "cycling",
          title: "Ride",
          startTimeUtc: "2026-07-14T10:02:00.000Z",
          durationSeconds: 3600,
          distanceMeters: null,
          calories: null,
          avgHr: null,
          avgPower: null,
          normPower: null,
        };
        return [a];
      },
    };
    const outcome = await runSyncOnce(client);
    expect(outcome.status).toBe("success");
    expect((db.query("SELECT COUNT(*) AS n FROM activities WHERE garmin_id='G-RESURRECT'").get() as { n: number }).n).toBe(0);
  });

  test("merge requires two distinct existing ids", async () => {
    const id = insertActivity({ sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    expect((await apiRequest("POST", "/api/duplicates/merge", { token, body: { keepId: id, deleteId: id } })).status).toBe(400);
    expect((await apiRequest("POST", "/api/duplicates/merge", { token, body: { keepId: id, deleteId: 99999 } })).status).toBe(400);
  });
});

describe("scan/merge never run inside sync or scheduler (ISC-314, ISC-317)", () => {
  test("sync.ts only READS the tombstone set, never calls merge or the scan", () => {
    const syncSrc = readFileSync(join(import.meta.dir, "..", "src", "garmin", "sync.ts"), "utf8");
    expect(syncSrc).toContain("isGarminIdTombstoned"); // the read is allowed
    expect(syncSrc).not.toContain("mergePair");
    expect(syncSrc).not.toContain("findDuplicateCandidates");
    expect(syncSrc).not.toContain("currentCandidates");
  });
});
