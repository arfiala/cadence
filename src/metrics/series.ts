// Daily load series and the impulse-response Fitness / Fatigue / Form model
// (ISC-139, ISC-140). Pure TypeScript, zero dependencies (ISC-146).
//
// Fitness  (internally CTL) = 42-day exponentially weighted average of load.
// Fatigue  (internally ATL) =  7-day exponentially weighted average of load.
// Form     (internally TSB) = yesterday's Fitness minus yesterday's Fatigue.
//
// The EWMAs are computed over a CONTINUOUS daily series that includes
// zero-load rest days (ISC-139) using the classic impulse-response recurrence:
//   today = yesterday + (load - yesterday) / timeConstant
// Seeded at zero before the first day, so a brand-new log warms up honestly
// from 0 rather than jumping.
//
// Daily bucketing is by America/New_York calendar day, consistent with
// week.ts, and DST-safe: days are enumerated by stepping a noon-UTC anchor,
// which maps to mid-morning New York and so never lands near a midnight
// boundary a DST shift could move (ISC-147).

import { db } from "../db";
import type { ActivityRow } from "../db";
import { nyDateString, weekWindow } from "../week";
import { activityLoad } from "./trainingLoad";
import type { Thresholds } from "./trainingLoad";

export type DailyLoadPoint = {
  date: string; // YYYY-MM-DD, America/New_York
  load: number;
  fitness: number;
  fatigue: number;
  form: number;
};

const FITNESS_TC = 42; // CTL time constant (days)
const FATIGUE_TC = 7; // ATL time constant (days)

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function nyDayNoonUtcMs(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y as number, (m as number) - 1, d as number, 12, 0, 0);
}

// Inclusive list of NY calendar-day strings from startStr..endStr. Stepping a
// noon-UTC anchor by 24h enumerates consecutive calendar dates without any
// midnight arithmetic, so a DST transition inside the window cannot drop or
// duplicate a day (ISC-147).
export function eachNyDay(startStr: string, endStr: string): string[] {
  const out: string[] = [];
  if (startStr > endStr) return out;
  let ms = nyDayNoonUtcMs(startStr);
  let guard = 0;
  while (guard++ < 200000) {
    const ds = nyDateString(new Date(ms));
    out.push(ds);
    if (ds >= endStr) break;
    ms += 24 * 60 * 60 * 1000;
  }
  return out;
}

function allActivities(): ActivityRow[] {
  return db
    .query("SELECT * FROM activities ORDER BY start_time ASC")
    .all() as ActivityRow[];
}

function loadOf(row: ActivityRow, thresholds: Thresholds): number {
  return activityLoad(
    {
      durationSeconds: row.duration_s,
      avgHr: row.avg_hr,
      avgPower: row.avg_power,
      normPower: row.norm_power,
    },
    thresholds,
  ).load;
}

// Build the full daily series from the first logged activity's day through the
// end day (default today). Returns [] when there are no activities. Because it
// reads the activities table fresh on every call, an edit or delete is
// reflected on the next read with no stale cache (ISC-143).
export function computeDailySeries(
  thresholds: Thresholds,
  opts: { end?: Date } = {},
): DailyLoadPoint[] {
  const rows = allActivities();
  if (rows.length === 0) return [];

  const end = opts.end ?? new Date();
  const startStr = nyDateString(new Date((rows[0] as ActivityRow).start_time));
  let endStr = nyDateString(end);
  if (endStr < startStr) endStr = startStr;

  // Daily load buckets.
  const dailyLoad = new Map<string, number>();
  for (const row of rows) {
    const key = nyDateString(new Date(row.start_time));
    dailyLoad.set(key, (dailyLoad.get(key) ?? 0) + loadOf(row, thresholds));
  }

  const days = eachNyDay(startStr, endStr);
  const series: DailyLoadPoint[] = [];
  let fitnessPrev = 0;
  let fatiguePrev = 0;
  for (const date of days) {
    const load = round1(dailyLoad.get(date) ?? 0);
    const form = fitnessPrev - fatiguePrev; // TSB uses yesterday's values
    const fitness = fitnessPrev + (load - fitnessPrev) / FITNESS_TC;
    const fatigue = fatiguePrev + (load - fatiguePrev) / FATIGUE_TC;
    series.push({
      date,
      load,
      fitness: round1(fitness),
      fatigue: round1(fatigue),
      form: round1(form),
    });
    fitnessPrev = fitness;
    fatiguePrev = fatigue;
  }
  return series;
}

// Sum of load over the current Monday-anchored America/New_York week, used by
// the MCP get_training_load tool (ISC-145).
export function currentWeekLoad(thresholds: Thresholds, now: Date = new Date()): number {
  const { start, end } = weekWindow(now);
  const rows = db
    .query("SELECT * FROM activities WHERE start_time >= ? AND start_time < ?")
    .all(start.toISOString(), end.toISOString()) as ActivityRow[];
  let total = 0;
  for (const row of rows) total += loadOf(row, thresholds);
  return round1(total);
}
