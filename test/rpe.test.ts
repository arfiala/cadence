// RPE + sRPE load-tier tests (ISC-296..305). Covers the sRPE golden vector, the
// tier precedence (power > hr > srpe > duration) and its two regression pins:
// (a) activities without rpe produce a byte-identical series; (b) setting rpe on
// a power-tiered or hr-tiered activity changes nothing. Also the PATCH route
// validation, the survives-resync guarantee, and the MCP edit_activity path.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { activityLoad } from "../src/metrics/trainingLoad";
import { computeDailySeries } from "../src/metrics/series";
import { runSyncOnce } from "../src/garmin/sync";
import type { GarminClient, GarminActivity } from "../src/garmin/types";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";
import { CadenceClient } from "../mcp/client";
import { callTool } from "../mcp/tools";
import { fetchHandler } from "../src/server";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function garminActivity(over: Partial<GarminActivity> = {}): GarminActivity {
  return {
    garminId: "G-RPE-1",
    typeKey: "cycling",
    title: "Ride",
    startTimeUtc: "2026-07-14T10:00:00.000Z",
    durationSeconds: 3600,
    distanceMeters: 20000,
    calories: 500,
    avgHr: null,
    avgPower: null,
    normPower: null,
    ...over,
  };
}

function activitiesClient(list: GarminActivity[]): GarminClient {
  return { async listRecentActivities() { return list; } };
}

describe("sRPE tier golden vector (ISC-300)", () => {
  test("rpe 7 for 60 min scores 49.0 on the srpe tier", () => {
    const l = activityLoad(
      { durationSeconds: 3600, avgHr: null, avgPower: null, normPower: null, rpe: 7 },
      { ftpWatts: null, lthrBpm: null },
    );
    expect(l.tier).toBe("srpe");
    expect(l.load).toBe(49);
    expect(l.intensityFactor).toBe(0.7);
  });

  test("srpe is only reached when neither power nor HR applies (ISC-299)", () => {
    // Duration present, rpe present, no power/HR data or thresholds → srpe.
    const l = activityLoad(
      { durationSeconds: 1800, avgHr: null, avgPower: null, normPower: null, rpe: 5 },
      { ftpWatts: 250, lthrBpm: 160 },
    );
    expect(l.tier).toBe("srpe");
    // (5/10)^2 * 100 * 0.5h = 0.25*100*0.5 = 12.5
    expect(l.load).toBe(12.5);
  });
});

describe("tier precedence power > hr > srpe > duration (ISC-301, ISC-302)", () => {
  test("rpe on a POWER-tiered activity changes nothing", () => {
    const base = { durationSeconds: 3600, avgHr: 150, avgPower: 200, normPower: 210 };
    const thr = { ftpWatts: 250, lthrBpm: 160 };
    const without = activityLoad({ ...base, rpe: null }, thr);
    const withRpe = activityLoad({ ...base, rpe: 2 }, thr);
    expect(without.tier).toBe("power");
    expect(withRpe.tier).toBe("power");
    expect(withRpe.load).toBe(without.load);
    expect(withRpe.intensityFactor).toBe(without.intensityFactor);
  });

  test("rpe on an HR-tiered activity changes nothing", () => {
    const base = { durationSeconds: 3600, avgHr: 150, avgPower: null, normPower: null };
    const thr = { ftpWatts: null, lthrBpm: 150 };
    const without = activityLoad({ ...base, rpe: null }, thr);
    const withRpe = activityLoad({ ...base, rpe: 9 }, thr);
    expect(without.tier).toBe("hr");
    expect(withRpe.tier).toBe("hr");
    expect(withRpe.load).toBe(without.load);
  });
});

describe("series regression without rpe (ISC-302)", () => {
  test("a no-rpe history yields a byte-identical series before and after the rpe column existed", () => {
    insertActivity({ sport: "cycling", start_time: "2026-07-13T12:00:00Z", duration_s: 7200 });
    insertActivity({ sport: "swimming", start_time: "2026-07-15T12:00:00Z", duration_s: 3600 });
    const series = computeDailySeries(
      { ftpWatts: null, lthrBpm: null },
      { end: new Date("2026-07-15T23:00:00Z") },
    );
    // Same numbers the pre-rpe trainingLoad test pins: duration tier, 2h=98, 1h=49.
    expect(series.map((p) => p.load)).toEqual([98, 0, 49]);
    expect(series[2]).toMatchObject({ fitness: 3.4, fatigue: 17.3, form: -9.7 });
  });
});

describe("PATCH route rpe validation (ISC-297)", () => {
  test("accepts 1..10, accepts null to clear, rejects out of range", async () => {
    const id = insertActivity({ sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });

    const ok = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { rpe: 8 } });
    expect(ok.status).toBe(200);
    expect((db.query("SELECT rpe FROM activities WHERE id=?").get(id) as { rpe: number }).rpe).toBe(8);

    const cleared = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { rpe: null } });
    expect(cleared.status).toBe(200);
    expect((db.query("SELECT rpe FROM activities WHERE id=?").get(id) as { rpe: number | null }).rpe).toBeNull();

    for (const bad of [0, 11, 5.5, -3, "7"]) {
      const res = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { rpe: bad } });
      expect(res.status).toBe(400);
    }
  });

  test("rpe is echoed in the activity serialization", async () => {
    const id = insertActivity({ sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600, rpe: 6 });
    const res = await apiRequest("GET", "/api/activities", { token });
    const body = (await res.json()) as { activities: { id: number; rpe: number | null }[] };
    const row = body.activities.find((a) => a.id === id);
    expect(row?.rpe).toBe(6);
  });
});

describe("rpe survives Garmin re-sync (ISC-298)", () => {
  test("an rpe set by the user is not clobbered by a later sync", async () => {
    // First sync creates the Garmin row.
    await runSyncOnce(activitiesClient([garminActivity()]));
    const id = (db.query("SELECT id FROM activities WHERE garmin_id='G-RPE-1'").get() as { id: number }).id;

    // User sets an RPE via the API.
    await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { rpe: 7 } });
    expect((db.query("SELECT rpe FROM activities WHERE id=?").get(id) as { rpe: number }).rpe).toBe(7);

    // Re-sync the same activity (even with changed Garmin numbers): rpe stays.
    await runSyncOnce(activitiesClient([garminActivity({ durationSeconds: 3700 })]));
    const after = db.query("SELECT rpe, duration_s FROM activities WHERE id=?").get(id) as {
      rpe: number;
      duration_s: number;
    };
    expect(after.rpe).toBe(7); // preserved by construction (sync never writes rpe)
    expect(after.duration_s).toBe(3700); // Garmin still owns the numbers
  });
});

describe("MCP edit_activity accepts rpe (ISC-305)", () => {
  test("editing rpe through the tool writes the DB row", async () => {
    const server = Bun.serve({ port: 0, fetch: (req) => fetchHandler(req, { requestIP: () => ({ address: "127.0.0.1" }) }) });
    try {
      const id = insertActivity({ sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
      const client = new CadenceClient({ url: `http://localhost:${server.port}`, token });
      const res = await callTool(client, "edit_activity", { id, fields: { rpe: 4 } });
      expect(res.isError).toBe(false);
      expect((db.query("SELECT rpe FROM activities WHERE id=?").get(id) as { rpe: number }).rpe).toBe(4);
    } finally {
      server.stop(true);
    }
  });
});
