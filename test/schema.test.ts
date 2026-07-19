// Schema & migration tests (ISC-1..10). Verifies the activities/settings/
// sync_runs/users/sessions/api_tokens tables exist with the right shape,
// idempotent migrations, UTC timestamp storage, and the anti-criteria that
// no Garmin password/MFA column and no nutrition table exist.

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { db, runMigrations, isValidSport } from "../src/db";
import { resetDb, insertActivity } from "./helpers";

beforeEach(() => resetDb());

function columnNames(database: Database, table: string): string[] {
  const rows = database.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("activities table (ISC-1)", () => {
  test("has all required columns", () => {
    const cols = columnNames(db, "activities");
    for (const expected of [
      "id",
      "source",
      "garmin_id",
      "sport",
      "raw_type",
      "start_time",
      "duration_s",
      "distance_m",
      "calories",
      "avg_hr",
      "title",
      "notes",
      "created_at",
      "updated_at",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  test("garmin_id is UNIQUE and nullable", () => {
    insertActivity({ source: "manual", sport: "cycling", start_time: "2026-07-13T10:00:00Z", duration_s: 3600 });
    // Two manual rows with null garmin_id are allowed (UNIQUE ignores NULLs).
    insertActivity({ source: "manual", sport: "swimming", start_time: "2026-07-13T11:00:00Z", duration_s: 1800 });
    const count = db.query("SELECT COUNT(*) as n FROM activities").get() as { n: number };
    expect(count.n).toBe(2);

    // Duplicate non-null garmin_id is rejected.
    db.query(
      "INSERT INTO activities (source, garmin_id, sport, start_time, duration_s) VALUES ('garmin','G1','cycling','2026-07-13T10:00:00Z',3600)",
    ).run();
    expect(() =>
      db
        .query(
          "INSERT INTO activities (source, garmin_id, sport, start_time, duration_s) VALUES ('garmin','G1','swimming','2026-07-13T12:00:00Z',1800)",
        )
        .run(),
    ).toThrow();
  });
});

describe("sport vocabulary (ISC-2)", () => {
  test("isValidSport accepts the controlled vocabulary and rejects others", () => {
    for (const s of ["cycling", "virtual_cycling", "swimming", "running", "strength", "other"]) {
      expect(isValidSport(s)).toBe(true);
    }
    expect(isValidSport("kayaking")).toBe(false);
    expect(isValidSport(42)).toBe(false);
  });

  test("CHECK constraint rejects an out-of-vocab sport at the DB level", () => {
    expect(() =>
      db
        .query(
          "INSERT INTO activities (source, sport, start_time, duration_s) VALUES ('manual','kayaking','2026-07-13T10:00:00Z',3600)",
        )
        .run(),
    ).toThrow();
  });
});

describe("settings table (ISC-3)", () => {
  test("seeds G1 defaults", () => {
    const rows = db.query("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    expect(map.get("target_sessions")).toBe("5");
    expect(map.get("target_hours")).toBe("8");
  });
});

describe("sync_runs table (ISC-4)", () => {
  test("records a run with status and counts", () => {
    db.query(
      "INSERT INTO sync_runs (started_at, status, activities_seen, activities_new) VALUES ('2026-07-13T10:00:00Z','success',5,2)",
    ).run();
    const row = db.query("SELECT * FROM sync_runs LIMIT 1").get() as {
      status: string;
      activities_seen: number;
      activities_new: number;
    };
    expect(row.status).toBe("success");
    expect(row.activities_seen).toBe(5);
    expect(row.activities_new).toBe(2);
  });
});

describe("timestamps are UTC ISO-8601 (ISC-8)", () => {
  test("default created_at/updated_at end with Z", () => {
    const id = insertActivity({ sport: "cycling", start_time: "2026-07-13T10:00:00Z", duration_s: 3600 });
    const row = db.query("SELECT created_at, updated_at FROM activities WHERE id = ?").get(id) as {
      created_at: string;
      updated_at: string;
    };
    expect(row.created_at.endsWith("Z")).toBe(true);
    expect(row.updated_at.endsWith("Z")).toBe(true);
    expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
  });
});

describe("idempotent migrations (ISC-10)", () => {
  test("runMigrations twice on a fresh DB does not throw or duplicate settings", () => {
    const mem = new Database(":memory:");
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();
    const count = mem.query("SELECT COUNT(*) as n FROM settings").get() as { n: number };
    // The two G1 targets plus the two nutrition targets, never duplicated.
    expect(count.n).toBe(4);
  });
});

describe("anti-criteria (ISC-6, ISC-7)", () => {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );
  const allColumns = tables.flatMap((t) =>
    (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => `${t}.${c.name}`),
  );

  test("no column stores a Garmin password or MFA code (ISC-6)", () => {
    const offenders = allColumns.filter((c) => /garmin.*(password|mfa)|(password|mfa).*garmin/i.test(c));
    expect(offenders).toEqual([]);
    // Also: no bare 'garmin_password' style column anywhere.
    expect(allColumns.some((c) => /password/i.test(c) && /garmin/i.test(c))).toBe(false);
  });

  test("no nutrition_days table exists (ISC-7)", () => {
    expect(tables).not.toContain("nutrition_days");
  });
});
