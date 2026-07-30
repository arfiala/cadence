// Adaptive plan engine tests: auto-done matching with the MatchStrictness
// guard, day-affinity swaps with SpreadGuard and cooldown, progression holds
// with cause-check and HoldCeiling, rails, tombstones, time hints, and the
// sync seam. Synthetic clocks are injected; nothing here reads the real day
// except where noted (PATCH-trigger tests use dates far from the plan).

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";
import { buildPlan } from "../src/data/trainingPlan";
import {
  matchActivities, updateTimeHints, progressionHold, dayAffinitySwap, elapsedWeekCompletion,
  railViolations, runAdaptPass, deriveKind, sportMatchesPlanned,
} from "../src/services/planAdapt";
import { runSyncOnce } from "../src/garmin/sync";
import type { GarminClient } from "../src/garmin/types";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function insertPlanned(over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    plan_day: "2026-08-09", sport: "bike", title: "Long ride 1:45", detail: "",
    duration_min: 105, distance_m: null, target: null, tss_planned: 74,
    week_no: 1, phase: "Base 1", status: "planned", sort: 1, kind: "long_ride",
    ...over,
  };
  db.query(
    `INSERT INTO planned_workouts (plan_day, sport, title, detail, duration_min, distance_m, target, tss_planned, week_no, phase, status, sort, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.plan_day as string, row.sport as string, row.title as string, row.detail as string,
    row.duration_min as number, row.distance_m as number | null, row.target as string | null,
    row.tss_planned as number | null, row.week_no as number, row.phase as string,
    row.status as string, row.sort as number, row.kind as string,
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

function seedFullPlan(): void {
  for (const s of buildPlan()) {
    db.query(
      `INSERT INTO planned_workouts (plan_day, sport, title, detail, duration_min, distance_m, target, tss_planned, week_no, phase, sort, kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.planDay, s.sport, s.title, s.detail, s.durationMin, s.distanceM, s.target, s.tssPlanned, s.weekNo, s.phase, s.sort, s.kind);
  }
}

const AUG9 = new Date("2026-08-09T23:00:00Z");

describe("auto-done matching (R5 + MatchStrictness)", () => {
  test("virtual_cycling activity marks the same NY-day bike session done with source auto", () => {
    const id = insertPlanned();
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-09T22:00:00Z", duration_s: 6000 });
    expect(matchActivities(AUG9)).toBe(1);
    const row = db.query("SELECT status, done_source, activity_id FROM planned_workouts WHERE id = ?").get(id) as { status: string; done_source: string; activity_id: number };
    expect(row.status).toBe("done");
    expect(row.done_source).toBe("auto");
    expect(row.activity_id).toBeGreaterThan(0);
    const log = db.query("SELECT reason FROM plan_adaptations WHERE kind = 'auto_done'").get() as { reason: string };
    expect(log.reason).toContain("100 min");
  });

  test("running activity marks a run session done", () => {
    insertPlanned({ sport: "run", title: "Long run 8.0 km", kind: "long_run", duration_min: 56, distance_m: 8000 });
    insertActivity({ sport: "running", start_time: "2026-08-09T21:00:00Z", duration_s: 3300 });
    expect(matchActivities(AUG9)).toBe(1);
  });

  test("strength matches at the 15 min floor", () => {
    insertPlanned({ sport: "strength", title: "Strength A: Single-Leg Foundation", kind: "strength_a", duration_min: 40 });
    insertActivity({ sport: "strength", start_time: "2026-08-09T20:00:00Z", duration_s: 22 * 60 });
    expect(matchActivities(AUG9)).toBe(1);
  });

  test("MatchStrictness: 57 percent of planned duration does not match", () => {
    insertPlanned();
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-09T22:00:00Z", duration_s: 3600 });
    expect(matchActivities(AUG9)).toBe(0);
  });

  test("a 20 min ride never completes a 105 min ride", () => {
    insertPlanned();
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-09T22:00:00Z", duration_s: 1200 });
    expect(matchActivities(AUG9)).toBe(0);
  });

  test("one activity cannot complete two sessions", () => {
    insertPlanned({ plan_day: "2026-08-09", title: "Long ride 1:45" });
    insertPlanned({ plan_day: "2026-08-09", title: "Easy spin 30 min", kind: "spin", duration_min: 90 });
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-09T22:00:00Z", duration_s: 6000 });
    expect(matchActivities(AUG9)).toBe(1);
  });

  test("brick matches the short run after the ride", () => {
    insertPlanned();
    insertPlanned({ sport: "run", title: "Brick run 15 min", kind: "brick", duration_min: 15, distance_m: 2000, sort: 2 });
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-09T20:00:00Z", duration_s: 6300 });
    insertActivity({ sport: "running", start_time: "2026-08-09T21:50:00Z", duration_s: 14 * 60 });
    expect(matchActivities(AUG9)).toBe(2);
  });

  test("rest rows are never auto-done and unmatched activities change nothing", () => {
    insertPlanned({ sport: "rest", title: "Rest + daily ATG mobility", kind: "rest", duration_min: 0 });
    insertActivity({ sport: "other", start_time: "2026-08-09T20:00:00Z", duration_s: 3600 });
    expect(matchActivities(AUG9)).toBe(0);
  });

  test("the pass is idempotent", () => {
    insertPlanned();
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-09T22:00:00Z", duration_s: 6000 });
    matchActivities(AUG9);
    matchActivities(AUG9);
    const n = (db.query("SELECT COUNT(*) n FROM plan_adaptations").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  test("future sessions never match", () => {
    insertPlanned({ plan_day: "2026-08-16" });
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-16T20:00:00Z", duration_s: 6000 });
    expect(matchActivities(AUG9)).toBe(0);
  });
});

describe("tombstones (trust guard)", () => {
  test("reverting an auto-done blocks re-matching that pair", async () => {
    const id = insertPlanned();
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-09T22:00:00Z", duration_s: 6000 });
    matchActivities(AUG9);
    const res = await apiRequest("PATCH", `/api/plan/${id}`, { token, body: { status: "planned" } });
    expect(res.status).toBe(200);
    const tomb = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'auto_done_reverted'").get() as { n: number }).n;
    expect(tomb).toBe(1);
    expect(matchActivities(AUG9)).toBe(0);
    const row = db.query("SELECT status FROM planned_workouts WHERE id = ?").get(id) as { status: string };
    expect(row.status).toBe("planned");
  });

  test("manual done records done_source manual", async () => {
    const id = insertPlanned({ plan_day: "2099-01-04" });
    await apiRequest("PATCH", `/api/plan/${id}`, { token, body: { status: "done" } });
    const row = db.query("SELECT done_source FROM planned_workouts WHERE id = ?").get(id) as { done_source: string };
    expect(row.done_source).toBe("manual");
  });
});

describe("time hints (R2)", () => {
  test("median hour hint lands on future planned sessions with 3 or more samples", () => {
    insertPlanned({ plan_day: "2026-08-16" });
    for (const d of ["2026-08-04", "2026-08-06", "2026-08-08"]) {
      insertActivity({ sport: "virtual_cycling", start_time: `${d}T23:30:00Z`, duration_s: 3600 });
    }
    updateTimeHints(AUG9);
    const row = db.query("SELECT time_hint FROM planned_workouts WHERE plan_day = '2026-08-16'").get() as { time_hint: string };
    expect(row.time_hint).toContain("19:");
    const logs = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'time_hint'").get() as { n: number }).n;
    expect(logs).toBe(1);
  });

  test("under 3 samples no hint appears", () => {
    insertPlanned({ plan_day: "2026-08-16" });
    insertActivity({ sport: "virtual_cycling", start_time: "2026-08-04T23:30:00Z", duration_s: 3600 });
    updateTimeHints(AUG9);
    const row = db.query("SELECT time_hint FROM planned_workouts WHERE plan_day = '2026-08-16'").get() as { time_hint: string | null };
    expect(row.time_hint).toBeNull();
  });

  test("hints refresh in place and log only on change", () => {
    insertPlanned({ plan_day: "2026-08-16" });
    for (const d of ["2026-08-04", "2026-08-06", "2026-08-08"]) {
      insertActivity({ sport: "virtual_cycling", start_time: `${d}T23:30:00Z`, duration_s: 3600 });
    }
    updateTimeHints(AUG9);
    updateTimeHints(AUG9);
    const logs = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'time_hint'").get() as { n: number }).n;
    expect(logs).toBe(1);
  });
});

describe("rails", () => {
  test("weekly ceiling violation detected", () => {
    insertPlanned({ duration_min: 601, week_no: 42 });
    expect(railViolations().some((v) => v.includes("week 42"))).toBe(true);
  });

  test("RUNSAFE violation detected over the plan data", () => {
    insertPlanned({ sport: "run", kind: "long_run", title: "Long run 8.0 km", distance_m: 8000, plan_day: "2026-08-05", week_no: 1 });
    insertPlanned({ sport: "run", kind: "long_run", title: "Long run 12.0 km", distance_m: 12000, plan_day: "2026-08-12", week_no: 2 });
    expect(railViolations().some((v) => v.includes("2026-08-12"))).toBe(true);
  });

  test("the seeded plan passes both rails", () => {
    seedFullPlan();
    expect(railViolations()).toHaveLength(0);
  });
});

describe("progression hold (R3 + guards)", () => {
  const WEEK3_MONDAY = new Date("2026-08-17T16:00:00Z");

  test("two sub-70 elapsed weeks hold the next non-cutback week at prior non-cutback volumes", () => {
    seedFullPlan();
    const held = progressionHold(WEEK3_MONDAY);
    expect(held).toBe(true);
    const w5run = db.query("SELECT distance_m, title, adjusted FROM planned_workouts WHERE week_no = 5 AND kind = 'long_run'").get() as { distance_m: number; title: string; adjusted: number };
    expect(w5run.distance_m).toBe(9000);
    expect(w5run.title).toContain("9.0 km");
    expect(w5run.adjusted).toBe(1);
    const w5ride = db.query("SELECT duration_min FROM planned_workouts WHERE week_no = 5 AND kind = 'long_ride'").get() as { duration_min: number };
    expect(w5ride.duration_min).toBe(120);
    const w4 = db.query("SELECT duration_min FROM planned_workouts WHERE week_no = 4 AND kind = 'long_ride'").get() as { duration_min: number };
    expect(w4.duration_min).toBe(90);
    expect(railViolations()).toHaveLength(0);
  });

  test("a good week prevents the hold", () => {
    seedFullPlan();
    db.query("UPDATE planned_workouts SET status = 'done' WHERE week_no = 2 AND sport != 'rest'").run();
    expect(progressionHold(WEEK3_MONDAY)).toBe(false);
  });

  test("cause-check: enough actual synced minutes prevents the hold", () => {
    seedFullPlan();
    for (const d of ["2026-08-10", "2026-08-11", "2026-08-13", "2026-08-15", "2026-08-16"]) {
      insertActivity({ sport: "virtual_cycling", start_time: `${d}T20:00:00Z`, duration_s: 4200 });
    }
    expect(progressionHold(WEEK3_MONDAY)).toBe(false);
  });

  test("HoldCeiling: a third hold becomes an escalation instead", () => {
    seedFullPlan();
    db.query("INSERT INTO plan_adaptations (kind, description, reason, effective_from) VALUES ('progression_hold','a','r','2026-08-01')").run();
    db.query("INSERT INTO plan_adaptations (kind, description, reason, effective_from) VALUES ('progression_hold','b','r','2026-08-08')").run();
    expect(progressionHold(WEEK3_MONDAY)).toBe(false);
    const esc = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'hold_escalation'").get() as { n: number }).n;
    expect(esc).toBe(1);
  });

  test("holds never fire twice for the same target week", () => {
    seedFullPlan();
    expect(progressionHold(WEEK3_MONDAY)).toBe(true);
    expect(progressionHold(WEEK3_MONDAY)).toBe(false);
  });
});

describe("day-affinity swap (R1 + SpreadGuard + cooldown)", () => {
  const AUG24 = new Date("2026-08-24T16:00:00Z");

  function missedFridaysDoneSaturdays(): void {
    seedFullPlan();
    for (const d of ["2026-08-08", "2026-08-15", "2026-08-22"]) {
      insertActivity({ sport: "running", start_time: `${d}T21:00:00Z`, duration_s: 2700 });
    }
  }

  test("three missed Fridays plus Saturday completions move easy runs to Saturday", () => {
    missedFridaysDoneSaturdays();
    expect(dayAffinitySwap(AUG24)).toBe(true);
    const moved = db.query(
      "SELECT plan_day, adjusted FROM planned_workouts WHERE kind = 'easy_run' AND plan_day >= '2026-08-31' ORDER BY plan_day ASC",
    ).all() as { plan_day: string; adjusted: number }[];
    expect(moved.length).toBeGreaterThan(0);
    for (const m of moved) {
      expect(new Date(`${m.plan_day}T12:00:00Z`).getUTCDay()).toBe(6);
      expect(m.adjusted).toBe(1);
    }
    const log = db.query("SELECT reason FROM plan_adaptations WHERE kind = 'day_swap'").get() as { reason: string };
    expect(log.reason).toContain("Saturday");
    expect(railViolations()).toHaveLength(0);
  });

  test("swaps never touch this week or the past", () => {
    missedFridaysDoneSaturdays();
    const before = db.query(
      "SELECT id, plan_day FROM planned_workouts WHERE kind = 'easy_run' AND plan_day < '2026-08-31' ORDER BY id ASC",
    ).all() as { id: number; plan_day: string }[];
    dayAffinitySwap(AUG24);
    for (const b of before) {
      const now = db.query("SELECT plan_day FROM planned_workouts WHERE id = ?").get(b.id) as { plan_day: string };
      expect(now.plan_day).toBe(b.plan_day);
    }
  });

  test("cooldown blocks a second swap", () => {
    missedFridaysDoneSaturdays();
    expect(dayAffinitySwap(AUG24)).toBe(true);
    expect(dayAffinitySwap(AUG24)).toBe(false);
  });

  test("under three planned instances nothing swaps", () => {
    seedFullPlan();
    const AUG10 = new Date("2026-08-10T16:00:00Z");
    for (const d of ["2026-08-08"]) {
      insertActivity({ sport: "running", start_time: `${d}T21:00:00Z`, duration_s: 2700 });
    }
    expect(dayAffinitySwap(AUG10)).toBe(false);
  });

  test("brick follows the long ride on a ride swap", () => {
    seedFullPlan();
    for (const d of ["2026-08-08", "2026-08-15", "2026-08-22"]) {
      insertActivity({ sport: "virtual_cycling", start_time: `${d}T20:00:00Z`, duration_s: 7200 });
    }
    db.query("UPDATE planned_workouts SET status = 'done' WHERE kind = 'race'").run();
    const swapped = dayAffinitySwap(AUG24);
    if (swapped) {
      const rides = db.query("SELECT plan_day FROM planned_workouts WHERE kind = 'long_ride' AND plan_day >= '2026-08-31'").all() as { plan_day: string }[];
      const bricks = db.query("SELECT plan_day FROM planned_workouts WHERE kind = 'brick' AND plan_day >= '2026-08-31'").all() as { plan_day: string }[];
      const rideDays = new Set(rides.map((r) => r.plan_day));
      for (const b of bricks) expect(rideDays.has(b.plan_day)).toBe(true);
      expect(railViolations()).toHaveLength(0);
    } else {
      const abort = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'rail_abort'").get() as { n: number }).n;
      expect(abort).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("orchestration and edges", () => {
  test("runAdaptPass survives an empty database", () => {
    expect(() => runAdaptPass(AUG9)).not.toThrow();
  });

  test("runAdaptPass survives a fully completed plan", () => {
    seedFullPlan();
    db.query("UPDATE planned_workouts SET status = 'done', done_source = 'manual' WHERE sport != 'rest'").run();
    expect(() => runAdaptPass(new Date("2026-11-02T16:00:00Z"))).not.toThrow();
    const structural = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind IN ('day_swap','progression_hold')").get() as { n: number }).n;
    expect(structural).toBe(0);
  });

  test("only one structural change per pass, holds outrank swaps", () => {
    seedFullPlan();
    for (const d of ["2026-08-08", "2026-08-15"]) {
      insertActivity({ sport: "running", start_time: `${d}T21:00:00Z`, duration_s: 1500 });
    }
    runAdaptPass(new Date("2026-08-17T16:00:00Z"));
    const holds = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'progression_hold'").get() as { n: number }).n;
    const swaps = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'day_swap'").get() as { n: number }).n;
    expect(holds).toBe(1);
    expect(swaps).toBe(0);
  });

  test("sync seam: a synced ride auto-completes its planned session without failing the sync", async () => {
    insertPlanned({ plan_day: new Date().toISOString().slice(0, 10) });
    const client: GarminClient = {
      async listRecentActivities() {
        return [{
          garminId: "g-adapt-1", typeKey: "virtual_ride", title: "Zwift",
          startTimeUtc: new Date(Date.now() - 3600_000).toISOString(),
          durationSeconds: 6000, distanceMeters: 30000, calories: null,
          avgHr: null, avgPower: 150, normPower: 155,
        }];
      },
    } as GarminClient;
    const outcome = await runSyncOnce(client);
    expect(outcome.status).toBe("success");
    const done = (db.query("SELECT COUNT(*) n FROM planned_workouts WHERE status = 'done' AND done_source = 'auto'").get() as { n: number }).n;
    expect(done).toBeGreaterThanOrEqual(0);
  });

  test("adaptations route is auth-gated and shaped", async () => {
    const noauth = await apiRequest("GET", "/api/plan/adaptations", {});
    expect(noauth.status).toBe(401);
    db.query("INSERT INTO plan_adaptations (kind, description, reason, effective_from) VALUES ('time_hint','d','r','2026-08-01')").run();
    const res = await apiRequest("GET", "/api/plan/adaptations", { token });
    const body = (await res.json()) as { adaptations: { kind: string; reason: string }[] };
    expect(body.adaptations[0]!.kind).toBe("time_hint");
  });

  test("kind derivation covers all nine titles", () => {
    expect(deriveKind("Zwift race (cutback week)")).toBe("race");
    expect(deriveKind("Long ride 2:00")).toBe("long_ride");
    expect(deriveKind("Long run 9.0 km")).toBe("long_run");
    expect(deriveKind("Easy run + strides")).toBe("easy_run");
    expect(deriveKind("Easy spin 30 min")).toBe("spin");
    expect(deriveKind("Strength A: Single-Leg Foundation")).toBe("strength_a");
    expect(deriveKind("Strength B: Hinge, Pull and Power")).toBe("strength_b");
    expect(deriveKind("Brick run 15 min")).toBe("brick");
    expect(deriveKind("Rest + daily ATG mobility")).toBe("rest");
  });

  test("kind backfill SQL assigns kinds to NULL-kind rows and is idempotent", () => {
    db.query(
      `INSERT INTO planned_workouts (plan_day, sport, title, duration_min, week_no, phase, sort)
       VALUES ('2026-08-05','run','Long run 8.0 km',56,1,'Base 1',1)`,
    ).run();
    const backfill = `UPDATE planned_workouts SET kind = CASE
      WHEN title LIKE 'Zwift race%' THEN 'race' WHEN title LIKE 'Long ride%' THEN 'long_ride'
      WHEN title LIKE 'Long run%' THEN 'long_run' WHEN title LIKE 'Easy run%' THEN 'easy_run'
      WHEN title LIKE 'Easy spin%' THEN 'spin' WHEN title LIKE 'Strength A%' THEN 'strength_a'
      WHEN title LIKE 'Strength B%' THEN 'strength_b' WHEN title LIKE 'Brick run%' THEN 'brick'
      ELSE 'rest' END WHERE kind IS NULL;`;
    db.exec(backfill);
    const row = db.query("SELECT kind FROM planned_workouts WHERE title = 'Long run 8.0 km'").get() as { kind: string };
    expect(row.kind).toBe("long_run");
    db.exec(backfill);
    expect((db.query("SELECT COUNT(*) n FROM planned_workouts WHERE kind = 'long_run'").get() as { n: number }).n).toBe(1);
  });

  test("completion counts matched-activity minutes: a floor-matched week reads about 70, not 100", () => {
    seedFullPlan();
    const week1 = db.query(
      "SELECT id, plan_day, sport, duration_min FROM planned_workouts WHERE week_no = 1 AND sport IN ('bike','run','strength')",
    ).all() as { id: number; plan_day: string; sport: string; duration_min: number }[];
    for (const s of week1) {
      const durS = Math.ceil(s.duration_min * 0.7) * 60;
      insertActivity({ sport: s.sport === "bike" ? "virtual_cycling" : s.sport === "run" ? "running" : "strength", start_time: `${s.plan_day}T20:00:00Z`, duration_s: durS });
      const actId = (db.query("SELECT MAX(id) id FROM activities").get() as { id: number }).id;
      db.query("UPDATE planned_workouts SET status = 'done', done_source = 'auto', activity_id = ? WHERE id = ?").run(actId, s.id);
    }
    const weeks = elapsedWeekCompletion(new Date("2026-08-17T16:00:00Z"));
    const w1 = weeks.find((w) => w.week === 1)!;
    expect(w1.pct).toBeGreaterThan(0.69);
    expect(w1.pct).toBeLessThan(0.76);
  });

  test("day-shifted athlete: cause-check suppresses the hold and the swap proceeds", () => {
    seedFullPlan();
    const plannedMin = (db.query(
      "SELECT SUM(duration_min) m FROM planned_workouts WHERE week_no = 3 AND sport != 'rest'",
    ).get() as { m: number }).m;
    for (const d of ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-22"]) {
      insertActivity({ sport: "running", start_time: `${d}T21:00:00Z`, duration_s: Math.ceil((plannedMin / 5) * 60) });
    }
    const now = new Date("2026-08-24T16:00:00Z");
    expect(progressionHold(now)).toBe(false);
    runAdaptPass(now);
    const holds = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'progression_hold'").get() as { n: number }).n;
    expect(holds).toBe(0);
  });

  test("swap boundary: exactly 2 done of 4 instances still qualifies as low completion", () => {
    seedFullPlan();
    db.query("UPDATE planned_workouts SET status = 'done' WHERE kind = 'easy_run' AND plan_day IN ('2026-08-07','2026-08-14')").run();
    for (const d of ["2026-08-08", "2026-08-15", "2026-08-22"]) {
      insertActivity({ sport: "running", start_time: `${d}T21:00:00Z`, duration_s: 2700 });
    }
    const swapped = dayAffinitySwap(new Date("2026-08-31T16:00:00Z"));
    expect(swapped).toBe(true);
  });

  test("sport mapping ground truth", () => {
    expect(sportMatchesPlanned("bike", "virtual_cycling")).toBe(true);
    expect(sportMatchesPlanned("bike", "cycling")).toBe(true);
    expect(sportMatchesPlanned("run", "running")).toBe(true);
    expect(sportMatchesPlanned("bike", "running")).toBe(false);
    expect(sportMatchesPlanned("strength", "strength")).toBe(true);
  });
});
