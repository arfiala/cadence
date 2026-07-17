// GET /api/metrics/training-load (ISC-141), the daily Load / Fitness /
// Fatigue / Form series, auth-gated by virtue of living under /api/. Optional
// ?days=N trims the RETURNED window to the last N days for charting, but the
// EWMAs are always warmed up over the full history first so the trailing
// numbers are correct (ISC-139). Recomputed fresh every call, so an edit or
// delete shows up on the next read with no stale cache (ISC-143).

import { jsonError } from "../lib/http";
import { getThresholds } from "../services/weekSummary";
import { computeDailySeries, currentWeekLoad } from "../metrics/series";

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
