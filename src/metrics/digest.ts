// Monday digest (ISC-181..184): a read-only summary of the last COMPLETED
// Monday-anchored week, for the get_week_digest MCP tool. Composes existing
// engines (week summary, training-load series, records diff) plus the races
// that fell in that week. Zero writes anywhere (ISC-184).

import { db } from "../db";
import { computeWeekSummary, getThresholds } from "../services/weekSummary";
import { computeDailySeries } from "./series";
import { newRecordsInWeek } from "./records";
import type { NewRecord } from "./records";
import { startOfWeek, endOfWeek, lastCompletedWeekStart } from "../week";

export type RaceLine = {
  title: string | null;
  category: string | null;
  position: number | null;
  event_date: string | null;
};

export type WeekDigest = {
  week_start: string;
  week_end: string;
  sessions: number;
  target_sessions: number;
  hours_g1: number;
  hours_total: number;
  target_hours: number;
  g1_met: boolean;
  verdict: string;
  gap_message: string;
  current: { fitness: number; fatigue: number; form: number };
  new_prs: NewRecord[];
  races: RaceLine[];
  has_data: boolean;
};

export function computeDigest(now: Date = new Date()): WeekDigest {
  const weekStart = lastCompletedWeekStart(now);
  const weekStartInstant = startOfWeek(weekStart); // normalize (weekStart already Monday)
  const weekEnd = endOfWeek(weekStartInstant);
  const summary = computeWeekSummary(weekStartInstant);
  const g1_met = summary.sessions >= summary.target_sessions && summary.hours_g1 >= summary.target_hours;

  // Fitness/Fatigue/Form as of now (the standing "where am I" numbers).
  const thresholds = getThresholds();
  const series = computeDailySeries(thresholds, { end: now });
  const last = series.at(-1);
  const current =
    last === undefined
      ? { fitness: 0, fatigue: 0, form: 0 }
      : { fitness: last.fitness, fatigue: last.fatigue, form: last.form };

  const new_prs = newRecordsInWeek(weekStartInstant, weekEnd);

  const races = db
    .query(
      "SELECT title, category, position, event_date FROM zwiftpower_results WHERE event_date >= ? AND event_date < ? ORDER BY event_date ASC",
    )
    .all(weekStartInstant.toISOString(), weekEnd.toISOString()) as RaceLine[];

  const has_data = summary.sessions > 0 || summary.hours_total > 0 || races.length > 0;

  return {
    week_start: summary.week_start,
    week_end: summary.week_end,
    sessions: summary.sessions,
    target_sessions: summary.target_sessions,
    hours_g1: summary.hours_g1,
    hours_total: summary.hours_total,
    target_hours: summary.target_hours,
    g1_met,
    verdict: g1_met ? "G1 target met" : "G1 target not met",
    gap_message: summary.gap_message,
    current,
    new_prs,
    races,
    has_data,
  };
}
