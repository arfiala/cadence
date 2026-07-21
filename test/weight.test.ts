// Weight-progress tests: the raw ZwiftPower weight parse (string tuple), the
// sync storing weight on results, the computeWeightSeries reducer (per-day
// collapse, current/first/delta), and the GET /api/metrics/weight route
// (shape + auth gate). No live ZwiftPower login ever happens (ISC-129).

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import type { ZwiftPowerClient, ZwiftPowerResult } from "../src/zwiftpower/types";
import { runZpSyncOnce } from "../src/zwiftpower/sync";
import { toResult } from "../src/zwiftpower/client";
import { computeWeightSeries } from "../src/metrics/weight";
import { resetDb, seedUser, seedToken, apiRequest } from "./helpers";

beforeEach(() => {
  resetDb();
});

function result(over: Partial<ZwiftPowerResult> = {}): ZwiftPowerResult {
  return {
    eventId: "e1",
    eventDate: "2026-07-14T18:00:00.000Z",
    title: "Race",
    category: "D",
    position: 5,
    avgPower: 200,
    normPower: 220,
    timeSeconds: 1800,
    weightKg: 84.5,
    ...over,
  };
}

function mockClient(results: ZwiftPowerResult[]): ZwiftPowerClient {
  return {
    async listRiderResults() {
      return results;
    },
  };
}

describe("weight parse from raw ZwiftPower row", () => {
  test("weight arrives as a [\"84.5\", 0] string tuple and parses to 84.5", () => {
    const r = toResult({ zid: "9", event_date: 1780413000, weight: ["84.5", 0] });
    expect(r.weightKg).toBe(84.5);
  });

  test("a bare number weight also parses", () => {
    expect(toResult({ zid: "9", weight: 80 }).weightKg).toBe(80);
  });

  test("missing / zero / non-numeric weight becomes null, never a fabricated number", () => {
    expect(toResult({ zid: "9" }).weightKg).toBeNull();
    expect(toResult({ zid: "9", weight: ["0", 0] }).weightKg).toBeNull();
    expect(toResult({ zid: "9", weight: ["", 0] }).weightKg).toBeNull();
  });
});

describe("weight persisted through sync", () => {
  test("weight_kg is stored on the result row and re-sync is idempotent", async () => {
    await runZpSyncOnce(mockClient([result({ eventId: "x", weightKg: 84.5 })]));
    const row = db.query("SELECT weight_kg FROM zwiftpower_results WHERE event_id = ?").get("x") as { weight_kg: number };
    expect(row.weight_kg).toBe(84.5);

    // A changed weight on the same event updates the row.
    await runZpSyncOnce(mockClient([result({ eventId: "x", weightKg: 83.1 })]));
    const updated = db.query("SELECT weight_kg FROM zwiftpower_results WHERE event_id = ?").get("x") as { weight_kg: number };
    expect(updated.weight_kg).toBe(83.1);
    expect(db.query("SELECT COUNT(*) AS n FROM zwiftpower_results").get()).toEqual({ n: 1 });
  });
});

describe("computeWeightSeries", () => {
  test("empty when no rides carry weight", () => {
    const s = computeWeightSeries();
    expect(s.current).toBeNull();
    expect(s.first).toBeNull();
    expect(s.delta).toBeNull();
    expect(s.points).toEqual([]);
  });

  test("builds an oldest-first series with current/first/delta", async () => {
    await runZpSyncOnce(
      mockClient([
        result({ eventId: "a", eventDate: "2026-06-01T18:00:00.000Z", weightKg: 86.0 }),
        result({ eventId: "b", eventDate: "2026-07-01T18:00:00.000Z", weightKg: 85.0 }),
        result({ eventId: "c", eventDate: "2026-07-20T18:00:00.000Z", weightKg: 84.5 }),
      ]),
    );
    const s = computeWeightSeries();
    expect(s.points.length).toBe(3);
    expect(s.first).toBe(86.0);
    expect(s.current).toBe(84.5);
    expect(s.delta).toBe(-1.5); // lost 1.5 kg
    expect(s.points[0]!.weight_kg).toBe(86.0);
    expect(s.points[2]!.weight_kg).toBe(84.5);
  });

  test("collapses multiple rides on the same day to the latest weight that day", async () => {
    await runZpSyncOnce(
      mockClient([
        result({ eventId: "m1", eventDate: "2026-07-14T13:00:00.000Z", weightKg: 84.9 }),
        result({ eventId: "m2", eventDate: "2026-07-14T20:00:00.000Z", weightKg: 84.4 }),
      ]),
    );
    const s = computeWeightSeries();
    expect(s.points.length).toBe(1);
    expect(s.points[0]!.weight_kg).toBe(84.4);
  });

  test("rides without weight or date are excluded from the series", async () => {
    await runZpSyncOnce(
      mockClient([
        result({ eventId: "ok", eventDate: "2026-07-10T18:00:00.000Z", weightKg: 84.5 }),
        result({ eventId: "noweight", eventDate: "2026-07-11T18:00:00.000Z", weightKg: null }),
        result({ eventId: "nodate", eventDate: null, weightKg: 84.0 }),
      ]),
    );
    const s = computeWeightSeries();
    expect(s.points.length).toBe(1);
    expect(s.current).toBe(84.5);
  });
});

describe("GET /api/metrics/weight", () => {
  test("requires authentication", async () => {
    const res = await apiRequest("GET", "/api/metrics/weight");
    expect(res.status).toBe(401);
  });

  test("returns the series shape for an authed request", async () => {
    await runZpSyncOnce(mockClient([result({ eventId: "z", weightKg: 84.5 })]));
    await seedUser();
    const token = seedToken();
    const res = await apiRequest("GET", "/api/metrics/weight", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unit: string; current: number; points: unknown[] };
    expect(body.unit).toBe("kg");
    expect(body.current).toBe(84.5);
    expect(Array.isArray(body.points)).toBe(true);
  });
});
