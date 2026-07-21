// Read-side aggregation of the ZwiftPower critical-power curve (ISC-343). The
// rolling-90-day best per tracked duration is computed HERE, at read time, from
// the stored efforts, never precomputed at write. Cycling-only by construction
// (every effort came from ZwiftPower). Pure read, recomputed each call.

import { db } from "../db";
import type { PowerCurveEffortRow } from "../db";
import { POWER_CURVE_TARGETS } from "../zwiftpower/types";

const WINDOW_DAYS = 90;

export type PowerCurvePoint = {
  duration_s: number;
  label: string;
  watts: number;
  event_date: string | null;
  event_id: string | null;
};

export type PowerCurve = {
  window_days: number;
  points: PowerCurvePoint[];
};

// Best watts per tracked duration over the trailing 90 days, each carrying the
// source event date and id (ISC-343). Durations with no effort in the window
// are omitted (the caller renders a sparse-data state).
export function computePowerCurve(now: Date = new Date()): PowerCurve {
  const cutoff = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .query("SELECT * FROM power_curve_efforts WHERE event_date >= ? ORDER BY watts DESC")
    .all(cutoff) as PowerCurveEffortRow[];

  const points: PowerCurvePoint[] = [];
  for (const target of POWER_CURVE_TARGETS) {
    const forDuration = rows.filter((r) => r.duration_s === target.seconds);
    if (forDuration.length === 0) continue;
    // Rows are watts-desc, so the first is the best in the window.
    const best = forDuration[0] as PowerCurveEffortRow;
    points.push({
      duration_s: target.seconds,
      label: target.label,
      watts: best.watts,
      event_date: best.event_date,
      event_id: best.event_id,
    });
  }
  return { window_days: WINDOW_DAYS, points };
}
