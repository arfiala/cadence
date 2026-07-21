// Year-over-year (ISC-339..341): this ISO week versus the same ISO week one
// year ago, in New York terms, through the existing Monday-anchored week
// helpers. Reports sessions (G1), hours (all-sport), and distance, each as a
// {current, prior, delta} triple, or per-metric insufficient_history when the
// prior-year week has no data for that metric (ISC-340).
//
// ISO week alignment (ISC-341): weeks are numbered ISO-8601 (Monday-start, the
// week containing the year's first Thursday is week 1). When the current week
// is week 53 and the prior ISO year has only 52 weeks, the comparison falls
// back to the prior year's week 52 so there is always a real week to compare to.

import { db } from "../db";
import type { ActivityRow } from "../db";
import { startOfWeek, endOfWeek, nyDateString, weekWindow, isG1Qualifying } from "../week";

const DAY_MS = 24 * 60 * 60 * 1000;

// Mon=0..Sun=6 for a UTC date-only instant.
function isoDayNum(utcMs: number): number {
  return (new Date(utcMs).getUTCDay() + 6) % 7;
}

// ISO year + week for a calendar date (given as y, m 1-12, d), via the
// canonical Thursday-of-the-week algorithm.
export function isoWeekOfDate(y: number, m: number, d: number): { isoYear: number; isoWeek: number } {
  const dateMs = Date.UTC(y, m - 1, d);
  const thursdayMs = dateMs - isoDayNum(dateMs) * DAY_MS + 3 * DAY_MS;
  const isoYear = new Date(thursdayMs).getUTCFullYear();
  const firstThursdayBase = Date.UTC(isoYear, 0, 4);
  const firstThursdayMs =
    firstThursdayBase - isoDayNum(firstThursdayBase) * DAY_MS + 3 * DAY_MS;
  const isoWeek = 1 + Math.round((thursdayMs - firstThursdayMs) / (7 * DAY_MS));
  return { isoYear, isoWeek };
}

// How many ISO weeks a given ISO year has (52 or 53). December 28 always falls
// in the last ISO week of its ISO year.
export function weeksInIsoYear(isoYear: number): number {
  return isoWeekOfDate(isoYear, 12, 28).isoWeek;
}

// The Monday (UTC calendar date-only ms) of ISO week `week` in ISO year
// `isoYear`.
export function mondayOfIsoWeek(isoYear: number, week: number): number {
  const jan4 = Date.UTC(isoYear, 0, 4);
  const week1Monday = jan4 - isoDayNum(jan4) * DAY_MS;
  return week1Monday + (week - 1) * 7 * DAY_MS;
}

type WindowTotals = {
  rows: number;
  sessions: number; // G1 qualifying count
  hours: number; // all-sport hours
  distance: number; // sum of distance_m
  distanceRows: number; // rows carrying a positive distance
};

function windowTotals(start: Date, end: Date): WindowTotals {
  const rows = db
    .query("SELECT * FROM activities WHERE start_time >= ? AND start_time < ?")
    .all(start.toISOString(), end.toISOString()) as ActivityRow[];
  let sessions = 0;
  let hours = 0;
  let distance = 0;
  let distanceRows = 0;
  for (const row of rows) {
    hours += row.duration_s / 3600;
    if (isG1Qualifying(row.sport)) sessions += 1;
    if (row.distance_m !== null && row.distance_m > 0) {
      distance += row.distance_m;
      distanceRows += 1;
    }
  }
  return { rows: rows.length, sessions, hours, distance, distanceRows };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

type YoyMetric =
  | { insufficient_history: true; current: number }
  | { insufficient_history: false; current: number; prior: number; delta: number };

function metric(current: number, prior: number, priorHasData: boolean): YoyMetric {
  if (!priorHasData) return { insufficient_history: true, current: round1(current) };
  return { insufficient_history: false, current: round1(current), prior: round1(prior), delta: round1(current - prior) };
}

export type Yoy = {
  iso_year: number;
  iso_week: number;
  prior_iso_year: number;
  prior_iso_week: number;
  sessions: YoyMetric;
  hours: YoyMetric;
  distance: YoyMetric;
};

export function computeYoy(now: Date = new Date()): Yoy {
  const weekStart = startOfWeek(now);
  const weekEnd = endOfWeek(weekStart);
  const current = windowTotals(weekStart, weekEnd);

  // Current ISO week from the NY Monday's calendar date.
  const mondayStr = nyDateString(weekStart);
  const [cy, cm, cd] = mondayStr.split("-").map(Number);
  const { isoYear, isoWeek } = isoWeekOfDate(cy as number, cm as number, cd as number);

  // Same ISO week one year earlier, with the week-53 fallback (ISC-341).
  const priorIsoYear = isoYear - 1;
  const priorIsoWeek = Math.min(isoWeek, weeksInIsoYear(priorIsoYear));
  const priorMondayMs = mondayOfIsoWeek(priorIsoYear, priorIsoWeek);
  // Convert that UTC calendar Monday to the NY week window via the shared
  // helper (noon anchor so a DST edge never shifts the calendar day).
  const priorWindow = weekWindow(new Date(priorMondayMs + 12 * 60 * 60 * 1000));
  const prior = windowTotals(priorWindow.start, priorWindow.end);

  return {
    iso_year: isoYear,
    iso_week: isoWeek,
    prior_iso_year: priorIsoYear,
    prior_iso_week: priorIsoWeek,
    sessions: metric(current.sessions, prior.sessions, prior.rows > 0),
    hours: metric(current.hours, prior.hours, prior.rows > 0),
    distance: metric(current.distance, prior.distance, prior.distanceRows > 0),
  };
}
