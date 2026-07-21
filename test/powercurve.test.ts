// ZwiftPower power-curve tests (ISC-342..345). Covers the profile parse, the
// sync storing best efforts, the rolling-90-day read window, cycling-only
// scope, and the throwing-fake degrade-to-stored-data path. No live login: a
// mock ZwiftPowerClient only (ISC-129 discipline).

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { toPowerCurve } from "../src/zwiftpower/client";
import { runZpSyncOnce, _resetZpSyncState } from "../src/zwiftpower/sync";
import { computePowerCurve } from "../src/metrics/powerCurve";
import type { ZwiftPowerClient, ZwiftPowerCurvePoint } from "../src/zwiftpower/types";
import { resetDb } from "./helpers";

const NOW = new Date("2026-07-15T12:00:00Z");

beforeEach(() => {
  resetDb();
  _resetZpSyncState();
});

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 3600 * 1000).toISOString();
}

function curveClient(points: ZwiftPowerCurvePoint[], opts: { throwCurve?: boolean } = {}): ZwiftPowerClient {
  return {
    async listRiderResults() {
      return [];
    },
    async getPowerCurve() {
      if (opts.throwCurve) throw new Error("ZwiftPower critical-power request failed");
      return points;
    },
  };
}

describe("toPowerCurve profile parse (ISC-342)", () => {
  test("maps the efforts.watts series to the tracked durations, ignoring others", () => {
    const profile = {
      efforts: {
        watts: [
          { x: 5, y: 900, date: 1_750_000_000, zid: "e0" }, // untracked duration, ignored
          { x: 15, y: 820, date: 1_750_000_000, zid: "e1" },
          { x: 60, y: 410, date: 1_750_000_100, zid: "e2" },
          { x: 300, y: 305, date: 1_750_000_200, zid: "e3" },
          { x: 1200, y: 255, date: 1_750_000_300, zid: "e4" },
        ],
      },
    };
    const points = toPowerCurve(profile);
    expect(points.map((p) => p.durationSeconds)).toEqual([15, 60, 300, 1200]);
    expect(points[0]).toMatchObject({ durationSeconds: 15, watts: 820, eventId: "e1" });
    expect(points[0]?.eventDate).toBe(new Date(1_750_000_000 * 1000).toISOString());
  });

  test("odd payloads never throw and yield an empty curve", () => {
    expect(() => toPowerCurve(null)).not.toThrow();
    expect(toPowerCurve({ nonsense: 1 })).toEqual([]);
  });
});

describe("sync stores efforts, read rolls 90 days (ISC-343)", () => {
  test("a sync upserts best efforts and the read returns them cycling-only", async () => {
    const points: ZwiftPowerCurvePoint[] = [
      { durationSeconds: 15, watts: 800, eventDate: isoDaysAgo(10), eventId: "r1" },
      { durationSeconds: 60, watts: 400, eventDate: isoDaysAgo(10), eventId: "r1" },
      { durationSeconds: 300, watts: 300, eventDate: isoDaysAgo(10), eventId: "r1" },
      { durationSeconds: 1200, watts: 250, eventDate: isoDaysAgo(10), eventId: "r1" },
    ];
    const outcome = await runZpSyncOnce(curveClient(points));
    expect(outcome.status).toBe("success");

    const curve = computePowerCurve(NOW);
    expect(curve.window_days).toBe(90);
    expect(curve.points.map((p) => p.duration_s)).toEqual([15, 60, 300, 1200]);
    expect(curve.points[0]).toMatchObject({ duration_s: 15, watts: 800, label: "15s", event_id: "r1" });
    // Cycling-only: no sport field, no swim/run contamination (ISC-345).
    expect(JSON.stringify(curve)).not.toContain("swim");
    expect(JSON.stringify(curve)).not.toContain("run");
  });

  test("an effort older than 90 days is excluded; a recent one wins", async () => {
    // Directly insert an old and a recent effort for the same duration.
    db.query(
      "INSERT INTO power_curve_efforts (duration_s, watts, event_date, event_id) VALUES (15, 950, ?, 'old')",
    ).run(isoDaysAgo(200));
    db.query(
      "INSERT INTO power_curve_efforts (duration_s, watts, event_date, event_id) VALUES (15, 810, ?, 'recent')",
    ).run(isoDaysAgo(5));

    const curve = computePowerCurve(NOW);
    const p15 = curve.points.find((p) => p.duration_s === 15)!;
    expect(p15.watts).toBe(810); // the 950W effort is outside the 90-day window
    expect(p15.event_id).toBe("recent");
  });

  test("idempotent: syncing the same effort twice keeps one row", async () => {
    const points: ZwiftPowerCurvePoint[] = [
      { durationSeconds: 15, watts: 800, eventDate: isoDaysAgo(10), eventId: "r1" },
    ];
    await runZpSyncOnce(curveClient(points));
    await runZpSyncOnce(curveClient(points));
    const n = (db.query("SELECT COUNT(*) AS n FROM power_curve_efforts WHERE duration_s=15").get() as { n: number }).n;
    expect(n).toBe(1);
  });
});

describe("degrade to stored data on ZP failure (ISC-344)", () => {
  test("a throwing power-curve fetch does not fail the sync and leaves stored data readable", async () => {
    // Seed a stored effort first.
    db.query(
      "INSERT INTO power_curve_efforts (duration_s, watts, event_date, event_id) VALUES (60, 420, ?, 'seed')",
    ).run(isoDaysAgo(5));

    const outcome = await runZpSyncOnce(curveClient([], { throwCurve: true }));
    expect(outcome.status).toBe("success"); // results sync unaffected by the curve failure

    const curve = computePowerCurve(NOW);
    const p60 = curve.points.find((p) => p.duration_s === 60)!;
    expect(p60.watts).toBe(420); // stored data still served
  });
});
