// Golf section tests (ISC-399..420). The load-bearing piece is the CHECK
// rebuild migration: it must preserve every activities row, every
// activity_details row (FK cascade survival), every index, and every id,
// on a database created with the PRE-golf schema. Also covers the raw_type
// remap, golf_score validation and clearing, the Garmin mapping, G1
// exclusion, and re-sync preservation.

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { db, runMigrations, SPORTS } from "../src/db";
import { mapGarminTypeToSport } from "../src/garmin/mapping";
import { computeWeekSummary } from "../src/services/weekSummary";
import { runSyncOnce } from "../src/garmin/sync";
import type { GarminClient, GarminActivity } from "../src/garmin/types";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";

// The activities DDL as it existed before golf (2026-07-21, commit 87739f5).
const PRE_GOLF_DDL = `
  CREATE TABLE activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL CHECK (source IN ('garmin','manual')),
    garmin_id TEXT UNIQUE,
    sport TEXT NOT NULL CHECK (sport IN ('cycling','virtual_cycling','swimming','running','strength','other')),
    raw_type TEXT,
    start_time TEXT NOT NULL,
    duration_s INTEGER NOT NULL,
    distance_m REAL,
    calories INTEGER,
    avg_hr INTEGER,
    title TEXT,
    notes TEXT,
    sport_edited INTEGER NOT NULL DEFAULT 0,
    title_edited INTEGER NOT NULL DEFAULT 0,
    notes_edited INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_activities_start_time ON activities(start_time);
  CREATE INDEX idx_activities_sport ON activities(sport);
  CREATE TABLE activity_details (
    activity_id INTEGER PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
    laps_json TEXT,
    polyline_json TEXT,
    detail_summary_json TEXT,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;

function makePreGolfDb(): Database {
  const d = new Database(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(PRE_GOLF_DDL);
  return d;
}

describe("golf CHECK rebuild migration", () => {
  test("rebuild preserves rows, details, ids, and indexes, and admits golf", () => {
    const d = makePreGolfDb();
    d.exec(
      `INSERT INTO activities (id, source, garmin_id, sport, raw_type, start_time, duration_s, notes)
       VALUES (7, 'garmin', 'g-1', 'other', 'golf', '2026-07-01T12:00:00Z', 14400, 'front nine felt good'),
              (9, 'manual', NULL, 'cycling', NULL, '2026-07-02T12:00:00Z', 3600, NULL)`,
    );
    d.exec("INSERT INTO activity_details (activity_id, laps_json) VALUES (7, '[]')");
    runMigrations(d);
    // golf admitted by the rebuilt CHECK
    d.exec(
      "INSERT INTO activities (source, sport, start_time, duration_s) VALUES ('manual','golf','2026-07-03T12:00:00Z',10800)",
    );
    // rows, ids, and user text preserved
    const a7 = d.query("SELECT * FROM activities WHERE id=7").get() as Record<string, unknown>;
    expect(a7.notes).toBe("front nine felt good");
    expect(a7.garmin_id).toBe("g-1");
    // the FK cascade child survived the rebuild (the advisor's oracle)
    expect((d.query("SELECT COUNT(*) c FROM activity_details").get() as { c: number }).c).toBe(1);
    // indexes recreated
    const idx = d
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='activities' AND sql IS NOT NULL")
      .all() as { name: string }[];
    expect(idx.map((i) => i.name).sort()).toEqual([
      "idx_activities_sport",
      "idx_activities_start_time",
    ]);
    // FK integrity clean
    expect(d.query("PRAGMA foreign_key_check").all().length).toBe(0);
    // cascade still works post-rebuild
    d.exec("DELETE FROM activities WHERE id=7");
    expect((d.query("SELECT COUNT(*) c FROM activity_details").get() as { c: number }).c).toBe(0);
  });

  test("raw_type golf rows are remapped to sport golf, others untouched", () => {
    const d = makePreGolfDb();
    d.exec(
      `INSERT INTO activities (source, sport, raw_type, start_time, duration_s)
       VALUES ('garmin', 'other', 'golf', '2026-07-01T12:00:00Z', 14400),
              ('garmin', 'other', 'disc_golf', '2026-07-01T15:00:00Z', 3600),
              ('garmin', 'running', 'trail_running', '2026-07-02T12:00:00Z', 1800)`,
    );
    runMigrations(d);
    const sports = d
      .query("SELECT raw_type, sport FROM activities ORDER BY id")
      .all() as { raw_type: string; sport: string }[];
    expect(sports[0]?.sport).toBe("golf");
    expect(sports[1]?.sport).toBe("other"); // disc golf is not a round of golf
    expect(sports[2]?.sport).toBe("running");
  });

  test("double boot is a no-op (idempotent)", () => {
    const d = makePreGolfDb();
    d.exec(
      "INSERT INTO activities (source, sport, start_time, duration_s) VALUES ('manual','cycling','2026-07-01T12:00:00Z',3600)",
    );
    runMigrations(d);
    const ddl1 = (d.query("SELECT sql FROM sqlite_master WHERE name='activities'").get() as { sql: string }).sql;
    runMigrations(d);
    const ddl2 = (d.query("SELECT sql FROM sqlite_master WHERE name='activities'").get() as { sql: string }).sql;
    expect(ddl2).toBe(ddl1);
    expect((d.query("SELECT COUNT(*) c FROM activities").get() as { c: number }).c).toBe(1);
  });

  test("fresh DB carries golf in the CHECK without any rebuild", () => {
    const d = new Database(":memory:");
    d.exec("PRAGMA foreign_keys = ON;");
    runMigrations(d);
    const ddl = (d.query("SELECT sql FROM sqlite_master WHERE name='activities'").get() as { sql: string }).sql;
    expect(ddl).toContain("'golf'");
  });
});

describe("golf sport + mapping", () => {
  test("SPORTS vocabulary includes golf", () => {
    expect((SPORTS as readonly string[]).includes("golf")).toBe(true);
  });
  test("Garmin typeKey golf maps to golf, disc_golf stays other", () => {
    expect(mapGarminTypeToSport("golf")).toBe("golf");
    expect(mapGarminTypeToSport("disc_golf")).toBe("other");
  });
});

describe("golf and G1", () => {
  beforeEach(() => resetDb());
  test("a golf round never counts toward G1 sessions or hours", () => {
    insertActivity({ sport: "golf", start_time: new Date().toISOString(), duration_s: 14400 });
    const week = computeWeekSummary(new Date());
    expect(week.sessions).toBe(0);
    expect(week.hours_g1).toBe(0);
  });
});

describe("golf_score API", () => {
  let token: string;
  beforeEach(() => {
    resetDb();
    db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
    token = seedToken();
  });

  test("valid score on a golf activity round-trips", async () => {
    const id = insertActivity({ sport: "golf", start_time: "2026-07-01T12:00:00Z", duration_s: 14400 });
    const res = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { golf_score: 92 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { golf_score: number } };
    expect(body.activity.golf_score).toBe(92);
  });

  test("score on a non-golf activity is refused with 422", async () => {
    const id = insertActivity({ sport: "cycling", start_time: "2026-07-01T12:00:00Z", duration_s: 3600 });
    const res = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { golf_score: 92 } });
    expect(res.status).toBe(422);
  });

  test("out-of-range and non-integer scores are rejected", async () => {
    const id = insertActivity({ sport: "golf", start_time: "2026-07-01T12:00:00Z", duration_s: 14400 });
    for (const bad of [17, 201, 88.5, "92"]) {
      const res = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { golf_score: bad } });
      expect(res.status).toBe(400);
    }
  });

  test("editing sport away from golf clears the stored score", async () => {
    const id = insertActivity({ sport: "golf", start_time: "2026-07-01T12:00:00Z", duration_s: 14400 });
    await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { golf_score: 95 } });
    const res = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: { sport: "other" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: { golf_score: number | null } };
    expect(body.activity.golf_score).toBeNull();
  });

  test("golf_score survives a Garmin re-sync", async () => {
    const garminActivity: GarminActivity = {
      garminId: "golf-77",
      typeKey: "golf",
      title: "Pine Valley front 18",
      startTimeUtc: "2026-07-01T12:00:00.000Z",
      durationSeconds: 14400,
      distanceMeters: 9000,
      calories: null,
      avgHr: null,
      avgPower: null,
      normPower: null,
    };
    const client: GarminClient = {
      listRecentActivities: async () => [garminActivity],
    };
    await runSyncOnce(client);
    const row = db.query("SELECT id, sport FROM activities WHERE garmin_id='golf-77'").get() as {
      id: number;
      sport: string;
    };
    expect(row.sport).toBe("golf");
    await apiRequest("PATCH", `/api/activities/${row.id}`, { token, body: { golf_score: 89 } });
    await runSyncOnce(client); // re-sync the same round
    const after = db.query("SELECT golf_score FROM activities WHERE id=?").get(row.id) as {
      golf_score: number | null;
    };
    expect(after.golf_score).toBe(89);
  });
});
