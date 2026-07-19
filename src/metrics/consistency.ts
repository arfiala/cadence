// Consistency heatmap data (ISC-165..171). Per-day training minutes for the
// trailing 52 weeks plus a per-week G1-met flag, for the inline-SVG heatmap on
// Trends.
//
// Bucketing: SQLite has no America/New_York calendar, so the "single aggregate
// query" here is ONE SELECT over the 52-week window; the per-NY-day and
// per-Monday-week bucketing is done in TypeScript via the SAME week.ts helpers
// (nyDateString for the day key, startOfWeek/addWeeks/endOfWeek for the week
// grid, isG1Qualifying for the G1 flag) that every other feature uses. This
// keeps a UTC-vs-New-York midnight from ever misplacing a session (ISC-166).
//
// No schema changes: this is a pure read (ISC-171).

import { db } from "../db";
import { startOfWeek, endOfWeek, addWeeks, nyDateString, isG1Qualifying } from "../week";
import { getSettings } from "../services/weekSummary";

export type HeatCell = { date: string; minutes: number };
export type HeatWeek = { week_start: string; g1_met: boolean; days: HeatCell[] };
export type Consistency = {
  weeks: HeatWeek[];
  target_sessions: number;
  target_hours: number;
};

const WEEKS = 52;

type Row = { start_time: string; duration_s: number; sport: string };

export function computeConsistency(now: Date = new Date()): Consistency {
  const currentWeekStart = startOfWeek(now);
  const firstWeekStart = addWeeks(currentWeekStart, -(WEEKS - 1));
  const windowEnd = endOfWeek(currentWeekStart); // exclusive upper bound
  const { target_sessions, target_hours } = getSettings();

  // The single aggregate query. Everything below is in-memory bucketing.
  const rows = db
    .query(
      "SELECT start_time, duration_s, sport FROM activities WHERE start_time >= ? AND start_time < ?",
    )
    .all(firstWeekStart.toISOString(), windowEnd.toISOString()) as Row[];

  // Build the 52-week x 7-day grid up front, each cell keyed by its NY date.
  const weeks: HeatWeek[] = [];
  const dayLocation = new Map<string, [number, number]>();
  for (let wi = 0; wi < WEEKS; wi++) {
    const ws = addWeeks(firstWeekStart, wi);
    const days: HeatCell[] = [];
    for (let di = 0; di < 7; di++) {
      const dayDate = new Date(ws.getTime() + di * 24 * 60 * 60 * 1000);
      const dateStr = nyDateString(dayDate);
      days.push({ date: dateStr, minutes: 0 });
      dayLocation.set(dateStr, [wi, di]);
    }
    weeks.push({ week_start: nyDateString(ws), g1_met: false, days });
  }

  const weekSessions = new Array<number>(WEEKS).fill(0);
  const weekG1Hours = new Array<number>(WEEKS).fill(0);

  for (const row of rows) {
    const dayKey = nyDateString(new Date(row.start_time));
    const loc = dayLocation.get(dayKey);
    if (loc === undefined) continue; // guards the window edges defensively
    const [wi, di] = loc;
    const week = weeks[wi] as HeatWeek;
    (week.days[di] as HeatCell).minutes += row.duration_s / 60;
    if (isG1Qualifying(row.sport)) {
      weekSessions[wi] = (weekSessions[wi] as number) + 1;
      weekG1Hours[wi] = (weekG1Hours[wi] as number) + row.duration_s / 3600;
    }
  }

  weeks.forEach((week, wi) => {
    for (const cell of week.days) cell.minutes = Math.round(cell.minutes);
    week.g1_met =
      (weekSessions[wi] as number) >= target_sessions &&
      (weekG1Hours[wi] as number) >= target_hours;
  });

  return { weeks, target_sessions, target_hours };
}
