// Weight-progress series (dashboard widget). Pure read over the
// zwiftpower_results table: the rider's body weight as Zwift recorded it for
// each ride. This is the profile weight set in Zwift at ride time (a
// manually-entered value used for w/kg), not a per-ride measurement, so it
// changes only when Austin updates his Zwift weight — an honest passive signal,
// not a scale log. One point per calendar day (the latest ride that day wins),
// oldest first, so the chart reads left-to-right as progress over time.

import { db } from "../db";
import { nyDateString } from "../week";

export type WeightPoint = { date: string; weight_kg: number };

export type WeightSeries = {
  unit: "kg";
  current: number | null; // most recent recorded weight
  first: number | null; // earliest recorded weight in the series
  delta: number | null; // current - first, rounded to 0.1 (negative = lost weight)
  min: number | null; // lightest recorded weight
  max: number | null; // heaviest recorded weight
  count: number; // number of distinct-day readings
  points: WeightPoint[]; // oldest first, one per day
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeWeightSeries(): WeightSeries {
  const rows = db
    .query(
      `SELECT event_date, weight_kg FROM zwiftpower_results
       WHERE weight_kg IS NOT NULL AND event_date IS NOT NULL
       ORDER BY event_date ASC`,
    )
    .all() as { event_date: string; weight_kg: number }[];

  // Collapse to one point per NY calendar day, keeping the last ride's weight
  // that day. rows are already oldest-first, so a plain map overwrite leaves
  // the latest value per day; insertion order preserves chronology.
  const byDay = new Map<string, number>();
  for (const row of rows) {
    byDay.set(nyDateString(new Date(row.event_date)), round1(row.weight_kg));
  }

  const points: WeightPoint[] = [...byDay.entries()].map(([date, weight_kg]) => ({ date, weight_kg }));

  const current = points.length > 0 ? points[points.length - 1]!.weight_kg : null;
  const first = points.length > 0 ? points[0]!.weight_kg : null;
  const delta = current !== null && first !== null ? round1(current - first) : null;
  const weights = points.map((p) => p.weight_kg);
  const min = weights.length > 0 ? Math.min(...weights) : null;
  const max = weights.length > 0 ? Math.max(...weights) : null;

  return { unit: "kg", current, first, delta, min, max, count: points.length, points };
}
