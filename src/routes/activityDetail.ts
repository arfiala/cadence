// GET /api/activities/:id/detail (ISC-319, ISC-325..331). Returns the local
// activity row plus its cached Garmin detail (laps, decimated GPS polyline,
// summary). On the first request for a Garmin-sourced activity with no cache it
// lazily fetches getSplits + getDetails ONCE, parses defensively, decimates the
// polyline, and caches ONLY the validated normalized shape (never the raw
// payload). ?refresh=1 forces a re-fetch.
//
// Hard guarantees:
//   - Manual activities (no garmin id) never trigger a client call (ISC-325).
//   - The Garmin client is SESSION-RESTORE-ONLY here: an unauthenticated client
//     yields detail_error:true with HTTP 200 and NO login attempt (ISC-330).
//   - A 15s timeout race means a hung Garmin call cannot hang the route
//     (ISC-329); failure or timeout returns the local summary with
//     detail_error:true, still HTTP 200 (ISC-328).

import { db } from "../db";
import type { ActivityRow, ActivityDetailRow } from "../db";
import { jsonError } from "../lib/http";
import { serializeActivity } from "./activities";
import { parseGarminDetail } from "../garmin/detail";
import type { NormalizedDetail } from "../garmin/detail";
import type { GarminClient } from "../garmin/types";

const DEFAULT_DETAIL_FETCH_TIMEOUT_MS = 15_000;

// Read the timeout at call time (default 15s, ISC-329). Overridable via env so
// the timeout race can be exercised deterministically in tests without a 15s
// wall-clock wait; production never sets it.
function detailTimeoutMs(): number {
  const raw = Number(process.env.CADENCE_DETAIL_TIMEOUT_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DETAIL_FETCH_TIMEOUT_MS;
}

function parseId(idParam: string): number | null {
  const id = Number(idParam);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function cachedDetail(id: number): NormalizedDetail | null {
  const row = db
    .query("SELECT * FROM activity_details WHERE activity_id = ?")
    .get(id) as ActivityDetailRow | null;
  if (row === null) return null;
  return {
    laps: safeParse(row.laps_json, []),
    polyline: safeParse(row.polyline_json, []),
    summary: safeParse(row.detail_summary_json, {
      max_hr: null,
      max_power: null,
      elevation_gain_m: null,
    }),
  };
}

function safeParse<T>(json: string | null, fallback: T): T {
  if (json === null) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function cacheDetail(id: number, detail: NormalizedDetail): void {
  db.query(
    `INSERT INTO activity_details (activity_id, laps_json, polyline_json, detail_summary_json, fetched_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(activity_id) DO UPDATE SET
       laps_json = excluded.laps_json,
       polyline_json = excluded.polyline_json,
       detail_summary_json = excluded.detail_summary_json,
       fetched_at = excluded.fetched_at`,
  ).run(
    id,
    JSON.stringify(detail.laps),
    JSON.stringify(detail.polyline),
    JSON.stringify(detail.summary),
  );
}

// Fetch splits + details once, racing a timeout so a hung call cannot stall the
// route (ISC-329). Returns null on any failure/timeout; the caller turns that
// into detail_error:true.
async function fetchDetail(client: GarminClient, garminId: string): Promise<NormalizedDetail | null> {
  if (client.getSplits === undefined || client.getDetails === undefined) return null;
  try {
    const work = Promise.all([client.getSplits(garminId), client.getDetails(garminId)]);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("detail fetch timed out")), detailTimeoutMs()).unref(),
    );
    const [splits, details] = await Promise.race([work, timeout]);
    return parseGarminDetail(splits, details);
  } catch {
    return null;
  }
}

export async function getActivityDetail(
  url: URL,
  idParam: string,
  getClient: () => GarminClient,
): Promise<Response> {
  const id = parseId(idParam);
  if (id === null) return jsonError("Invalid activity id", 400);

  const activity = db.query("SELECT * FROM activities WHERE id = ?").get(id) as ActivityRow | null;
  if (activity === null) return jsonError("Activity not found", 404);

  const refresh = url.searchParams.get("refresh") === "1";

  // Manual activities carry no Garmin detail and NEVER trigger a fetch (ISC-325).
  if (activity.garmin_id === null) {
    return Response.json({ activity: serializeActivity(activity, false), detail: null });
  }

  const existing = cachedDetail(id);
  if (existing !== null && !refresh) {
    return Response.json({ activity: serializeActivity(activity, true), detail: existing });
  }

  const fetched = await fetchDetail(getClient(), activity.garmin_id);
  if (fetched === null) {
    // Failure, timeout, or an incapable/unauthenticated client (ISC-328,
    // ISC-330): return the local summary with detail_error, still 200. Any
    // previously cached detail is preserved and returned as-is.
    return Response.json({
      activity: serializeActivity(activity, existing !== null),
      detail: existing,
      detail_error: true,
    });
  }

  cacheDetail(id, fetched);
  return Response.json({ activity: serializeActivity(activity, true), detail: fetched });
}
