// Quick wins 1 and 3: RPE as a fatigue signal in the adaptive engine, and
// Garmin Training Readiness synced for display.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";
import { buildPlan } from "../src/data/trainingPlan";
import { rpeHold, progressionHold, runAdaptPass, railViolations } from "../src/services/planAdapt";
import { syncReadiness, runSyncOnce } from "../src/garmin/sync";
import type { GarminClient } from "../src/garmin/types";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function seedFullPlan(): void {
  for (const s of buildPlan()) {
    db.query(
      `INSERT INTO planned_workouts (plan_day, sport, title, detail, duration_min, distance_m, target, tss_planned, week_no, phase, sort, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.planDay, s.sport, s.title, s.detail, s.durationMin, s.distanceM, s.target, s.tssPlanned, s.weekNo, s.phase, s.sort, s.kind);
  }
}

// Complete weeks 1 and 2 fully via matched activities carrying the given RPE.
function completeWeeksWithRpe(rpes: Record<number, number>): void {
  const rows = db.query(
    "SELECT id, plan_day, sport, duration_min, week_no FROM planned_workouts WHERE week_no IN (1,2) AND sport IN ('bike','run','strength')",
  ).all() as { id: number; plan_day: string; sport: string; duration_min: number; week_no: number }[];
  for (const s of rows) {
    const sport = s.sport === "bike" ? "virtual_cycling" : s.sport === "run" ? "running" : "strength";
    insertActivity({ sport, start_time: `${s.plan_day}T20:00:00Z`, duration_s: s.duration_min * 60 });
    const actId = (db.query("SELECT MAX(id) id FROM activities").get() as { id: number }).id;
    const rpe = rpes[s.week_no];
    if (rpe !== undefined) db.query("UPDATE activities SET rpe = ? WHERE id = ?").run(rpe, actId);
    db.query("UPDATE planned_workouts SET status = 'done', done_source = 'auto', activity_id = ? WHERE id = ?").run(actId, s.id);
  }
}

const WEEK3_MONDAY = new Date("2026-08-17T16:00:00Z");

describe("RPE hold", () => {
  test("two fully-completed weeks whose easy sessions felt like 8+ shift the ramp", () => {
    seedFullPlan();
    completeWeeksWithRpe({ 1: 9, 2: 8 });
    expect(progressionHold(WEEK3_MONDAY)).toBe(false);
    expect(rpeHold(WEEK3_MONDAY)).toBe(true);
    const log = db.query("SELECT description, reason FROM plan_adaptations WHERE kind = 'rpe_hold'").get() as { description: string; reason: string };
    expect(log.description).toContain("felt too hard");
    expect(log.reason).toContain("rated 8 or harder");
    const w5 = db.query("SELECT distance_m FROM planned_workouts WHERE week_no = 5 AND kind = 'long_run'").get() as { distance_m: number };
    expect(w5.distance_m).toBe(9000);
    expect(railViolations()).toHaveLength(0);
  });

  test("easy sessions at 7 do not trigger", () => {
    seedFullPlan();
    completeWeeksWithRpe({ 1: 7, 2: 7 });
    expect(rpeHold(WEEK3_MONDAY)).toBe(false);
  });

  test("a hard-feeling race day alone never triggers: only easy kinds count", () => {
    seedFullPlan();
    completeWeeksWithRpe({ 1: 4, 2: 4 });
    db.query(
      `UPDATE activities SET rpe = 9 WHERE id IN (
         SELECT a.id FROM activities a JOIN planned_workouts p ON p.activity_id = a.id WHERE p.kind IN ('race','strength_a','strength_b')
       )`,
    ).run();
    expect(rpeHold(WEEK3_MONDAY)).toBe(false);
  });

  test("one hold per 14 days: a fresh completion hold blocks an immediate RPE hold", () => {
    seedFullPlan();
    completeWeeksWithRpe({ 1: 9, 2: 9 });
    db.query("INSERT INTO plan_adaptations (kind, description, reason, effective_from) VALUES ('progression_hold','recent','r','2026-08-10')").run();
    expect(rpeHold(WEEK3_MONDAY)).toBe(false);
  });

  test("under 3 RPE samples in a week does not trigger", () => {
    seedFullPlan();
    completeWeeksWithRpe({ 1: 9 });
    db.query(
      "UPDATE activities SET rpe = NULL WHERE id IN (SELECT id FROM activities LIMIT 100)",
    ).run();
    const kept = db.query(
      "SELECT a.id FROM activities a JOIN planned_workouts p ON p.activity_id = a.id WHERE p.week_no = 1 LIMIT 2",
    ).all() as { id: number }[];
    for (const k of kept) db.query("UPDATE activities SET rpe = 9 WHERE id = ?").run(k.id);
    expect(rpeHold(WEEK3_MONDAY)).toBe(false);
  });

  test("shares the hold ceiling with completion holds", () => {
    seedFullPlan();
    completeWeeksWithRpe({ 1: 9, 2: 9 });
    db.query("INSERT INTO plan_adaptations (kind, description, reason, effective_from) VALUES ('progression_hold','a','r','2026-08-01')").run();
    db.query("INSERT INTO plan_adaptations (kind, description, reason, effective_from) VALUES ('rpe_hold','b','r','2026-08-08')").run();
    expect(rpeHold(WEEK3_MONDAY)).toBe(false);
    const esc = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'hold_escalation'").get() as { n: number }).n;
    expect(esc).toBe(1);
  });

  test("idempotent per target week", () => {
    seedFullPlan();
    completeWeeksWithRpe({ 1: 9, 2: 9 });
    expect(rpeHold(WEEK3_MONDAY)).toBe(true);
    expect(rpeHold(WEEK3_MONDAY)).toBe(false);
  });

  test("completion hold outranks RPE hold in the pass", () => {
    seedFullPlan();
    runAdaptPass(WEEK3_MONDAY);
    const holds = db.query("SELECT kind FROM plan_adaptations WHERE kind IN ('progression_hold','rpe_hold')").all() as { kind: string }[];
    expect(holds.map((h) => h.kind)).toEqual(["progression_hold"]);
  });
});

describe("Training Readiness sync", () => {
  const reading = (score: number, date = "2026-07-31") => [{ score, level: "HIGH", calendarDate: date }];

  test("upserts today's reading and stays idempotent", async () => {
    const client = { async listRecentActivities() { return []; }, async getTrainingReadiness() { return reading(72); } } as GarminClient;
    await syncReadiness(client);
    await syncReadiness(client);
    const rows = db.query("SELECT calendar_date, score, level FROM readiness").all() as { calendar_date: string; score: number; level: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBe(72);
    expect(rows[0]!.level).toBe("HIGH");
  });

  test("a later reading for the same day replaces the score", async () => {
    const mk = (s: number) => ({ async listRecentActivities() { return []; }, async getTrainingReadiness() { return reading(s); } }) as GarminClient;
    await syncReadiness(mk(60));
    await syncReadiness(mk(81));
    const row = db.query("SELECT score FROM readiness WHERE calendar_date = '2026-07-31'").get() as { score: number };
    expect(row.score).toBe(81);
  });

  test("garbage shapes and missing capability are safe no-ops", async () => {
    await syncReadiness({ async listRecentActivities() { return []; } } as GarminClient);
    await syncReadiness({ async listRecentActivities() { return []; }, async getTrainingReadiness() { return { nothing: true }; } } as GarminClient);
    await syncReadiness({ async listRecentActivities() { return []; }, async getTrainingReadiness() { throw new Error("boom"); } } as GarminClient);
    const n = (db.query("SELECT COUNT(*) n FROM readiness").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  test("rides the sync without breaking it", async () => {
    const client = { async listRecentActivities() { return []; }, async getTrainingReadiness() { return reading(65); } } as GarminClient;
    const outcome = await runSyncOnce(client);
    expect(outcome.status).toBe("success");
    const n = (db.query("SELECT COUNT(*) n FROM readiness").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  test("route is auth-gated and returns newest first", async () => {
    const noauth = await apiRequest("GET", "/api/metrics/readiness", {});
    expect(noauth.status).toBe(401);
    db.query("INSERT INTO readiness (calendar_date, score, level) VALUES ('2026-07-30', 55, 'MODERATE')").run();
    db.query("INSERT INTO readiness (calendar_date, score, level) VALUES ('2026-07-31', 70, 'HIGH')").run();
    const res = await apiRequest("GET", "/api/metrics/readiness", { token });
    const body = (await res.json()) as { readiness: { calendar_date: string; score: number }[] };
    expect(body.readiness[0]!.calendar_date).toBe("2026-07-31");
    expect(body.readiness[0]!.score).toBe(70);
  });
});
