// GET /api/metrics/training-load (ISC-141), the daily Load / Fitness /
// Fatigue / Form series, auth-gated by virtue of living under /api/. Optional
// ?days=N trims the RETURNED window to the last N days for charting, but the
// EWMAs are always warmed up over the full history first so the trailing
// numbers are correct (ISC-139). Recomputed fresh every call, so an edit or
// delete shows up on the next read with no stale cache (ISC-143).

import { jsonError } from "../lib/http";
import { getThresholds } from "../services/weekSummary";
import { computeDailySeries, currentWeekLoad } from "../metrics/series";
import { computeConsistency } from "../metrics/consistency";
import { computeRecords } from "../metrics/records";
import { computeDigest } from "../metrics/digest";

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

export function getTrainingLoad(url: URL): Response {
  const daysParam = url.searchParams.get("days");
  let days = DEFAULT_DAYS;
  if (daysParam !== null) {
    const parsed = Number(daysParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return jsonError("Invalid 'days'", 400);
    }
    days = Math.min(parsed, MAX_DAYS);
  }

  const thresholds = getThresholds();
  const fullSeries = computeDailySeries(thresholds);
  const series = fullSeries.slice(-days);
  const last = fullSeries.at(-1) ?? null;

  return Response.json({
    thresholds_set: thresholds.ftpWatts !== null && thresholds.lthrBpm !== null,
    ftp_watts: thresholds.ftpWatts,
    lthr_bpm: thresholds.lthrBpm,
    current: last === null
      ? { fitness: 0, fatigue: 0, form: 0 }
      : { fitness: last.fitness, fatigue: last.fatigue, form: last.form },
    week_load: currentWeekLoad(thresholds),
    series,
  });
}

// GET /api/metrics/consistency (ISC-165): the 52-week heatmap grid, auth-gated
// by living under /api/. Pure read, recomputed fresh each call.
export function getConsistency(): Response {
  return Response.json(computeConsistency(new Date()));
}

// GET /api/metrics/records (ISC-172): the personal-records board plus G1
// streaks and the in-progress week, reported separately.
export function getRecords(): Response {
  return Response.json(computeRecords(new Date()));
}

// GET /api/metrics/digest (ISC-181): the last completed week's digest. Backs
// the get_week_digest MCP tool so the tool stays a thin API call (ISC-71).
export function getDigest(): Response {
  return Response.json(computeDigest(new Date()));
}
