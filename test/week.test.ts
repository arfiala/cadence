// Week-math tests (ISC-9, ISC-40, ISC-90). The DST-transition test is the
// load-bearing one: it proves week boundaries stay anchored to Monday 00:00
// America/New_York across a spring-forward, where a naive "add 168 hours"
// approach silently drifts by an hour.

import { test, expect, describe } from "bun:test";
import {
  startOfWeek,
  endOfWeek,
  isG1Qualifying,
  nyDateString,
  dayIndexInWeek,
} from "../src/week";

describe("startOfWeek", () => {
  test("anchors to Monday 00:00 America/New_York for a mid-week instant", () => {
    // Wednesday 2026-07-15 14:00 UTC is Wed 10:00 EDT — week starts Mon 2026-07-13.
    const start = startOfWeek(new Date("2026-07-15T14:00:00Z"));
    expect(nyDateString(start)).toBe("2026-07-13");
    // Monday 00:00 EDT (UTC-4) == 04:00 UTC.
    expect(start.toISOString()).toBe("2026-07-13T04:00:00.000Z");
  });

  test("a Monday just after local midnight belongs to its own week", () => {
    // Mon 2026-07-13 00:30 EDT == 04:30 UTC.
    const start = startOfWeek(new Date("2026-07-13T04:30:00Z"));
    expect(nyDateString(start)).toBe("2026-07-13");
  });

  test("a Sunday late-night local instant still belongs to the week that began Monday", () => {
    // Sun 2026-07-19 23:00 EDT == Mon 2026-07-20 03:00 UTC. Week start = Mon 07-13.
    const start = startOfWeek(new Date("2026-07-20T03:00:00Z"));
    expect(nyDateString(start)).toBe("2026-07-13");
  });

  test("an instant that is Sunday in UTC but Monday in NY is handled by wall clock", () => {
    // Actually the reverse case: Mon 00:30 UTC is still Sunday 20:30 EDT the
    // previous day, so it belongs to the PRIOR week.
    // Mon 2026-07-13 00:30 UTC == Sun 2026-07-12 20:30 EDT → week start 07-06.
    const start = startOfWeek(new Date("2026-07-13T00:30:00Z"));
    expect(nyDateString(start)).toBe("2026-07-06");
  });
});

describe("DST transitions (ISC-90)", () => {
  test("spring-forward week: Monday boundary stays at local midnight, week is <168h", () => {
    // US spring-forward 2026 is Sun 2026-03-08 02:00→03:00. The week
    // containing it starts Mon 2026-03-02 00:00 EST (UTC-5 == 05:00 UTC).
    const anyInstant = new Date("2026-03-04T12:00:00Z"); // Wed of that week
    const start = startOfWeek(anyInstant);
    expect(nyDateString(start)).toBe("2026-03-02");
    expect(start.toISOString()).toBe("2026-03-02T05:00:00.000Z");

    const end = endOfWeek(start);
    // Next Monday 2026-03-09 00:00 is now EDT (UTC-4 == 04:00 UTC).
    expect(nyDateString(end)).toBe("2026-03-09");
    expect(end.toISOString()).toBe("2026-03-09T04:00:00.000Z");

    // The week spans exactly 7 calendar days but only 167 hours (one hour
    // was skipped) — proof the math is calendar-based, not fixed-offset.
    const hours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(167);
  });

  test("fall-back week spans 169 hours", () => {
    // US fall-back 2026 is Sun 2026-11-01 02:00→01:00. Week starts Mon
    // 2026-10-26 00:00 EDT (UTC-4 == 04:00 UTC).
    const start = startOfWeek(new Date("2026-10-28T12:00:00Z"));
    expect(nyDateString(start)).toBe("2026-10-26");
    expect(start.toISOString()).toBe("2026-10-26T04:00:00.000Z");

    const end = endOfWeek(start);
    // Next Monday 2026-11-02 00:00 is EST (UTC-5 == 05:00 UTC).
    expect(end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const hours = (end.getTime() - start.getTime()) / (60 * 60 * 1000);
    expect(hours).toBe(169);
  });
});

describe("dayIndexInWeek", () => {
  test("maps each day of a normal week to 0..6", () => {
    const start = startOfWeek(new Date("2026-07-15T14:00:00Z")); // Mon 07-13
    expect(dayIndexInWeek(new Date("2026-07-13T12:00:00Z"), start)).toBe(0); // Mon
    expect(dayIndexInWeek(new Date("2026-07-15T12:00:00Z"), start)).toBe(2); // Wed
    expect(dayIndexInWeek(new Date("2026-07-19T12:00:00Z"), start)).toBe(6); // Sun
  });

  test("stays correct across the spring-forward day", () => {
    const start = startOfWeek(new Date("2026-03-04T12:00:00Z")); // Mon 03-02
    // Sunday 2026-03-08 (the DST day) is day index 6.
    expect(dayIndexInWeek(new Date("2026-03-08T18:00:00Z"), start)).toBe(6);
  });
});

describe("isG1Qualifying (ISC-47)", () => {
  test("cycling, virtual_cycling, and swimming qualify", () => {
    expect(isG1Qualifying("cycling")).toBe(true);
    expect(isG1Qualifying("virtual_cycling")).toBe(true);
    expect(isG1Qualifying("swimming")).toBe(true);
  });
  test("running, strength, and other do NOT qualify", () => {
    expect(isG1Qualifying("running")).toBe(false);
    expect(isG1Qualifying("strength")).toBe(false);
    expect(isG1Qualifying("other")).toBe(false);
  });
});
