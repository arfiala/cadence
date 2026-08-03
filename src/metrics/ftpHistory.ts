// FTP-over-time series (dashboard trend card). Reads the ftp_history log
// written by the Zwift auto-sync seam and by manual Trends edits. One point
// per NY calendar day (the last accepted change that day wins), oldest first,
// so the chart reads left to right. History starts at the seed row laid down
// when the feature shipped; earlier FTP values are unknowable and never
// fabricated.

import { db } from "../db";
import { nyDateString } from "../week";

export type FtpPoint = { date: string; watts: number; source: string };

export type FtpSeries = {
  unit: "W";
  current: number | null; // the live ftp_watts setting (null when cleared)
  first: number | null; // earliest recorded value
  delta: number | null; // current - first (null when either side is missing)
  min: number | null;
  max: number | null;
  count: number; // distinct-day points
  points: FtpPoint[]; // oldest first, one per day
};

// Append a history row. Callers decide changed-ness (the sync seam already
// no-ops on equal values; the settings route compares before writing), so
// every row here is a genuine change or the one-time seed.
export function recordFtpChange(watts: number, source: "zwift" | "manual"): void {
  db.query("INSERT INTO ftp_history (recorded_on, watts, source) VALUES (?, ?, ?)").run(
    nyDateString(new Date()),
    watts,
    source,
  );
}

export function computeFtpSeries(): FtpSeries {
  const rows = db
    .query("SELECT recorded_on, watts, source FROM ftp_history ORDER BY recorded_on ASC, id ASC")
    .all() as { recorded_on: string; watts: number; source: string }[];

  // Collapse to one point per day; rows are oldest-first so a plain map
  // overwrite keeps the last change per day while preserving chronology.
  const byDay = new Map<string, FtpPoint>();
  for (const r of rows) {
    byDay.set(r.recorded_on, { date: r.recorded_on, watts: r.watts, source: r.source });
  }
  const points = [...byDay.values()];

  // current mirrors the live setting (the row the load engine actually uses),
  // so a cleared threshold honestly reads null even while history remains.
  const set = db.query("SELECT value FROM settings WHERE key = 'ftp_watts'").get() as {
    value: string;
  } | null;
  const cur = set === null ? NaN : Number(set.value);
  const current = Number.isFinite(cur) && cur > 0 ? cur : null;

  const first = points[0]?.watts ?? null;
  const watts = points.map((p) => p.watts);
  return {
    unit: "W",
    current,
    first,
    delta: current !== null && first !== null ? current - first : null,
    min: watts.length > 0 ? Math.min(...watts) : null,
    max: watts.length > 0 ? Math.max(...watts) : null,
    count: points.length,
    points,
  };
}
