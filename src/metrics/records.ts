// Personal records board (ISC-172..180) and the record helpers the Monday
// digest reuses (ISC-181). Pure reads over the activities table, no schema
// changes (ISC-180).
//
// Every week/streak computation reuses the existing G1 + week helpers
// (computeWeekSummary, isG1Qualifying via that summary, startOfWeek/addWeeks/
// lastCompletedWeekStart) rather than reimplementing week math (ISC-176).

import { db } from "../db";
import type { ActivityRow } from "../db";
import { computeWeekSummary } from "../services/weekSummary";
import {
  startOfWeek,
  endOfWeek,
  addWeeks,
  lastCompletedWeekStart,
  nyDateString,
} from "../week";

const RIDE_SPORTS = new Set(["cycling", "virtual_cycling"]);
const SPEED_FLOOR_M = 10000; // 10 km floor for a fastest-average-speed record

export type DurationRecord =
  | { activity_id: number; value_s: number; date: string; sport: string; title: string | null }
  | null;
export type DistanceRecord =
  | { activity_id: number; distance_m: number; date: string; sport: string; title: string | null }
  | null;
export type SpeedRecord =
  | {
      activity_id: number;
      speed_kmh: number;
      distance_m: number;
      duration_s: number;
      date: string;
      title: string | null;
    }
  | null;
export type WeekHoursRecord = { week_start: string; hours: number } | null;

export type PointRecords = {
  longest_ride: DurationRecord;
  longest_distance_ride: DistanceRecord;
  fastest_ride: SpeedRecord;
  longest_swim: DurationRecord;
};

export type Records = PointRecords & { biggest_week: WeekHoursRecord };

export type Streak = {
  current_weeks: number;
  longest_weeks: number;
  in_progress: {
    week_start: string;
    sessions: number;
    hours_g1: number;
    target_sessions: number;
    target_hours: number;
    met: boolean;
  };
};

export type RecordsPayload = { records: Records; streak: Streak };

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Point records (per-activity bests) over an arbitrary row set, so the same
// logic serves both the all-time board and the "PRs set this week" diff the
// digest needs.
export function computePointRecords(rows: ActivityRow[]): PointRecords {
  let longestRide: DurationRecord = null;
  let longestDistance: DistanceRecord = null;
  let fastest: SpeedRecord = null;
  let longestSwim: DurationRecord = null;

  for (const row of rows) {
    const date = nyDateString(new Date(row.start_time));
    if (RIDE_SPORTS.has(row.sport)) {
      if (longestRide === null || row.duration_s > longestRide.value_s) {
        longestRide = {
          activity_id: row.id,
          value_s: row.duration_s,
          date,
          sport: row.sport,
          title: row.title,
        };
      }
      // Distance and speed records exclude zero/null-distance rides (ISC-177).
      if (row.distance_m !== null && row.distance_m > 0) {
        if (longestDistance === null || row.distance_m > longestDistance.distance_m) {
          longestDistance = {
            activity_id: row.id,
            distance_m: row.distance_m,
            date,
            sport: row.sport,
            title: row.title,
          };
        }
        if (row.distance_m >= SPEED_FLOOR_M && row.duration_s > 0) {
          const speed = row.distance_m / 1000 / (row.duration_s / 3600);
          if (fastest === null || speed > fastest.speed_kmh) {
            fastest = {
              activity_id: row.id,
              speed_kmh: round1(speed),
              distance_m: row.distance_m,
              duration_s: row.duration_s,
              date,
              title: row.title,
            };
          }
        }
      }
    }
    if (row.sport === "swimming") {
      if (longestSwim === null || row.duration_s > longestSwim.value_s) {
        longestSwim = {
          activity_id: row.id,
          value_s: row.duration_s,
          date,
          sport: row.sport,
          title: row.title,
        };
      }
    }
  }

  return {
    longest_ride: longestRide,
    longest_distance_ride: longestDistance,
    fastest_ride: fastest,
    longest_swim: longestSwim,
  };
}

// Biggest COMPLETED training week by total hours. In-progress week excluded so
// a mid-week total never masquerades as a record (same completed-week rule as
// the streak, ISC-175).
export function computeBiggestWeek(now: Date): WeekHoursRecord {
  const first = db
    .query("SELECT start_time FROM activities ORDER BY start_time ASC LIMIT 1")
    .get() as { start_time: string } | null;
  if (first === null) return null;

  const lastCompleted = lastCompletedWeekStart(now);
  let ws = startOfWeek(new Date(first.start_time));
  let best: WeekHoursRecord = null;
  let guard = 0;
  while (ws.getTime() <= lastCompleted.getTime() && guard++ < 5000) {
    const summary = computeWeekSummary(ws);
    if (summary.hours_total > 0 && (best === null || summary.hours_total > best.hours)) {
      best = { week_start: summary.week_start, hours: summary.hours_total };
    }
    ws = addWeeks(ws, 1);
  }
  return best;
}

// A completed week "meets G1" when both targets are hit. A completed week with
// zero qualifying activity has sessions 0 and so does not meet it, which is how
// an empty week breaks the streak (ISC-175). Reuses computeWeekSummary so the
// G1 rule is never reimplemented (ISC-176).
function weekMeetsG1(weekStart: Date): boolean {
  const s = computeWeekSummary(weekStart);
  return s.sessions >= s.target_sessions && s.hours_g1 >= s.target_hours;
}

export function computeStreaks(now: Date): { current_weeks: number; longest_weeks: number } {
  const first = db
    .query("SELECT start_time FROM activities ORDER BY start_time ASC LIMIT 1")
    .get() as { start_time: string } | null;
  if (first === null) return { current_weeks: 0, longest_weeks: 0 };

  const lastCompleted = lastCompletedWeekStart(now);
  const metFlags: boolean[] = [];
  let ws = startOfWeek(new Date(first.start_time));
  let guard = 0;
  while (ws.getTime() <= lastCompleted.getTime() && guard++ < 5000) {
    metFlags.push(weekMeetsG1(ws));
    ws = addWeeks(ws, 1);
  }

  let longest = 0;
  let run = 0;
  for (const met of metFlags) {
    run = met ? run + 1 : 0;
    if (run > longest) longest = run;
  }

  // Current streak is the trailing run ending at the last COMPLETED week; a
  // non-meeting last week yields 0 (ISC-175).
  let current = 0;
  for (let i = metFlags.length - 1; i >= 0; i--) {
    if (metFlags[i] === true) current += 1;
    else break;
  }

  return { current_weeks: current, longest_weeks: longest };
}

// The in-progress (current) week, reported separately and never counted toward
// the streak either way (ISC-175).
export function inProgressWeek(now: Date): Streak["in_progress"] {
  const s = computeWeekSummary(now);
  return {
    week_start: s.week_start,
    sessions: s.sessions,
    hours_g1: s.hours_g1,
    target_sessions: s.target_sessions,
    target_hours: s.target_hours,
    met: s.sessions >= s.target_sessions && s.hours_g1 >= s.target_hours,
  };
}

export function computeRecords(now: Date = new Date()): RecordsPayload {
  const rows = db
    .query("SELECT * FROM activities ORDER BY start_time ASC")
    .all() as ActivityRow[];
  const point = computePointRecords(rows);
  const biggest_week = computeBiggestWeek(now);
  const streaks = computeStreaks(now);
  const in_progress = inProgressWeek(now);
  return {
    records: { ...point, biggest_week },
    streak: { ...streaks, in_progress },
  };
}

// --- "PRs newly set this week" (digest input) ------------------------------

function fmtDur(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export type NewRecord = { type: string; label: string; detail: string };

// Records whose all-time best strictly improved during [weekStart, weekEnd):
// the best achieved within the week beats everything achieved before it. This
// avoids claiming a PR that merely happens to sit in the week but was equalled
// earlier.
export function newRecordsInWeek(weekStart: Date, weekEnd: Date): NewRecord[] {
  const before = db
    .query("SELECT * FROM activities WHERE start_time < ? ORDER BY start_time ASC")
    .all(weekStart.toISOString()) as ActivityRow[];
  const within = db
    .query(
      "SELECT * FROM activities WHERE start_time >= ? AND start_time < ? ORDER BY start_time ASC",
    )
    .all(weekStart.toISOString(), weekEnd.toISOString()) as ActivityRow[];

  const b = computePointRecords(before);
  const w = computePointRecords(within);
  const prs: NewRecord[] = [];

  if (w.longest_ride !== null && (b.longest_ride === null || w.longest_ride.value_s > b.longest_ride.value_s)) {
    prs.push({ type: "longest_ride", label: "Longest ride", detail: fmtDur(w.longest_ride.value_s) });
  }
  if (
    w.longest_distance_ride !== null &&
    (b.longest_distance_ride === null || w.longest_distance_ride.distance_m > b.longest_distance_ride.distance_m)
  ) {
    prs.push({
      type: "longest_distance_ride",
      label: "Longest distance",
      detail: `${round1(w.longest_distance_ride.distance_m / 1000)} km`,
    });
  }
  if (w.fastest_ride !== null && (b.fastest_ride === null || w.fastest_ride.speed_kmh > b.fastest_ride.speed_kmh)) {
    prs.push({ type: "fastest_ride", label: "Fastest ride", detail: `${w.fastest_ride.speed_kmh} km/h` });
  }
  if (w.longest_swim !== null && (b.longest_swim === null || w.longest_swim.value_s > b.longest_swim.value_s)) {
    prs.push({ type: "longest_swim", label: "Longest swim", detail: fmtDur(w.longest_swim.value_s) });
  }

  // Biggest-week PR: this completed week's total beats every prior completed
  // week. computeBiggestWeek(weekStart) considers only weeks before weekStart.
  const targetHours = computeWeekSummary(weekStart).hours_total;
  const priorBest = computeBiggestWeek(weekStart);
  if (targetHours > 0 && (priorBest === null || targetHours > priorBest.hours)) {
    prs.push({ type: "biggest_week", label: "Biggest week", detail: `${round1(targetHours)} h` });
  }

  return prs;
}

// Convenience re-export used by the digest for the exclusive week bound.
export { endOfWeek };
