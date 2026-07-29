// Training plan feature tests: migration shape, route auth/validation,
// Monday-anchored week query, seed determinism and refusal, plan-content
// safety rails (weekly minutes table, RUNSAFE long-run rule), summary math.

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { db } from "../src/db";
import { resetDb, seedToken, apiRequest } from "./helpers";
import { buildPlan, WEEK_TABLE, PLAN_START } from "../src/data/trainingPlan";
import { weekDaysFor } from "../src/routes/plan";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function insertPlanned(over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    plan_day: "2026-08-03",
    sport: "bike",
    title: "Test ride",
    detail: "",
    duration_min: 60,
    distance_m: null,
    target: null,
    tss_planned: null,
    week_no: 1,
    phase: "Base 1",
    status: "planned",
    sort: 1,
    ...over,
  };
  db.query(
    `INSERT INTO planned_workouts (plan_day, sport, title, detail, duration_min, distance_m, target, tss_planned, week_no, phase, status, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.plan_day as string, row.sport as string, row.title as string, row.detail as string,
    row.duration_min as number, row.distance_m as number | null, row.target as string | null,
    row.tss_planned as number | null, row.week_no as number, row.phase as string,
    row.status as string, row.sort as number,
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

describe("planned_workouts migration", () => {
  test("table exists with the expected columns", () => {
    const cols = db.query("PRAGMA table_info(planned_workouts)").all() as { name: string }[];
    const names = cols.map((c) => c.name);
    for (const expected of [
      "id", "plan_day", "sport", "title", "detail", "duration_min", "distance_m",
      "target", "tss_planned", "week_no", "phase", "status", "activity_id", "sort",
    ]) {
      expect(names).toContain(expected);
    }
  });

  test("guarded DDL is a no-op on a second run against the same file", () => {
    insertPlanned();
    const path = process.env.DATABASE_PATH as string;
    const second = new Database(path);
    second.exec("CREATE TABLE IF NOT EXISTS planned_workouts (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    second.close();
    const n = (db.query("SELECT COUNT(*) AS n FROM planned_workouts").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  test("status CHECK rejects invalid values at the DB layer", () => {
    expect(() => insertPlanned({ status: "maybe" })).toThrow();
  });
});

describe("auth gating", () => {
  test("all three plan routes return 401 without a token", async () => {
    for (const [method, path] of [
      ["GET", "/api/plan/week?date=2026-08-05"],
      ["GET", "/api/plan/summary"],
      ["PATCH", "/api/plan/1"],
    ] as const) {
      const res = await apiRequest(method, path, { body: method === "PATCH" ? { status: "done" } : undefined });
      expect(res.status).toBe(401);
    }
  });
});

describe("GET /api/plan/week", () => {
  test("returns only the Monday-anchored NY week containing the date", async () => {
    insertPlanned({ plan_day: "2026-08-03", title: "Mon session" });
    insertPlanned({ plan_day: "2026-08-09", title: "Sun session" });
    insertPlanned({ plan_day: "2026-08-10", title: "Next Mon session" });
    const res = await apiRequest("GET", "/api/plan/week?date=2026-08-05", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weekStart: string; sessions: { title: string }[] };
    expect(body.weekStart).toBe("2026-08-03");
    expect(body.sessions.map((s) => s.title)).toEqual(["Mon session", "Sun session"]);
  });

  test("weekDaysFor is stable across the November DST transition", () => {
    const days = weekDaysFor("2026-11-04");
    expect(days[0]).toBe("2026-11-02");
    expect(days[6]).toBe("2026-11-08");
    expect(days).toHaveLength(7);
  });

  test("same-day sessions order by sort so the brick follows the ride", async () => {
    insertPlanned({ plan_day: "2026-08-09", title: "Brick run 15 min", sport: "run", sort: 2 });
    insertPlanned({ plan_day: "2026-08-09", title: "Long ride", sport: "bike", sort: 1 });
    const res = await apiRequest("GET", "/api/plan/week?date=2026-08-09", { token });
    const body = (await res.json()) as { sessions: { title: string }[] };
    expect(body.sessions.map((s) => s.title)).toEqual(["Long ride", "Brick run 15 min"]);
  });

  test("a week outside the plan returns 200 with an empty list", async () => {
    insertPlanned();
    const res = await apiRequest("GET", "/api/plan/week?date=2031-01-01", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(0);
  });

  test("rejects a malformed date", async () => {
    const res = await apiRequest("GET", "/api/plan/week?date=nonsense", { token });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/plan/:id", () => {
  test("marks a session done and persists it", async () => {
    const id = insertPlanned();
    const res = await apiRequest("PATCH", `/api/plan/${id}`, { token, body: { status: "done" } });
    expect(res.status).toBe(200);
    const row = db.query("SELECT status FROM planned_workouts WHERE id = ?").get(id) as {
      status: string;
    };
    expect(row.status).toBe("done");
  });

  test("rejects an invalid status with 400", async () => {
    const id = insertPlanned();
    const res = await apiRequest("PATCH", `/api/plan/${id}`, { token, body: { status: "victory" } });
    expect(res.status).toBe(400);
  });

  test("unknown id returns 404", async () => {
    const res = await apiRequest("PATCH", "/api/plan/999999", { token, body: { status: "done" } });
    expect(res.status).toBe(404);
  });
});

describe("plan content safety rails", () => {
  const plan = buildPlan();

  test("covers all 84 days of the 12-week block with no swim anywhere", () => {
    const days = new Set(plan.map((s) => s.planDay));
    expect(days.size).toBe(84);
    expect(plan.some((s) => /swim/i.test(s.sport + " " + s.title))).toBe(false);
  });

  test("per-week seeded minutes match the designed ramp exactly", () => {
    const expected: Record<number, number> = {
      1: 356, 2: 370, 3: 393, 4: 331, 5: 437, 6: 455,
      7: 474, 8: 358, 9: 482, 10: 504, 11: 521, 12: 428,
    };
    const byWeek = new Map<number, number>();
    for (const s of plan) byWeek.set(s.weekNo, (byWeek.get(s.weekNo) ?? 0) + s.durationMin);
    for (const [week, minutes] of Object.entries(expected)) {
      expect(byWeek.get(Number(week))).toBe(minutes);
    }
  });

  test("no week exceeds the 10 hour ceiling", () => {
    const byWeek = new Map<number, number>();
    for (const s of plan) byWeek.set(s.weekNo, (byWeek.get(s.weekNo) ?? 0) + s.durationMin);
    for (const minutes of byWeek.values()) expect(minutes).toBeLessThanOrEqual(600);
  });

  test("RUNSAFE rule: no long run exceeds 110 percent of the trailing 30-day longest", () => {
    const longRuns = plan
      .filter((s) => s.sport === "run" && s.title.startsWith("Long run"))
      .sort((a, b) => a.planDay.localeCompare(b.planDay));
    expect(longRuns.length).toBe(12);
    for (const run of longRuns) {
      const cutoff = new Date(`${run.planDay}T00:00:00Z`).getTime() - 30 * 86400000;
      const trailing = longRuns.filter(
        (r) =>
          r.planDay < run.planDay && new Date(`${r.planDay}T00:00:00Z`).getTime() >= cutoff,
      );
      if (trailing.length === 0) continue;
      const maxPrior = Math.max(...trailing.map((r) => r.distanceM ?? 0));
      expect(run.distanceM ?? 0).toBeLessThanOrEqual(maxPrior * 1.1);
    }
  });

  test("every bike session carries a planned TSS and a watt-grounded target", () => {
    for (const s of plan.filter((p) => p.sport === "bike")) {
      expect(s.tssPlanned).not.toBeNull();
      expect(s.target).toMatch(/W/);
    }
  });

  test("no em or en dash in any seeded string", () => {
    for (const s of plan) {
      const joined = s.title + s.detail + (s.target ?? "");
      expect(/[—–]/.test(joined)).toBe(false);
    }
  });

  test("plan starts on the designed Monday", () => {
    expect(PLAN_START).toBe("2026-08-03");
    expect(WEEK_TABLE).toHaveLength(12);
    expect(plan[0]!.planDay).toBe("2026-08-03");
  });
});

describe("seed script", () => {
  const env = { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH as string };
  const run = (args: string[] = []) =>
    Bun.spawnSync(["bun", "bin/seed-plan.ts", ...args], { env, cwd: `${import.meta.dir}/..` });

  test("seeds 99 rows into an empty table, refuses a second run, reseeds with --force", () => {
    const first = run();
    expect(first.exitCode).toBe(0);
    const n1 = (db.query("SELECT COUNT(*) AS n FROM planned_workouts").get() as { n: number }).n;
    expect(n1).toBe(99);

    const second = run();
    expect(second.exitCode).toBe(1);
    const n2 = (db.query("SELECT COUNT(*) AS n FROM planned_workouts").get() as { n: number }).n;
    expect(n2).toBe(99);

    const forced = run(["--force"]);
    expect(forced.exitCode).toBe(0);
    const n3 = (db.query("SELECT COUNT(*) AS n FROM planned_workouts").get() as { n: number }).n;
    expect(n3).toBe(99);
  });
});

describe("GET /api/plan/summary", () => {
  test("completion percent measures done minutes against the calendar so far", async () => {
    insertPlanned({ plan_day: "2020-01-06", duration_min: 60, status: "done" });
    insertPlanned({ plan_day: "2020-01-07", duration_min: 60, status: "planned" });
    insertPlanned({ plan_day: "2099-01-04", duration_min: 999, status: "planned" });
    const res = await apiRequest("GET", "/api/plan/summary", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { completionPercent: number; plannedMinutes: number };
    expect(body.plannedMinutes).toBe(1119);
    expect(body.completionPercent).toBe(50);
  });

  test("nextSession is the earliest upcoming planned non-rest session", async () => {
    const today = new Date().toISOString().slice(0, 10);
    insertPlanned({ plan_day: "2099-01-05", title: "Later ride" });
    insertPlanned({ plan_day: "2099-01-04", title: "Rest + daily ATG mobility", sport: "rest" });
    insertPlanned({ plan_day: "2099-01-04", title: "Sooner run", sport: "run" });
    insertPlanned({ plan_day: "2000-01-01", title: "Ancient ride" });
    const res = await apiRequest("GET", "/api/plan/summary", { token });
    const body = (await res.json()) as { nextSession: { title: string } | null };
    expect(body.nextSession?.title).toBe("Sooner run");
    expect(today.length).toBe(10);
  });

  test("summary exposes zones derived from the measured numbers", async () => {
    const res = await apiRequest("GET", "/api/plan/summary", { token });
    const body = (await res.json()) as {
      zonesPower: { zone: string; range: string }[];
      zonesHr: { zone: string; range: string }[];
    };
    expect(body.zonesPower.find((z) => z.zone.startsWith("Z2"))?.range).toBe("95 to 127 W");
    expect(body.zonesHr.find((z) => z.zone === "Z2")?.range).toBe("157 to 165 bpm");
  });
});
