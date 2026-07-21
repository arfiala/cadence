// G1 risk and pacing (ISC-334..338). Answers "am I on pace to hit G1 this week"
// and "what is my usual weekly rhythm" using ONLY the sessions/hours arithmetic
// and the existing New York Monday-anchored week logic (ISC-336). It never reads
// the training-load / Fitness-Fatigue-Form series. This module deliberately
// does NOT import src/metrics/series.ts or src/metrics/trainingLoad.ts, so G1
// pacing can never be perturbed by a power/HR/RPE load number.
//
// G1 qualification (isG1Qualifying) and the week boundary helpers are the same
// single definitions every other week-scoped view uses.

import { db } from "../db";
import type { ActivityRow } from "../db";
import {
  startOfWeek,
  endOfWeek,
  addWeeks,
  dayIndexInWeek,
  isG1Qualifying,
} from "../week";
import { getSettings } from "../services/weekSummary";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function rowsInWindow(start: Date, end: Date): ActivityRow[] {
  return db
    .query("SELECT * FROM activities WHERE start_time >= ? AND start_time < ? ORDER BY start_time ASC")
    .all(start.toISOString(), end.toISOString()) as ActivityRow[];
}

// G1 sessions (count) and G1 hours (sum) in a window. Non-qualifying sports
// (running, strength, other) contribute to neither, matching the goal.
function g1Totals(rows: ActivityRow[]): { sessions: number; hours: number } {
  let sessions = 0;
  let hours = 0;
  for (const row of rows) {
    if (isG1Qualifying(row.sport)) {
      sessions += 1;
      hours += row.duration_s / 3600;
    }
  }
  return { sessions, hours };
}

// Per-weekday (Mon=0..Sun=6) G1 session and hour totals summed across the given
// completed weeks, plus how many of those weeks contained ANY activity. The
// per-weekday bucket for an activity is computed against its own week's Monday,
// so this is DST-safe by reusing dayIndexInWeek.
function perWeekdayTotals(weekStarts: Date[]): {
  sessions: number[];
  hours: number[];
  weeksWithData: number;
} {
  const sessions = new Array<number>(7).fill(0);
  const hours = new Array<number>(7).fill(0);
  let weeksWithData = 0;
  for (const ws of weekStarts) {
    const rows = rowsInWindow(ws, endOfWeek(ws));
    if (rows.length > 0) weeksWithData += 1;
    for (const row of rows) {
      if (!isG1Qualifying(row.sport)) continue;
      const idx = dayIndexInWeek(new Date(row.start_time), ws);
      if (idx < 0 || idx > 6) continue;
      sessions[idx] = (sessions[idx] as number) + 1;
      hours[idx] = (hours[idx] as number) + row.duration_s / 3600;
    }
  }
  return { sessions, hours, weeksWithData };
}

export type G1Verdict = "met" | "on_track" | "at_risk";

export type G1Risk = {
  sessions: number; // week-to-date G1 sessions
  hours: number; // week-to-date G1 hours
  sessionsNeeded: number; // max(0, target - sessions)
  hoursNeeded: number; // max(0, target - hours)
  daysLeft: number; // whole days remaining in the week after today
  projectedSessions: number; // week-to-date + trailing-rhythm projection
  projectedHours: number;
  verdict: G1Verdict;
};

// Verdict thresholds (ISC-335), documented here as the single source of truth:
//   met      = the week's targets are ALREADY hit (sessions >= target AND
//              hours >= target), regardless of days left.
//   on_track = not yet met, but the projection (week-to-date plus the trailing
//              4-week per-weekday rhythm applied to the remaining days) reaches
//              BOTH targets.
//   at_risk  = otherwise (the projection falls short of a target).
const TRAILING_WEEKS_FOR_PROJECTION = 4;

export function computeG1Risk(now: Date = new Date()): G1Risk {
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(weekStart);
  const { target_sessions, target_hours } = getSettings();

  const current = g1Totals(rowsInWindow(weekStart, weekEnd));

  const todayIdx = Math.min(6, Math.max(0, dayIndexInWeek(now, weekStart)));
  const remainingIdx: number[] = [];
  for (let i = todayIdx + 1; i <= 6; i++) remainingIdx.push(i);
  const daysLeft = 6 - todayIdx;

  // Trailing per-weekday rhythm from the last N COMPLETED weeks.
  const completedWeekStarts: Date[] = [];
  for (let w = 1; w <= TRAILING_WEEKS_FOR_PROJECTION; w++) {
    completedWeekStarts.push(addWeeks(weekStart, -w));
  }
  const totals = perWeekdayTotals(completedWeekStarts);
  const avgSessions = totals.sessions.map((s) => s / TRAILING_WEEKS_FOR_PROJECTION);
  const avgHours = totals.hours.map((h) => h / TRAILING_WEEKS_FOR_PROJECTION);

  let projSessions = current.sessions;
  let projHours = current.hours;
  for (const idx of remainingIdx) {
    projSessions += avgSessions[idx] as number;
    projHours += avgHours[idx] as number;
  }

  const met = current.sessions >= target_sessions && current.hours >= target_hours;
  const onTrack = projSessions >= target_sessions && projHours >= target_hours;
  const verdict: G1Verdict = met ? "met" : onTrack ? "on_track" : "at_risk";

  return {
    sessions: current.sessions,
    hours: round1(current.hours),
    sessionsNeeded: Math.max(0, target_sessions - current.sessions),
    hoursNeeded: round1(Math.max(0, target_hours - current.hours)),
    daysLeft,
    projectedSessions: round1(projSessions),
    projectedHours: round1(projHours),
    verdict,
  };
}

export type PacingWeekday = {
  weekday: number; // 0=Mon..6=Sun
  avg_sessions: number;
  avg_hours: number;
};

export type Pacing =
  | { insufficient_history: true }
  | { insufficient_history: false; weeks_of_history: number; weekdays: PacingWeekday[] };

const TRAILING_WEEKS_FOR_PACING = 8;
const MIN_WEEKS_FOR_PACING = 2;

// The "usual rhythm": per-weekday G1 session frequency and typical hours over
// the trailing 8 completed weeks (ISC-337). With fewer than 2 completed weeks
// that actually contain data, there is not enough history to describe a rhythm
// and the caller is told so (ISC-338).
export function computePacing(now: Date = new Date()): Pacing {
  const weekStart = startOfWeek(now);
  const completedWeekStarts: Date[] = [];
  for (let w = 1; w <= TRAILING_WEEKS_FOR_PACING; w++) {
    completedWeekStarts.push(addWeeks(weekStart, -w));
  }
  const totals = perWeekdayTotals(completedWeekStarts);
  if (totals.weeksWithData < MIN_WEEKS_FOR_PACING) {
    return { insufficient_history: true };
  }
  const denom = totals.weeksWithData;
  const weekdays: PacingWeekday[] = totals.sessions.map((s, idx) => ({
    weekday: idx,
    avg_sessions: round1(s / denom),
    avg_hours: round1((totals.hours[idx] as number) / denom),
  }));
  return { insufficient_history: false, weeks_of_history: denom, weekdays };
}
