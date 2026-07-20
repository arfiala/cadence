// GET /api/sleep — recent nightly Garmin sleep (ISC-250). Sits under /api/ so
// it is already auth-gated by the server (401 unauthenticated). Read-only:
// sleep is written only by the Garmin sync engine, never by this route. The
// serialized shape is stable and stage seconds are surfaced as-is so the
// frontend can compute its own bars without a second round trip.

import { getRecentSleep } from "../garmin/sync";
import type { SleepRow } from "../db";

function serializeSleep(row: SleepRow) {
  return {
    date: row.calendar_date,
    start_time: row.start_time,
    end_time: row.end_time,
    total_sleep_s: row.total_sleep_s,
    deep_s: row.deep_s,
    light_s: row.light_s,
    rem_s: row.rem_s,
    awake_s: row.awake_s,
    score: row.score,
  };
}

export function getSleep(url: URL): Response {
  const raw = Number.parseInt(url.searchParams.get("limit") ?? "14", 10);
  const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 60) : 14;
  return Response.json({ nights: getRecentSleep(limit).map(serializeSleep) });
}
