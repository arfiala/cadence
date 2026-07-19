// Monday digest (ISC-181, ISC-182, ISC-184). Covers a real last-completed
// week (sessions/hours, G1 verdict, PRs, races), a zero-data week (honest
// empty, invents nothing), and the read-only guarantee (no writes anywhere).

import { test, expect, describe, beforeEach } from "bun:test";
import { resetDb, insertActivity } from "./helpers";
import { computeDigest } from "../src/metrics/digest";
import { db } from "../src/db";

beforeEach(() => resetDb());

// current week starts Mon 2026-07-13, so the last COMPLETED week is
// Mon 2026-07-06 .. Sun 2026-07-12.
const NOW = new Date("2026-07-15T12:00:00Z");

function seedMetLastWeek(): void {
  for (let i = 0; i < 5; i++) {
    insertActivity({ sport: "cycling", start_time: "2026-07-06T12:00:00Z", duration_s: 7200, distance_m: 40000 });
  }
}

function seedRaceLastWeek(): void {
  db.query(
    "INSERT INTO zwiftpower_results (event_id, event_date, title, category, position) VALUES (?, ?, ?, ?, ?)",
  ).run("evt-1", "2026-07-08T18:00:00Z", "Tour Fever Stage 3", "B", 4);
}

describe("digest for a real last-completed week (ISC-181)", () => {
  test("reports sessions, hours, verdict, PRs, and races", () => {
    seedMetLastWeek();
    seedRaceLastWeek();

    const d = computeDigest(NOW);
    expect(d.week_start).toBe("2026-07-06");
    expect(d.sessions).toBe(5);
    expect(d.hours_g1).toBe(10);
    expect(d.g1_met).toBe(true);
    expect(d.verdict).toBe("G1 target met");
    expect(d.has_data).toBe(true);

    // First ever met week is also the biggest week -> a PR that week.
    expect(d.new_prs.map((p) => p.type)).toContain("biggest_week");

    expect(d.races.length).toBe(1);
    expect(d.races[0]?.title).toBe("Tour Fever Stage 3");
    expect(d.races[0]?.category).toBe("B");

    // Fitness/Fatigue/Form present as numbers.
    expect(typeof d.current.fitness).toBe("number");
    expect(typeof d.current.fatigue).toBe("number");
    expect(typeof d.current.form).toBe("number");
  });
});

describe("digest for a zero-data week (ISC-182)", () => {
  test("returns honest empty, inventing nothing", () => {
    const d = computeDigest(NOW);
    expect(d.has_data).toBe(false);
    expect(d.sessions).toBe(0);
    expect(d.hours_total).toBe(0);
    expect(d.g1_met).toBe(false);
    expect(d.verdict).toBe("G1 target not met");
    expect(d.new_prs).toEqual([]);
    expect(d.races).toEqual([]);
    expect(d.current).toEqual({ fitness: 0, fatigue: 0, form: 0 });
  });
});

describe("digest is read-only (ISC-184)", () => {
  test("computing the digest writes nothing to the database", () => {
    seedMetLastWeek();
    seedRaceLastWeek();

    const before = {
      activities: (db.query("SELECT COUNT(*) n FROM activities").get() as { n: number }).n,
      races: (db.query("SELECT COUNT(*) n FROM zwiftpower_results").get() as { n: number }).n,
      syncRuns: (db.query("SELECT COUNT(*) n FROM sync_runs").get() as { n: number }).n,
    };

    computeDigest(NOW);
    computeDigest(NOW);

    const after = {
      activities: (db.query("SELECT COUNT(*) n FROM activities").get() as { n: number }).n,
      races: (db.query("SELECT COUNT(*) n FROM zwiftpower_results").get() as { n: number }).n,
      syncRuns: (db.query("SELECT COUNT(*) n FROM sync_runs").get() as { n: number }).n,
    };

    expect(after).toEqual(before);
  });
});
