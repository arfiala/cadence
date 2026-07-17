// Shared week-summary computation, used by GET /api/week, GET /api/trends,
// and (transitively, via the API) the MCP get_week_summary / get_goal_progress
// tools. This is the ONE place activities are turned into a week's sessions /
// hours / gap-to-target numbers — ISC-47 requires isG1Qualifying to be a
// single named function, and this module is the single named consumer of it
// for week-level aggregation.

import { db } from "../db";
import type { ActivityRow } from "../db";
import {
  startOfWeek,
  endOfWeek,
  dayIndexInWeek,
  nyDateString,
  isG1Qualifying,
} from "../week";

export type DaySummary = {
  date: string; // YYYY-MM-DD, America/New_York
  sessions: number; // G1-qualifying activities that day
  hours: number; // all-sport hours that day
};

export type WeekSummary = {
  week_start: string; // YYYY-MM-DD
  week_end: string; // YYYY-MM-DD (exclusive boundary's date)
  target_sessions: number;
  target_hours: number;
  sessions: number; // G1-qualifying session count for the week
  hours_total: number; // all-sport hours
  hours_g1: number; // G1-qualifying hours only
  gap_sessions: number; // max(0, target_sessions - sessions)
  gap_hours: number; // max(0, target_hours - hours_g1)
  gap_message: string; // plain-language, e.g. "2 sessions, 3.2 h — need 3 more sessions, 4.8 h by Sunday"
  days: DaySummary[]; // 7 entries, Monday..Sunday
};

export type Settings = {
  target_sessions: number;
  target_hours: number;
  // Training-load thresholds (ISC-134), null until the user sets them. Stored
  // as ordinary settings rows; absence means "unset" and the load engine
  // degrades to lower tiers (ISC-144).
  ftp_watts: number | null;
  lthr_bpm: number | null;
};

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function getSettings(): Settings {
  const rows = db.query("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    target_sessions: Number(map.get("target_sessions") ?? "5"),
    target_hours: Number(map.get("target_hours") ?? "8"),
    ftp_watts: numberOrNull(map.get("ftp_watts")),
    lthr_bpm: numberOrNull(map.get("lthr_bpm")),
  };
}

// The thresholds shape the training-load engine consumes (ISC-134, ISC-144).
export function getThresholds(): { ftpWatts: number | null; lthrBpm: number | null } {
  const s = getSettings();
  return { ftpWatts: s.ftp_watts, lthrBpm: s.lthr_bpm };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function buildGapMessage(
  sessions: number,
  hoursG1: number,
  targetSessions: number,
  targetHours: number,
): string {
  const gapSessions = Math.max(0, targetSessions - sessions);
  const gapHours = Math.max(0, targetHours - hoursG1);

  if (gapSessions === 0 && gapHours === 0) {
    return `${sessions} sessions, ${round1(hoursG1)} h — G1 target met for this week.`;
  }

  const sessionWord = gapSessions === 1 ? "session" : "sessions";
  return `${sessions} sessions, ${round1(hoursG1)} h — need ${gapSessions} more ${sessionWord}, ${round1(gapHours)} h by Sunday.`;
}

// Compute the week summary for the week containing `instant`, using
// Monday-anchored, America/New_York, DST-safe boundaries (ISC-9, ISC-40).
export function computeWeekSummary(instant: Date): WeekSummary {
  const weekStart = startOfWeek(instant);
  const weekEnd = endOfWeek(weekStart);
  const { target_sessions, target_hours } = getSettings();

  const rows = db
    .query("SELECT * FROM activities WHERE start_time >= ? AND start_time < ? ORDER BY start_time ASC")
    .all(weekStart.toISOString(), weekEnd.toISOString()) as ActivityRow[];

  const days: DaySummary[] = Array.from({ length: 7 }, (_, i) => {
    const dayDate = new Date(weekStart.getTime() + i * 24 * 60 * 60 * 1000);
    return { date: nyDateString(dayDate), sessions: 0, hours: 0 };
  });

  let sessions = 0;
  let hoursTotal = 0;
  let hoursG1 = 0;

  for (const row of rows) {
    const hours = row.duration_s / 3600;
    hoursTotal += hours;

    const qualifies = isG1Qualifying(row.sport);
    if (qualifies) {
      sessions += 1;
      hoursG1 += hours;
    }

    const dayIdx = dayIndexInWeek(new Date(row.start_time), weekStart);
    const day = days[dayIdx];
    if (day !== undefined) {
      day.hours = round1(day.hours + hours);
      if (qualifies) day.sessions += 1;
    }
  }

  const gapSessions = Math.max(0, target_sessions - sessions);
  const gapHours = round1(Math.max(0, target_hours - hoursG1));

  // week_end is displayed as the last INCLUDED day (Sunday), not the
  // exclusive next-Monday boundary, so it reads naturally to a human.
  const lastIncludedDay = new Date(weekEnd.getTime() - 24 * 60 * 60 * 1000);

  return {
    week_start: nyDateString(weekStart),
    week_end: nyDateString(lastIncludedDay),
    target_sessions,
    target_hours,
    sessions,
    hours_total: round1(hoursTotal),
    hours_g1: round1(hoursG1),
    gap_sessions: gapSessions,
    gap_hours: gapHours,
    gap_message: buildGapMessage(sessions, hoursG1, target_sessions, target_hours),
    days,
  };
}
