// Personal records + G1 streaks (ISC-172..179) and the two quick-log rules the
// records feature shares: delete-by-returned-id (undo) targets the exact row
// (ISC-159), and a stretch preset (sport=strength) never counts toward G1
// (ISC-164). Fixtures only.

import { test, expect, describe, beforeEach } from "bun:test";
import { resetDb, insertActivity, apiRequest, seedUser, seedToken } from "./helpers";
import {
  computeRecords,
  computeStreaks,
  computePointRecords,
  newRecordsInWeek,
} from "../src/metrics/records";
import { startOfWeek, endOfWeek } from "../src/week";
import type { ActivityRow } from "../src/db";
import { db } from "../src/db";

beforeEach(() => resetDb());

// Insert five 2h cycling sessions on one Monday = a week that meets G1
// (5 sessions, 10h >= 8h).
function insertMetWeek(mondayIso: string): void {
  for (let i = 0; i < 5; i++) {
    insertActivity({ sport: "cycling", start_time: mondayIso, duration_s: 7200 });
  }
}

const NOW = new Date("2026-07-15T12:00:00Z"); // Wed; current week starts Mon 07-13

describe("point records (ISC-172, ISC-173, ISC-174, ISC-177)", () => {
  test("longest ride, longest distance, and longest swim carry their date", () => {
    insertActivity({ sport: "cycling", start_time: "2026-05-01T10:00:00Z", duration_s: 3600, distance_m: 20000 });
    insertActivity({ sport: "virtual_cycling", start_time: "2026-05-08T10:00:00Z", duration_s: 7200, distance_m: 50000 });
    insertActivity({ sport: "swimming", start_time: "2026-05-09T10:00:00Z", duration_s: 1800, distance_m: 1500 });

    const { records } = computeRecords(NOW);
    expect(records.longest_ride?.value_s).toBe(7200);
    expect(records.longest_ride?.date).toBe("2026-05-08");
    expect(records.longest_distance_ride?.distance_m).toBe(50000);
    expect(records.longest_swim?.value_s).toBe(1800);
    expect(records.longest_swim?.date).toBe("2026-05-09");
  });

  test("honest empty: no swims yields longest_swim null, never fabricated", () => {
    insertActivity({ sport: "cycling", start_time: "2026-05-01T10:00:00Z", duration_s: 3600, distance_m: 20000 });
    const { records } = computeRecords(NOW);
    expect(records.longest_swim).toBeNull();
  });

  test("fastest ride obeys the 10km floor and excludes zero/null distance (ISC-177)", () => {
    // 5km in 10min = 30 km/h but BELOW the 10km floor -> ignored.
    insertActivity({ sport: "cycling", start_time: "2026-05-01T10:00:00Z", duration_s: 600, distance_m: 5000 });
    // 12km in 30min = 24 km/h, above the floor -> the record.
    insertActivity({ sport: "cycling", start_time: "2026-05-02T10:00:00Z", duration_s: 1800, distance_m: 12000 });
    // Same fast pace but null distance -> excluded from every distance record.
    insertActivity({ sport: "virtual_cycling", start_time: "2026-05-03T10:00:00Z", duration_s: 600, distance_m: null });

    const { records } = computeRecords(NOW);
    expect(records.fastest_ride).not.toBeNull();
    expect(records.fastest_ride?.distance_m).toBe(12000);
    expect(records.fastest_ride?.speed_kmh).toBe(24);
  });

  test("no rides above the floor yields a null fastest record", () => {
    insertActivity({ sport: "cycling", start_time: "2026-05-01T10:00:00Z", duration_s: 600, distance_m: 5000 });
    const { records } = computeRecords(NOW);
    expect(records.fastest_ride).toBeNull();
  });
});

describe("G1 streaks (ISC-175)", () => {
  test("the in-progress week is never counted and is reported separately", () => {
    // Two consecutive completed met weeks, plus a met CURRENT week.
    insertMetWeek("2026-06-29T12:00:00Z");
    insertMetWeek("2026-07-06T12:00:00Z");
    insertMetWeek("2026-07-13T12:00:00Z"); // current (in-progress) week

    const { streak } = computeRecords(NOW);
    expect(streak.current_weeks).toBe(2); // NOT 3 — current week excluded
    expect(streak.longest_weeks).toBe(2);
    expect(streak.in_progress.week_start).toBe("2026-07-13");
    expect(streak.in_progress.met).toBe(true);
  });

  test("a zero-activity completed week breaks the streak", () => {
    insertMetWeek("2026-06-22T12:00:00Z");
    // 2026-06-29 left empty on purpose.
    insertMetWeek("2026-07-06T12:00:00Z");

    const s = computeStreaks(NOW);
    expect(s.longest_weeks).toBe(1);
    expect(s.current_weeks).toBe(1); // only the last completed met week
  });

  test("a completed week short of target breaks the streak and zeroes current", () => {
    insertMetWeek("2026-06-29T12:00:00Z");
    // Last completed week (07-06) has only 2 sessions -> not met.
    insertActivity({ sport: "cycling", start_time: "2026-07-06T12:00:00Z", duration_s: 7200 });
    insertActivity({ sport: "cycling", start_time: "2026-07-07T12:00:00Z", duration_s: 7200 });

    const s = computeStreaks(NOW);
    expect(s.current_weeks).toBe(0);
    expect(s.longest_weeks).toBe(1);
  });
});

describe("newRecordsInWeek (digest PR diff, ISC-181)", () => {
  test("flags only records that strictly improved during the week", () => {
    // Prior best ride: 60 min.
    insertActivity({ sport: "cycling", start_time: "2026-06-01T10:00:00Z", duration_s: 3600, distance_m: 20000 });
    // During the target week: a 90 min ride (new longest) that same-or-longer.
    const weekStart = startOfWeek(new Date("2026-07-08T12:00:00Z"));
    const weekEnd = endOfWeek(weekStart);
    insertActivity({ sport: "cycling", start_time: "2026-07-08T10:00:00Z", duration_s: 5400, distance_m: 25000 });

    const prs = newRecordsInWeek(weekStart, weekEnd);
    const types = prs.map((p) => p.type);
    expect(types).toContain("longest_ride");
    expect(types).toContain("longest_distance_ride");
  });

  test("no PRs when the week only ties or trails prior bests", () => {
    insertActivity({ sport: "cycling", start_time: "2026-06-01T10:00:00Z", duration_s: 7200, distance_m: 50000 });
    const weekStart = startOfWeek(new Date("2026-07-08T12:00:00Z"));
    const weekEnd = endOfWeek(weekStart);
    insertActivity({ sport: "cycling", start_time: "2026-07-08T10:00:00Z", duration_s: 3600, distance_m: 20000 });

    const prs = newRecordsInWeek(weekStart, weekEnd);
    expect(prs.map((p) => p.type)).not.toContain("longest_ride");
  });
});

describe("computePointRecords is a pure function of its rows", () => {
  test("empty rows yield all-null records", () => {
    const rec = computePointRecords([] as ActivityRow[]);
    expect(rec.longest_ride).toBeNull();
    expect(rec.longest_distance_ride).toBeNull();
    expect(rec.fastest_ride).toBeNull();
    expect(rec.longest_swim).toBeNull();
  });
});

describe("undo-by-id and stretch G1 exclusion (ISC-159, ISC-164)", () => {
  beforeEach(async () => {
    await seedUser();
  });

  test("deleting by the returned id removes exactly that activity, not the newest", async () => {
    const token = seedToken();
    const first = await apiRequest("POST", "/api/activities", {
      token,
      body: { sport: "virtual_cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 1800, title: "Trainer ride" },
    });
    const firstId = ((await first.json()) as { activity: { id: number } }).activity.id;
    const second = await apiRequest("POST", "/api/activities", {
      token,
      body: { sport: "swimming", start_time: "2026-07-14T11:00:00Z", duration_s: 2700, title: "Swim" },
    });
    const secondId = ((await second.json()) as { activity: { id: number } }).activity.id;

    // Undo the FIRST activity by its id while the second is the newest row.
    const del = await apiRequest("DELETE", `/api/activities/${firstId}`, { token });
    expect(del.status).toBe(200);

    const remaining = db.query("SELECT id FROM activities").all() as { id: number }[];
    expect(remaining.map((r) => r.id)).toEqual([secondId]);
  });

  test("a stretch preset (sport=strength) never counts toward G1 sessions", async () => {
    const token = seedToken();
    // The stretch preset payload.
    await apiRequest("POST", "/api/activities", {
      token,
      body: { sport: "strength", start_time: "2026-07-14T09:00:00Z", duration_s: 900, title: "ATG Daily Stretch" },
    });
    // One real qualifying session the same week.
    await apiRequest("POST", "/api/activities", {
      token,
      body: { sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 },
    });

    const res = await apiRequest("GET", "/api/week?date=2026-07-14T12:00:00Z", { token });
    const week = (await res.json()) as { sessions: number };
    expect(week.sessions).toBe(1); // strength excluded, only cycling counts
  });
});
