// Consistency heatmap data (ISC-165..168, ISC-171). The load-bearing check is
// DST bucketing: an activity must land on the same America/New_York calendar
// day the rest of the app uses (matching series.ts / week.ts), so a heatmap
// cell never drifts by a day across a spring-forward.

import { test, expect, describe, beforeEach } from "bun:test";
import { resetDb, insertActivity } from "./helpers";
import { computeConsistency } from "../src/metrics/consistency";

beforeEach(() => resetDb());

describe("computeConsistency shape (ISC-165)", () => {
  test("returns exactly 52 weeks of 7 days each with targets", () => {
    const c = computeConsistency(new Date("2026-07-15T12:00:00Z"));
    expect(c.weeks.length).toBe(52);
    for (const w of c.weeks) expect(w.days.length).toBe(7);
    expect(c.target_sessions).toBe(5);
    expect(c.target_hours).toBe(8);
  });

  test("empty history yields all-zero minutes and no G1 weeks", () => {
    const c = computeConsistency(new Date("2026-07-15T12:00:00Z"));
    const anyMinutes = c.weeks.some((w) => w.days.some((d) => d.minutes > 0));
    const anyMet = c.weeks.some((w) => w.g1_met);
    expect(anyMinutes).toBe(false);
    expect(anyMet).toBe(false);
  });
});

describe("America/New_York day bucketing across DST (ISC-166)", () => {
  test("spring-forward: instants bucket to the correct NY day, matching series.ts", () => {
    // 04:30 UTC on 2026-03-08 is 23:30 EST on 2026-03-07 (still EST, the
    // transition is at 02:00 local). 18:00 UTC is 14:00 EDT on 2026-03-08.
    insertActivity({ sport: "cycling", start_time: "2026-03-08T04:30:00Z", duration_s: 3600 });
    insertActivity({ sport: "running", start_time: "2026-03-08T18:00:00Z", duration_s: 1800 });

    const c = computeConsistency(new Date("2026-03-16T12:00:00Z"));
    const cells = c.weeks.flatMap((w) => w.days);
    const mar7 = cells.find((d) => d.date === "2026-03-07");
    const mar8 = cells.find((d) => d.date === "2026-03-08");

    expect(mar7?.minutes).toBe(60);
    expect(mar8?.minutes).toBe(30);
  });
});

describe("G1-met week flag (ISC-168)", () => {
  test("a week hitting both targets is flagged, a shortfall week is not", () => {
    // Five 2h cycling sessions on one day = 5 sessions, 10h in that week.
    for (let i = 0; i < 5; i++) {
      insertActivity({ sport: "cycling", start_time: "2026-06-03T12:00:00Z", duration_s: 7200 });
    }
    // A different week with only one session, well short of target.
    insertActivity({ sport: "cycling", start_time: "2026-05-06T12:00:00Z", duration_s: 3600 });

    const c = computeConsistency(new Date("2026-07-15T12:00:00Z"));
    const metWeek = c.weeks.find((w) => w.days.some((d) => d.date === "2026-06-03"));
    const shortWeek = c.weeks.find((w) => w.days.some((d) => d.date === "2026-05-06"));

    expect(metWeek?.g1_met).toBe(true);
    expect(shortWeek?.g1_met).toBe(false);
  });
});
