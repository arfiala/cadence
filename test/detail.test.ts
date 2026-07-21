// Lazy Garmin activity-detail tests (ISC-318..331). Drives getActivityDetail
// directly with a fake client so call counts, the no-login guarantee, the
// timeout race, and defensive parsing are all observable without a real Garmin
// session. Also covers the cascade delete, the manual-activity zero-fetch path,
// the refresh param, and the sync-does-no-detail-fetch invariant.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/db";
import { getActivityDetail } from "../src/routes/activityDetail";
import { parseGarminDetail, decimate, _resetDetailLogState } from "../src/garmin/detail";
import { runSyncOnce } from "../src/garmin/sync";
import type { GarminClient, GarminActivity } from "../src/garmin/types";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";

let token: string;
beforeEach(() => {
  resetDb();
  _resetDetailLogState();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});
afterEach(() => {
  delete process.env.CADENCE_DETAIL_TIMEOUT_MS;
});

// A fake client that records call counts and exposes a login spy that the
// detail path must NEVER invoke (ISC-330).
function spyClient(over: Partial<GarminClient> = {}) {
  const calls = { splits: 0, details: 0, login: 0 };
  const client: GarminClient & { calls: typeof calls; login: () => void } = {
    calls,
    login() { calls.login += 1; },
    async listRecentActivities() { return []; },
    async getSplits(id: string) {
      calls.splits += 1;
      return { lapDTOs: [{ duration: 600, distance: 5000, averageHR: 140, maxHR: 160, averagePower: 180 }] };
    },
    async getDetails(id: string) {
      calls.details += 1;
      return { summaryDTO: { maxHR: 175, maxPower: 320 }, geoPolylineDTO: { polyline: [{ lat: 40.1, lon: -74.2 }, { lat: 40.2, lon: -74.3 }] } };
    },
    ...over,
  };
  return client;
}

function url(id: number, qs = ""): URL {
  return new URL(`http://localhost/api/activities/${id}/detail${qs}`);
}

describe("lazy fetch + cache (ISC-319, ISC-326)", () => {
  test("first request fetches once and caches; second uses the cache", async () => {
    const id = insertActivity({ source: "garmin", garmin_id: "G100", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const client = spyClient();

    const first = await getActivityDetail(url(id), String(id), () => client);
    expect(first.status).toBe(200);
    const fbody = (await first.json()) as { detail: { laps: unknown[]; polyline: unknown[]; summary: { max_power: number } } };
    expect(fbody.detail.laps.length).toBe(1);
    expect(fbody.detail.summary.max_power).toBe(320);
    expect(client.calls.splits).toBe(1);
    expect(client.calls.details).toBe(1);

    // A cached row now exists; a second call does not fetch again.
    const second = await getActivityDetail(url(id), String(id), () => client);
    const sbody = (await second.json()) as { detail: { laps: unknown[] } };
    expect(sbody.detail.laps.length).toBe(1);
    expect(client.calls.splits).toBe(1); // unchanged
    expect(client.calls.details).toBe(1);
  });

  test("refresh=1 forces a re-fetch and updates fetched_at (ISC-326)", async () => {
    const id = insertActivity({ source: "garmin", garmin_id: "G101", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const client = spyClient();
    await getActivityDetail(url(id), String(id), () => client);
    const firstFetchedAt = (db.query("SELECT fetched_at FROM activity_details WHERE activity_id=?").get(id) as { fetched_at: string }).fetched_at;

    await new Promise((r) => setTimeout(r, 5));
    await getActivityDetail(url(id, "?refresh=1"), String(id), () => client);
    expect(client.calls.splits).toBe(2);
    const secondFetchedAt = (db.query("SELECT fetched_at FROM activity_details WHERE activity_id=?").get(id) as { fetched_at: string }).fetched_at;
    expect(secondFetchedAt >= firstFetchedAt).toBe(true);
  });
});

describe("manual activities never fetch (ISC-325)", () => {
  test("a manual activity returns detail:null with zero client calls", async () => {
    const id = insertActivity({ source: "manual", sport: "swimming", start_time: "2026-07-14T10:00:00Z", duration_s: 1800 });
    const client = spyClient();
    const res = await getActivityDetail(url(id), String(id), () => client);
    const body = (await res.json()) as { detail: null };
    expect(body.detail).toBeNull();
    expect(client.calls.splits).toBe(0);
    expect(client.calls.details).toBe(0);
  });
});

describe("failure + timeout + no-login (ISC-328, ISC-329, ISC-330)", () => {
  test("a throwing (unauthenticated) client yields detail_error:true, 200, and NO login attempt", async () => {
    const id = insertActivity({ source: "garmin", garmin_id: "G102", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const client = spyClient({
      async getSplits() { throw new Error("session could not be restored"); },
      async getDetails() { throw new Error("session could not be restored"); },
    });
    const res = await getActivityDetail(url(id), String(id), () => client);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detail: null; detail_error: boolean };
    expect(body.detail_error).toBe(true);
    expect(body.detail).toBeNull();
    expect(client.calls.login).toBe(0); // the detail path never logs in (ISC-330)
  });

  test("a hung Garmin call cannot hang the route (timeout race, ISC-329)", async () => {
    process.env.CADENCE_DETAIL_TIMEOUT_MS = "40";
    const id = insertActivity({ source: "garmin", garmin_id: "G103", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const client = spyClient({
      getSplits() { return new Promise(() => {}); }, // never resolves
      getDetails() { return new Promise(() => {}); },
    });
    const started = Date.now();
    const res = await getActivityDetail(url(id), String(id), () => client);
    expect(Date.now() - started).toBeLessThan(2000);
    const body = (await res.json()) as { detail_error: boolean };
    expect(body.detail_error).toBe(true);
  });
});

describe("cascade delete (ISC-327)", () => {
  test("deleting an activity removes its cached detail row", async () => {
    const id = insertActivity({ source: "garmin", garmin_id: "G104", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    await getActivityDetail(url(id), String(id), () => spyClient());
    expect((db.query("SELECT COUNT(*) AS n FROM activity_details WHERE activity_id=?").get(id) as { n: number }).n).toBe(1);

    const del = await apiRequest("DELETE", `/api/activities/${id}?confirm=true`, { token });
    expect(del.status).toBe(200);
    expect((db.query("SELECT COUNT(*) AS n FROM activity_details WHERE activity_id=?").get(id) as { n: number }).n).toBe(0);
  });
});

describe("list hints (ISC-331)", () => {
  test("list rows carry garmin_sourced and has_detail", async () => {
    const gId = insertActivity({ source: "garmin", garmin_id: "G105", sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    insertActivity({ source: "manual", sport: "swimming", start_time: "2026-07-13T10:00:00Z", duration_s: 1800 });
    await getActivityDetail(url(gId), String(gId), () => spyClient());

    const res = await apiRequest("GET", "/api/activities", { token });
    const body = (await res.json()) as { activities: { id: number; garmin_sourced: boolean; has_detail: boolean }[] };
    const g = body.activities.find((a) => a.id === gId)!;
    expect(g.garmin_sourced).toBe(true);
    expect(g.has_detail).toBe(true);
    const m = body.activities.find((a) => a.garmin_sourced === false)!;
    expect(m.has_detail).toBe(false);
  });
});

describe("defensive parsing (ISC-321, ISC-322, ISC-323, ISC-324)", () => {
  test("laps expose per-lap fields; missing fields degrade to null", () => {
    const detail = parseGarminDetail(
      { lapDTOs: [{ duration: 300, distance: 1000 }, { averageHR: 150 }] },
      {},
    );
    expect(detail.laps.length).toBe(2);
    expect(detail.laps[0]).toMatchObject({ lap_index: 1, duration_s: 300, distance_m: 1000, avg_hr: null });
    expect(detail.laps[1]).toMatchObject({ lap_index: 2, duration_s: null, avg_hr: 150 });
  });

  test("odd/unknown payloads never throw and yield an empty detail", () => {
    expect(() => parseGarminDetail(null, null)).not.toThrow();
    expect(() => parseGarminDetail("garbage", 42)).not.toThrow();
    const empty = parseGarminDetail(null, null);
    expect(empty.laps).toEqual([]);
    expect(empty.polyline).toEqual([]);
  });

  test("a GPS polyline is decimated to at most 200 points (ISC-324)", () => {
    const pts: [number, number][] = Array.from({ length: 5000 }, (_, i) => [40 + i / 10000, -74 - i / 10000]);
    const reduced = decimate(pts, 200);
    expect(reduced.length).toBe(200);
    expect(reduced[0]).toEqual(pts[0]!);
    expect(reduced[199]).toEqual(pts[4999]!);

    const detail = parseGarminDetail({}, { geoPolylineDTO: { polyline: pts.map(([lat, lon]) => ({ lat, lon })) } });
    expect(detail.polyline.length).toBe(200);
  });

  test("a non-empty payload that parses to all-null logs its key set once (ISC-322)", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    try {
      // Non-empty, but no recognized fields → all-null → one warning.
      parseGarminDetail({ mysteryKey: 1 }, { otherKey: 2 });
      parseGarminDetail({ mysteryKey: 3 }, { otherKey: 4 }); // second call must NOT log again
    } finally {
      console.warn = orig;
    }
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("mysteryKey");
  });
});

describe("sync performs zero detail fetches (ISC-320)", () => {
  test("a full Garmin sync never calls getSplits/getDetails", async () => {
    const client = spyClient({
      async listRecentActivities() {
        const a: GarminActivity = {
          garminId: "G200", typeKey: "cycling", title: "Ride",
          startTimeUtc: "2026-07-14T10:00:00.000Z", durationSeconds: 3600,
          distanceMeters: null, calories: null, avgHr: null, avgPower: null, normPower: null,
        };
        return [a];
      },
    });
    await runSyncOnce(client);
    expect(client.calls.splits).toBe(0);
    expect(client.calls.details).toBe(0);

    // Static guard: the sync source never imports the detail fetch path.
    const syncSrc = readFileSync(join(import.meta.dir, "..", "src", "garmin", "sync.ts"), "utf8");
    expect(syncSrc).not.toContain("getSplits");
    expect(syncSrc).not.toContain("getDetails");
    expect(syncSrc).not.toContain("activity_details");
  });
});
