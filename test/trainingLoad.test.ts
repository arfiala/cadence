// Training-load engine tests (ISC-136..147). Pure computation, zero network.
// Covers the tiered per-activity model, the Coggan TSS worked example, the
// intensity-factor estimate flag, the Fitness/Fatigue/Form impulse-response
// series against a hand-computed sequence, DST-safe daily bucketing, and the
// no-stale-cache edit-then-read behaviour.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { activityLoad, DURATION_TIER_IF } from "../src/metrics/trainingLoad";
import { computeDailySeries, currentWeekLoad, eachNyDay } from "../src/metrics/series";
import { resetDb } from "./helpers";

beforeEach(() => resetDb());

// Insert one activity with full control over the power/HR fields.
function insert(fields: {
  start_time: string;
  duration_s: number;
  sport?: string;
  avg_hr?: number | null;
  avg_power?: number | null;
  norm_power?: number | null;
}): number {
  const row = db
    .query(
      `INSERT INTO activities (source, sport, start_time, duration_s, avg_hr, avg_power, norm_power)
       VALUES ('manual', ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      fields.sport ?? "cycling",
      fields.start_time,
      fields.duration_s,
      fields.avg_hr ?? null,
      fields.avg_power ?? null,
      fields.norm_power ?? null,
    ) as { id: number };
  return row.id;
}

describe("tiered per-activity load (ISC-136)", () => {
  test("power tier when a power number and FTP are present", () => {
    const l = activityLoad(
      { durationSeconds: 3600, avgHr: 150, avgPower: 200, normPower: 210 },
      { ftpWatts: 250, lthrBpm: 160 },
    );
    expect(l.tier).toBe("power");
  });

  test("hr tier when power is absent but avg HR and LTHR are present", () => {
    const l = activityLoad(
      { durationSeconds: 3600, avgHr: 150, avgPower: null, normPower: null },
      { ftpWatts: 250, lthrBpm: 150 },
    );
    expect(l.tier).toBe("hr");
    expect(l.load).toBe(100); // IF 1.0, one hour → 100
  });

  test("duration tier when neither power nor HR thresholds apply", () => {
    const l = activityLoad(
      { durationSeconds: 3600, avgHr: null, avgPower: null, normPower: null },
      { ftpWatts: null, lthrBpm: null },
    );
    expect(l.tier).toBe("duration");
    expect(l.load).toBe(49); // 0.7^2 * 100
    expect(l.intensityFactor).toBe(DURATION_TIER_IF);
  });
});

describe("Coggan power TSS (ISC-137)", () => {
  test("one hour at exactly FTP scores 100", () => {
    const l = activityLoad(
      { durationSeconds: 3600, avgHr: null, avgPower: null, normPower: 250 },
      { ftpWatts: 250, lthrBpm: null },
    );
    expect(l.load).toBe(100);
    expect(l.intensityFactor).toBe(1);
  });

  test("two hours at NP 150 with FTP 200 scores 112.5", () => {
    const l = activityLoad(
      { durationSeconds: 7200, avgHr: null, avgPower: null, normPower: 150 },
      { ftpWatts: 200, lthrBpm: null },
    );
    expect(l.load).toBe(112.5);
    expect(l.intensityFactor).toBe(0.75);
  });
});

describe("intensity factor & estimate flag (ISC-138)", () => {
  test("IF uses normalized power when present, not flagged as estimate", () => {
    const l = activityLoad(
      { durationSeconds: 3600, avgHr: null, avgPower: 200, normPower: 220 },
      { ftpWatts: 275, lthrBpm: null },
    );
    expect(l.intensityFactor).toBe(0.8); // 220/275
    expect(l.estimated).toBe(false);
  });

  test("falls back to average power when NP absent and flags an estimate", () => {
    const l = activityLoad(
      { durationSeconds: 3600, avgHr: null, avgPower: 200, normPower: null },
      { ftpWatts: 250, lthrBpm: null },
    );
    expect(l.intensityFactor).toBe(0.8); // 200/250
    expect(l.estimated).toBe(true);
  });
});

describe("Fitness / Fatigue / Form series (ISC-139, ISC-140)", () => {
  test("matches a hand-computed 3-day series including a zero-load rest day", () => {
    // Duration tier (no thresholds): 2h → load 98, 1h → load 49.
    insert({ start_time: "2026-07-13T12:00:00Z", duration_s: 7200 }); // Mon, load 98
    // 2026-07-14 has NO activity → a zero-load day that must still appear.
    insert({ start_time: "2026-07-15T12:00:00Z", duration_s: 3600 }); // Wed, load 49

    const series = computeDailySeries(
      { ftpWatts: null, lthrBpm: null },
      { end: new Date("2026-07-15T23:00:00Z") },
    );
    expect(series.map((p) => p.date)).toEqual(["2026-07-13", "2026-07-14", "2026-07-15"]);
    expect(series.map((p) => p.load)).toEqual([98, 0, 49]);

    // Hand-computed impulse response (CTL tc=42, ATL tc=7, seeded at 0):
    expect(series[0]).toMatchObject({ fitness: 2.3, fatigue: 14, form: 0 });
    expect(series[1]).toMatchObject({ fitness: 2.3, fatigue: 12, form: -11.7 });
    expect(series[2]).toMatchObject({ fitness: 3.4, fatigue: 17.3, form: -9.7 });
  });

  test("Form on day one is zero (yesterday's fitness minus fatigue, both 0)", () => {
    insert({ start_time: "2026-07-13T12:00:00Z", duration_s: 3600 });
    const series = computeDailySeries(
      { ftpWatts: null, lthrBpm: null },
      { end: new Date("2026-07-13T20:00:00Z") },
    );
    expect(series[0]!.form).toBe(0);
  });
});

describe("DST-safe daily bucketing (ISC-147)", () => {
  test("eachNyDay crosses spring-forward without dropping or duplicating a day", () => {
    // US spring-forward 2026 is 2026-03-08 02:00.
    expect(eachNyDay("2026-03-07", "2026-03-09")).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });

  test("an instant just before the transition buckets to the New York calendar day", () => {
    // 2026-03-08T04:30Z is still 2026-03-07 23:30 in New York (EST, UTC-5).
    insert({ start_time: "2026-03-08T04:30:00Z", duration_s: 3600 });
    const series = computeDailySeries(
      { ftpWatts: null, lthrBpm: null },
      { end: new Date("2026-03-08T04:30:00Z") },
    );
    expect(series[0]!.date).toBe("2026-03-07");
    expect(series[0]!.load).toBe(49);
  });
});

describe("edit/delete reflected on next read (ISC-143)", () => {
  test("changing a duration changes the computed load with no stale cache", () => {
    const id = insert({ start_time: "2026-07-13T12:00:00Z", duration_s: 3600 });
    const first = computeDailySeries(
      { ftpWatts: null, lthrBpm: null },
      { end: new Date("2026-07-13T20:00:00Z") },
    );
    expect(first[0]!.load).toBe(49);

    db.query("UPDATE activities SET duration_s = 7200 WHERE id = ?").run(id);
    const second = computeDailySeries(
      { ftpWatts: null, lthrBpm: null },
      { end: new Date("2026-07-13T20:00:00Z") },
    );
    expect(second[0]!.load).toBe(98);
  });

  test("deleting the only activity yields an empty series", () => {
    const id = insert({ start_time: "2026-07-13T12:00:00Z", duration_s: 3600 });
    db.query("DELETE FROM activities WHERE id = ?").run(id);
    const series = computeDailySeries({ ftpWatts: null, lthrBpm: null });
    expect(series).toEqual([]);
  });
});

describe("graceful degradation without thresholds (ISC-144)", () => {
  test("duration-tier load still computes when FTP and LTHR are unset", () => {
    insert({ start_time: "2026-07-13T12:00:00Z", duration_s: 3600, avg_hr: 150 });
    const series = computeDailySeries(
      { ftpWatts: null, lthrBpm: null },
      { end: new Date("2026-07-13T20:00:00Z") },
    );
    expect(series[0]!.load).toBe(49); // still a real number, tier fell back
  });
});

describe("current week load (ISC-145 backing)", () => {
  test("sums the load of the current Monday-anchored week", () => {
    insert({ start_time: "2026-07-13T12:00:00Z", duration_s: 3600 }); // Mon, load 49
    insert({ start_time: "2026-07-15T12:00:00Z", duration_s: 3600 }); // Wed, load 49
    const total = currentWeekLoad({ ftpWatts: null, lthrBpm: null }, new Date("2026-07-15T20:00:00Z"));
    expect(total).toBe(98);
  });
});
