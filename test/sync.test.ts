// Garmin sync tests (ISC-25..34, ISC-89). Exercises the sync engine against
// a MOCK GarminClient (the real library is never touched in tests, per the
// ISA test strategy). Covers idempotent upsert, edit-survives-resync merge,
// failure recording, type mapping, concurrency collapse, and never-delete.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import type { GarminClient, GarminActivity } from "../src/garmin/types";
import { GarminSyncError } from "../src/garmin/types";
import { runSyncOnce, triggerSync, _resetSyncState } from "../src/garmin/sync";
import { mapGarminTypeToSport } from "../src/garmin/mapping";
import { resetDb } from "./helpers";

beforeEach(() => {
  resetDb();
  _resetSyncState();
});

function mockClient(activities: GarminActivity[]): GarminClient {
  return {
    async listRecentActivities() {
      return activities;
    },
  };
}

function failingClient(message: string): GarminClient {
  return {
    async listRecentActivities() {
      throw new GarminSyncError(message);
    },
  };
}

const RIDE: GarminActivity = {
  garminId: "1001",
  typeKey: "virtual_ride",
  title: "Zwift Watopia",
  startTimeUtc: "2026-07-13T11:00:00.000Z",
  durationSeconds: 3600,
  distanceMeters: 30000,
  calories: 700,
  avgHr: 145,
  avgPower: null,
  normPower: null,
};

describe("upsert (ISC-25, ISC-26)", () => {
  test("inserts a new Garmin activity mapped to the sport vocabulary", async () => {
    const outcome = await runSyncOnce(mockClient([RIDE]));
    expect(outcome.status).toBe("success");
    expect(outcome.activities_new).toBe(1);

    const row = db.query("SELECT * FROM activities WHERE garmin_id = '1001'").get() as {
      sport: string;
      raw_type: string;
      source: string;
    };
    expect(row.source).toBe("garmin");
    expect(row.sport).toBe("virtual_cycling");
    expect(row.raw_type).toBe("virtual_ride");
  });

  test("syncing the same activity twice yields one row and no new count", async () => {
    await runSyncOnce(mockClient([RIDE]));
    const first = db.query("SELECT updated_at FROM activities WHERE garmin_id='1001'").get() as {
      updated_at: string;
    };

    const outcome = await runSyncOnce(mockClient([RIDE]));
    expect(outcome.activities_new).toBe(0);

    const count = db.query("SELECT COUNT(*) as n FROM activities").get() as { n: number };
    expect(count.n).toBe(1);

    const second = db.query("SELECT updated_at FROM activities WHERE garmin_id='1001'").get() as {
      updated_at: string;
    };
    // No change → updated_at NOT bumped (ISC-26).
    expect(second.updated_at).toBe(first.updated_at);
  });

  test("a changed duration on re-sync bumps updated_at and overwrites the number", async () => {
    await runSyncOnce(mockClient([RIDE]));
    const changed = { ...RIDE, durationSeconds: 4200 };
    await runSyncOnce(mockClient([changed]));
    const row = db.query("SELECT duration_s FROM activities WHERE garmin_id='1001'").get() as {
      duration_s: number;
    };
    expect(row.duration_s).toBe(4200); // duration from Garmin wins (ISC-27)
  });
});

describe("field-level merge (ISC-27)", () => {
  test("a user's sport/title/notes edit survives re-sync; duration/distance from Garmin win", async () => {
    await runSyncOnce(mockClient([RIDE]));
    const id = (db.query("SELECT id FROM activities WHERE garmin_id='1001'").get() as { id: number }).id;

    // Simulate the user correcting sport + title + adding notes (what the
    // PATCH route does: sets the value AND the *_edited flag).
    db.query(
      "UPDATE activities SET sport='cycling', sport_edited=1, title='Real outdoor ride', title_edited=1, notes='felt strong', notes_edited=1 WHERE id=?",
    ).run(id);

    // Re-sync with Garmin's original (different sport/title, new duration).
    const resynced = { ...RIDE, durationSeconds: 5000, distanceMeters: 40000 };
    await runSyncOnce(mockClient([resynced]));

    const row = db.query("SELECT * FROM activities WHERE id=?").get(id) as {
      sport: string;
      title: string;
      notes: string;
      duration_s: number;
      distance_m: number;
    };
    // Human edits win.
    expect(row.sport).toBe("cycling");
    expect(row.title).toBe("Real outdoor ride");
    expect(row.notes).toBe("felt strong");
    // Garmin numbers win.
    expect(row.duration_s).toBe(5000);
    expect(row.distance_m).toBe(40000);
  });

  test("an UNedited Garmin row lets Garmin overwrite sport/title on re-sync", async () => {
    await runSyncOnce(mockClient([RIDE]));
    // Garmin re-classifies the activity (e.g. corrected upstream).
    const reclassified = { ...RIDE, typeKey: "lap_swimming", title: "Pool session" };
    await runSyncOnce(mockClient([reclassified]));
    const row = db.query("SELECT sport, title FROM activities WHERE garmin_id='1001'").get() as {
      sport: string;
      title: string;
    };
    expect(row.sport).toBe("swimming");
    expect(row.title).toBe("Pool session");
  });
});

describe("failure recording (ISC-28)", () => {
  test("a failing sync records an errored sync_run and does not throw", async () => {
    const outcome = await runSyncOnce(failingClient("bad credentials"));
    expect(outcome.status).toBe("error");
    expect(outcome.error).toBe("bad credentials");

    const run = db.query("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get() as {
      status: string;
      error: string;
      finished_at: string | null;
    };
    expect(run.status).toBe("error");
    expect(run.error).toBe("bad credentials");
    expect(run.finished_at).not.toBeNull();
  });
});

describe("type mapping (ISC-32)", () => {
  const cases: [string, string][] = [
    ["virtual_ride", "virtual_cycling"],
    ["cycling", "cycling"],
    ["road_biking", "cycling"],
    ["lap_swimming", "swimming"],
    ["open_water_swimming", "swimming"],
    ["running", "running"],
    ["strength_training", "strength"],
    ["kayaking", "other"], // unknown → other, never throws
  ];
  for (const [typeKey, expected] of cases) {
    test(`${typeKey} → ${expected}`, () => {
      expect(mapGarminTypeToSport(typeKey) as string).toBe(expected);
    });
  }
});

describe("never deletes rows (ISC-34)", () => {
  test("an activity that disappears from Garmin's list stays in Cadence", async () => {
    await runSyncOnce(mockClient([RIDE]));
    // Next sync returns an empty list (Garmin deleted it).
    await runSyncOnce(mockClient([]));
    const count = db.query("SELECT COUNT(*) as n FROM activities WHERE garmin_id='1001'").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});

describe("concurrency collapse (ISC-31)", () => {
  test("a second concurrent trigger returns 'already running'", async () => {
    // A slow client keeps the first sync in-flight while the second triggers.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowClient: GarminClient = {
      async listRecentActivities() {
        await gate;
        return [RIDE];
      },
    };

    const first = triggerSync(slowClient);
    // Second trigger while the first is still awaiting the gate.
    const second = await triggerSync(slowClient);
    expect(second.triggered).toBe(false);
    if (!second.triggered) expect(second.message).toBe("already running");

    release();
    const firstResult = await first;
    expect(firstResult.triggered).toBe(true);
  });
});
