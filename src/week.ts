// Week math: the DST-safe, Monday-anchored, America/New_York spine every
// week-scoped view (dashboard, /api/week, /api/trends, MCP get_week_summary,
// get_goal_progress) is built on. All timestamps are stored in SQLite as UTC
// ISO-8601 (ISC-8); this module is the ONLY place that converts between UTC
// storage and the America/New_York wall-clock week boundary Austin lives in.
//
// DST-safety approach: rather than hand-rolling offset arithmetic (easy to get
// wrong across the spring-forward/fall-back transitions), we lean on the
// platform's Intl/timezone-aware Date formatting (`Intl.DateTimeFormat` with
// `timeZone: "America/New_York"`) to read wall-clock fields, and construct
// boundaries by asking "what UTC instant is Monday 00:00 America/New_York"
// via a small offset-search — never by adding a fixed number of hours.

export const TIME_ZONE = "America/New_York";

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  weekday: "short",
});

type WallClockParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23 (24 normalized to 0 below)
  minute: number;
  second: number;
  weekday: string; // "Mon", "Tue", ...
};

// Read the wall-clock date/time in America/New_York for a given UTC instant.
function wallClockParts(instant: Date): WallClockParts {
  const parts = partsFormatter.formatToParts(instant);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  // Intl can format midnight as "24" for hour12:false in some environments;
  // normalize to 0 so downstream arithmetic never sees a 24th hour.
  let hour = Number(map.hour ?? "0");
  if (hour === 24) hour = 0;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute ?? "0"),
    second: Number(map.second ?? "0"),
    weekday: map.weekday ?? "",
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

// Find the UTC instant corresponding to a given America/New_York wall-clock
// date at 00:00:00, DST-safe. Strategy: start from a naive UTC guess (treat
// the wall-clock date as if it were UTC), then correct by re-reading what
// wall-clock time that guess actually renders as in America/New_York and
// nudging by the difference. Two iterations always converge because the
// America/New_York UTC offset only ever takes two values (-05:00 / -04:00),
// so a single correction pass fixes any offset error introduced by DST.
function nyMidnightToUtc(year: number, month: number, day: number): Date {
  let guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const observed = wallClockParts(new Date(guess));
    const observedUtcMs = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const targetUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
    const diff = targetUtcMs - observedUtcMs;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

// The Monday 00:00 America/New_York instant (as a UTC Date) for the week
// containing `instant`. This is THE definition of a week boundary in Cadence
// — every week-scoped query derives from this function, never from ad-hoc
// day-of-week math (ISC-9).
export function startOfWeek(instant: Date): Date {
  const parts = wallClockParts(instant);
  const weekdayIdx = WEEKDAY_INDEX[parts.weekday] ?? 0;
  // Compute the NY calendar date for `instant`, then walk back to Monday
  // using calendar-day arithmetic (via Date.UTC's own day rollover), then
  // re-anchor to midnight America/New_York.
  const asUtcNoon = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const mondayUtcNoon = asUtcNoon - weekdayIdx * 24 * 60 * 60 * 1000;
  const mondayDate = new Date(mondayUtcNoon);
  return nyMidnightToUtc(
    mondayDate.getUTCFullYear(),
    mondayDate.getUTCMonth() + 1,
    mondayDate.getUTCDate(),
  );
}

// The instant exactly 7 NY calendar days after a week's start — i.e. the
// exclusive upper bound of the week ([start, end)). Computed the same
// calendar-day-then-reanchor way so it is correct across a DST transition
// inside the week (the week is still exactly 7 *days*, but not exactly
// 168 hours, when it crosses the transition).
export function endOfWeek(weekStart: Date): Date {
  const parts = wallClockParts(weekStart);
  const asUtcNoon = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const plus7UtcNoon = asUtcNoon + 7 * 24 * 60 * 60 * 1000;
  const plus7Date = new Date(plus7UtcNoon);
  return nyMidnightToUtc(
    plus7Date.getUTCFullYear(),
    plus7Date.getUTCMonth() + 1,
    plus7Date.getUTCDate(),
  );
}

// Convenience: [start, end) window for the week containing `instant`.
export function weekWindow(instant: Date): { start: Date; end: Date } {
  const start = startOfWeek(instant);
  return { start, end: endOfWeek(start) };
}

// A Monday-anchored week start offset by `n` weeks (n may be negative),
// DST-safe. Re-anchors via startOfWeek from a noon anchor that never sits near
// a midnight boundary a DST shift could move, so week enumeration (heatmap,
// records streaks) never drifts by an hour across a transition. This is the
// single shared week-stepping helper every new feature uses.
export function addWeeks(weekStart: Date, n: number): Date {
  const noonAnchor = weekStart.getTime() + 12 * 60 * 60 * 1000;
  return startOfWeek(new Date(noonAnchor + n * 7 * 24 * 60 * 60 * 1000));
}

// The most recent COMPLETED week relative to `now`: the week immediately
// before the in-progress week that contains `now`. The records streak and the
// Monday digest both key off this so "last week" means the same thing in both.
export function lastCompletedWeekStart(now: Date): Date {
  return addWeeks(startOfWeek(now), -1);
}

// Which 0-6 (Mon=0) NY calendar day a given instant falls on, relative to a
// week's start. Used for the per-day breakdown in /api/week.
export function dayIndexInWeek(instant: Date, weekStart: Date): number {
  const startParts = wallClockParts(weekStart);
  const startUtcNoon = Date.UTC(
    startParts.year,
    startParts.month - 1,
    startParts.day,
    12,
    0,
    0,
  );
  const instantParts = wallClockParts(instant);
  const instantUtcNoon = Date.UTC(
    instantParts.year,
    instantParts.month - 1,
    instantParts.day,
    12,
    0,
    0,
  );
  return Math.round((instantUtcNoon - startUtcNoon) / (24 * 60 * 60 * 1000));
}

// Format a Date as the ISO date (YYYY-MM-DD) of its America/New_York wall
// clock day — used for per-day breakdown keys and human-readable output.
export function nyDateString(instant: Date): string {
  const p = wallClockParts(instant);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

// --- G1 qualification -------------------------------------------------
//
// TELOS G1: "5 swim/bike sessions per week totaling >=8 hours". The sport
// vocabulary distinguishes outdoor cycling from Zwift (virtual_cycling), both
// of which count, plus swimming. This is the ONE named function every
// consumer (week summary, trends, MCP get_goal_progress) calls — ISC-47
// requires a single definition, never re-implemented inline.
export const G1_QUALIFYING_SPORTS = new Set([
  "cycling",
  "virtual_cycling",
  "swimming",
]);

export function isG1Qualifying(sport: string): boolean {
  return G1_QUALIFYING_SPORTS.has(sport);
}
