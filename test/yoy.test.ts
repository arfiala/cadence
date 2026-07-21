// Year-over-year tests (ISC-339, ISC-340, ISC-341). Seeds two years and checks
// the per-metric deltas, the per-metric insufficient_history fallback, and the
// ISO week-53 edge (prior year with only 52 weeks falls back to week 52).

import { test, expect, describe, beforeEach } from "bun:test";
import { computeYoy, isoWeekOfDate, weeksInIsoYear, mondayOfIsoWeek } from "../src/metrics/yoy";
import { resetDb, insertActivity } from "./helpers";

const NOW = new Date("2026-07-15T12:00:00Z"); // ISO week 29, iso year 2026

beforeEach(() => resetDb());

describe("ISO week helpers (ISC-341)", () => {
  test("isoWeekOfDate matches known values", () => {
    expect(isoWeekOfDate(2026, 7, 13)).toEqual({ isoYear: 2026, isoWeek: 29 });
    // 2026-01-01 is a Thursday, so 2026 is a 53-week ISO year.
    expect(weeksInIsoYear(2026)).toBe(53);
    // 2025 is an ordinary 52-week ISO year.
    expect(weeksInIsoYear(2025)).toBe(52);
  });

  test("mondayOfIsoWeek returns a Monday", () => {
    const monday = new Date(mondayOfIsoWeek(2025, 29));
    expect((monday.getUTCDay() + 6) % 7).toBe(0); // Mon=0
  });
});

describe("year-over-year deltas (ISC-339)", () => {
  test("compares this ISO week to the same ISO week last year", () => {
    // Current week: 3 G1 sessions, 4h total, 30 km distance.
    insertActivity({ sport: "cycling", start_time: "2026-07-13T14:00:00Z", duration_s: 3600, distance_m: 20000 });
    insertActivity({ sport: "swimming", start_time: "2026-07-14T14:00:00Z", duration_s: 3600, distance_m: 2000 });
    insertActivity({ sport: "cycling", start_time: "2026-07-15T11:00:00Z", duration_s: 7200, distance_m: 8000 });

    // Prior year, same ISO week (2025 week 29): 2 sessions, 2h, 15 km.
    const priorMondayMs = mondayOfIsoWeek(2025, 29);
    const wed = new Date(priorMondayMs + 2 * 24 * 3600 * 1000 + 14 * 3600 * 1000).toISOString();
    const thu = new Date(priorMondayMs + 3 * 24 * 3600 * 1000 + 14 * 3600 * 1000).toISOString();
    insertActivity({ sport: "cycling", start_time: wed, duration_s: 3600, distance_m: 10000 });
    insertActivity({ sport: "cycling", start_time: thu, duration_s: 3600, distance_m: 5000 });

    const yoy = computeYoy(NOW);
    expect(yoy.iso_week).toBe(29);
    expect(yoy.iso_year).toBe(2026);
    expect(yoy.prior_iso_year).toBe(2025);
    expect(yoy.prior_iso_week).toBe(29);

    expect(yoy.sessions).toMatchObject({ insufficient_history: false, current: 3, prior: 2, delta: 1 });
    expect(yoy.hours).toMatchObject({ insufficient_history: false, current: 4, prior: 2, delta: 2 });
    expect(yoy.distance).toMatchObject({ insufficient_history: false, current: 30000, prior: 15000, delta: 15000 });
  });

  test("per-metric insufficient_history when the prior-year week has no data (ISC-340)", () => {
    insertActivity({ sport: "cycling", start_time: "2026-07-13T14:00:00Z", duration_s: 3600, distance_m: 20000 });
    const yoy = computeYoy(NOW);
    expect(yoy.sessions).toMatchObject({ insufficient_history: true, current: 1 });
    expect(yoy.hours).toMatchObject({ insufficient_history: true });
    expect(yoy.distance).toMatchObject({ insufficient_history: true });
  });
});

describe("ISO week-53 edge (ISC-341)", () => {
  test("a week-53 current week compares to prior year week 52", () => {
    // A date inside ISO week 53 of 2026.
    const mondayW53 = mondayOfIsoWeek(2026, 53);
    const now = new Date(mondayW53 + 12 * 3600 * 1000);
    const yoy = computeYoy(now);
    expect(yoy.iso_week).toBe(53);
    expect(yoy.prior_iso_year).toBe(2025);
    expect(yoy.prior_iso_week).toBe(52); // 2025 has no week 53, so fall back
  });
});
