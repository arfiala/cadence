// Garmin sleep sync + API tests (ISC-243..252). Exercises the sleep upsert
// path through the real sync engine against a MOCK GarminClient (the SDK is
// never touched), plus the read route. Covers: idempotent upsert keyed on
// calendar_date, change-detected updated_at, best-effort isolation (a sleep
// failure never fails an activity sync), the absent-capability path, ordering,
// and the serialized route shape + auth gate.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import type { GarminClient, GarminActivity, GarminSleep } from "../src/garmin/types";
import { GarminSyncError } from "../src/garmin/types";
import { runSyncOnce, getRecentSleep, _resetSyncState } from "../src/garmin/sync";
import type { SleepRow, SyncRunRow } from "../src/db";
import { resetDb, seedToken, seedUser, apiRequest } from "./helpers";

beforeEach(() => {
  resetDb();
  _resetSyncState();
});

function night(date: string, over: Partial<GarminSleep> = {}): GarminSleep {
  return {
    calendarDate: date,
    startTimeUtc: `${date}T02:48:00.000Z`,
    endTimeUtc: `${date}T11:30:00.000Z`,
    totalSleepSeconds: 25500, // 7h 05m
    deepSeconds: 4200,
    lightSeconds: 14700,
    remSeconds: 5700,
    awakeSeconds: 900,
    score: 78,
    ...over,
  };
}

// A client with both capabilities. Sleep defaults to two nights.
function client(opts: { activities?: GarminActivity[]; sleep?: GarminSleep[] } = {}): GarminClient {
  return {
    async listRecentActivities() {
      return opts.activities ?? [];
    },
    async listRecentSleep() {
      return opts.sleep ?? [night("2026-07-18"), night("2026-07-19")];
    },
  };
}

const ACTIVITY: GarminActivity = {
  garminId: "9001",
  typeKey: "lap_swimming",
  title: "Swim",
  startTimeUtc: "2026-07-19T12:00:00.000Z",
  durationSeconds: 2700,
  distanceMeters: 1500,
  calories: 350,
  avgHr: 138,
  avgPower: null,
  normPower: null,
};

function lastRun(): SyncRunRow {
  return db.query("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get() as SyncRunRow;
}

describe("sleep schema", () => {
  test("sleep table exists with the expected columns", () => {
    const cols = (db.query("PRAGMA table_info(sleep)").all() as { name: string }[]).map((c) => c.name);
    for (const col of ["calendar_date", "start_time", "end_time", "total_sleep_s", "deep_s", "light_s", "rem_s", "awake_s", "score"]) {
      expect(cols).toContain(col);
    }
  });

  test("sync_runs carries sleep tallies", () => {
    const cols = (db.query("PRAGMA table_info(sync_runs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("sleep_seen");
    expect(cols).toContain("sleep_new");
  });
});

describe("sleep sync", () => {
  test("stores each night and records the tally on the sync run", async () => {
    const outcome = await runSyncOnce(client());
    expect(outcome.status).toBe("success");
    expect(outcome.sleep_seen).toBe(2);
    expect(outcome.sleep_new).toBe(2);

    const rows = db.query("SELECT * FROM sleep ORDER BY calendar_date").all() as SleepRow[];
    expect(rows.length).toBe(2);
    const latest = rows[1]!;
    expect(latest.total_sleep_s).toBe(25500);
    expect(latest.deep_s).toBe(4200);
    expect(latest.score).toBe(78);

    const run = lastRun();
    expect(run.sleep_seen).toBe(2);
    expect(run.sleep_new).toBe(2);
  });

  test("re-syncing the same night is idempotent (one row, no new count)", async () => {
    await runSyncOnce(client({ sleep: [night("2026-07-19")] }));
    const second = await runSyncOnce(client({ sleep: [night("2026-07-19")] }));
    expect(db.query("SELECT COUNT(*) AS n FROM sleep").get()).toEqual({ n: 1 });
    expect(second.sleep_new).toBe(0);
  });

  test("an unchanged re-sync leaves updated_at untouched; a changed one bumps it", async () => {
    await runSyncOnce(client({ sleep: [night("2026-07-19")] }));
    const before = (db.query("SELECT updated_at FROM sleep WHERE calendar_date = ?").get("2026-07-19") as { updated_at: string }).updated_at;

    await runSyncOnce(client({ sleep: [night("2026-07-19")] })); // identical
    const unchanged = (db.query("SELECT updated_at FROM sleep WHERE calendar_date = ?").get("2026-07-19") as { updated_at: string }).updated_at;
    expect(unchanged).toBe(before);

    await runSyncOnce(client({ sleep: [night("2026-07-19", { totalSleepSeconds: 30000, score: 91 })] }));
    const row = db.query("SELECT * FROM sleep WHERE calendar_date = ?").get("2026-07-19") as SleepRow;
    expect(row.total_sleep_s).toBe(30000);
    expect(row.score).toBe(91);
    expect(row.updated_at >= before).toBe(true);
  });

  test("a sleep failure does NOT fail the activity sync (best-effort)", async () => {
    const c: GarminClient = {
      async listRecentActivities() {
        return [ACTIVITY];
      },
      async listRecentSleep() {
        throw new GarminSyncError("garmin sleep endpoint down");
      },
    };
    const outcome = await runSyncOnce(c);
    expect(outcome.status).toBe("success");
    expect(outcome.activities_new).toBe(1);
    expect(outcome.sleep_seen).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM sleep").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM activities").get()).toEqual({ n: 1 });
  });

  test("a client without the sleep capability syncs activities and skips sleep", async () => {
    const c: GarminClient = {
      async listRecentActivities() {
        return [ACTIVITY];
      },
    };
    const outcome = await runSyncOnce(c);
    expect(outcome.status).toBe("success");
    expect(outcome.sleep_seen).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM sleep").get()).toEqual({ n: 0 });
  });

  test("partial nights (null stages) are stored without inventing numbers", async () => {
    await runSyncOnce(
      client({ sleep: [night("2026-07-19", { deepSeconds: null, remSeconds: null, score: null })] }),
    );
    const row = db.query("SELECT * FROM sleep WHERE calendar_date = ?").get("2026-07-19") as SleepRow;
    expect(row.deep_s).toBeNull();
    expect(row.rem_s).toBeNull();
    expect(row.score).toBeNull();
    expect(row.total_sleep_s).toBe(25500);
  });
});

describe("getRecentSleep", () => {
  test("returns nights newest calendar_date first, respecting the limit", async () => {
    await runSyncOnce(
      client({ sleep: [night("2026-07-16"), night("2026-07-17"), night("2026-07-18"), night("2026-07-19")] }),
    );
    const rows = getRecentSleep(2);
    expect(rows.length).toBe(2);
    expect(rows[0]!.calendar_date).toBe("2026-07-19");
    expect(rows[1]!.calendar_date).toBe("2026-07-18");
  });
});

describe("GET /api/sleep", () => {
  test("requires authentication", async () => {
    const res = await apiRequest("GET", "/api/sleep");
    expect(res.status).toBe(401);
  });

  test("returns serialized nights newest first for an authed request", async () => {
    await runSyncOnce(client({ sleep: [night("2026-07-18"), night("2026-07-19")] }));
    await seedUser();
    const token = seedToken();
    const res = await apiRequest("GET", "/api/sleep", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nights: Array<Record<string, unknown>> };
    expect(body.nights.length).toBe(2);
    const newest = body.nights[0]!;
    expect(newest.date).toBe("2026-07-19");
    expect(newest).toHaveProperty("total_sleep_s", 25500);
    expect(newest).toHaveProperty("deep_s", 4200);
    expect(newest).toHaveProperty("score", 78);
  });

  test("clamps an absurd limit rather than erroring", async () => {
    await runSyncOnce(client({ sleep: [night("2026-07-19")] }));
    await seedUser();
    const token = seedToken();
    const res = await apiRequest("GET", "/api/sleep?limit=9999", { token });
    expect(res.status).toBe(200);
  });
});
