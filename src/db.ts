// SQLite setup for Cadence. Exports a single shared `db` instance and runs
// migrations on import (same pattern as Suretas's src/db.ts, read for
// reference) — bun:sqlite only, no ORM, prepared statements everywhere.
//
// DB_PATH controls where the file lives; default is a relative path for dev
// convenience, production sets it via env. WAL mode is enabled (ISC-5) and
// the file is chmod'd to 600 immediately after creation so activity data is
// never world/group readable on disk (ISC-5, "Health data is private by
// construction").

import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

const databasePath = process.env.DB_PATH ?? "./cadence.db";
const isNewFile = !existsSync(databasePath) && databasePath !== ":memory:";

export const db = new Database(databasePath, { create: true });

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

if (isNewFile && existsSync(databasePath)) {
  // mode 600: owner read/write only. Applied only on first creation; an
  // operator who intentionally loosens permissions later is not fought.
  chmodSync(databasePath, 0o600);
}

// Controlled sport vocabulary (ISC-2). `raw_type` on each row preserves
// whatever Garmin's activityType.typeKey actually said, so the mapping table
// in src/garmin/sync.ts can evolve without losing information.
export const SPORTS = [
  "cycling",
  "virtual_cycling",
  "swimming",
  "running",
  "strength",
  "other",
  "golf",
] as const;
export type Sport = (typeof SPORTS)[number];
export function isValidSport(value: unknown): value is Sport {
  return typeof value === "string" && (SPORTS as readonly string[]).includes(value);
}

export const SOURCES = ["garmin", "manual"] as const;
export type Source = (typeof SOURCES)[number];

export type ActivityRow = {
  id: number;
  source: Source;
  garmin_id: string | null;
  sport: Sport;
  raw_type: string | null;
  start_time: string; // UTC ISO-8601
  duration_s: number;
  distance_m: number | null;
  calories: number | null;
  avg_hr: number | null;
  // Power metrics (ISC-135), nullable. Populated by Garmin sync only when the
  // activity summary carries power (power-meter or smart-trainer rides); every
  // other row leaves them null. The training-load engine reads these when
  // present to compute a power-based load, otherwise falls back to HR or
  // duration. Never user-editable.
  avg_power: number | null;
  norm_power: number | null;
  // Rate of Perceived Exertion, 1..10, nullable (ISC-296). A Cadence-only
  // field Garmin never supplies, so the Garmin sync never writes it and a
  // re-sync can never clobber an entered value (ISC-298), the same
  // preservation-by-construction that protects `notes`. Feeds the training-load
  // engine's sRPE tier only when no power/HR-based load applies (ISC-299).
  rpe: number | null;
  golf_score: number | null;
  title: string | null;
  notes: string | null;
  // Field-level edit flags (ISC-27): once a user edits one of these fields on
  // a Garmin-sourced row, re-sync must never clobber it. duration/distance
  // (and calories/avg_hr) are never user-editable on Garmin rows and always
  // reflect Garmin's numbers, so they carry no edit flag.
  sport_edited: 0 | 1;
  title_edited: 0 | 1;
  notes_edited: 0 | 1;
  created_at: string;
  updated_at: string;
};

export type SyncRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "error";
  activities_seen: number;
  activities_new: number;
  // Sleep nights processed in the same run (ISC-243). Nullable/defaulted to 0
  // via guarded ALTER so pre-sleep sync_runs rows read back as 0, not null.
  sleep_seen: number;
  sleep_new: number;
  error: string | null;
};

// One row per night of Garmin sleep (ISC-243). calendar_date is the night's
// local calendar day and is UNIQUE, so re-syncing the same night is
// idempotent (ISC-245) — exactly the zwiftpower_results / event_id pattern.
// Every metric is nullable because Garmin returns partial nights. This table
// is entirely separate from `activities` and never feeds the G1 training
// metric (ISC-249): sleep is context, not a workout.
export type SleepRow = {
  id: number;
  calendar_date: string; // YYYY-MM-DD (natural key, UNIQUE)
  start_time: string | null; // UTC ISO-8601
  end_time: string | null; // UTC ISO-8601
  total_sleep_s: number | null;
  deep_s: number | null;
  light_s: number | null;
  rem_s: number | null;
  awake_s: number | null;
  score: number | null; // Garmin overall sleep score (0-100) when present
  created_at: string;
  updated_at: string;
};

export type UserRow = {
  id: number;
  email: string;
  password_hash: string | null;
  failed_login_attempts: number;
  locked_until: string | null;
  created_at: string;
};

export type SessionRow = {
  id: string;
  user_id: number;
  expires_at: string;
  created_at: string;
};

export type ApiTokenRow = {
  id: number;
  token_hash: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
};

// One row per ZwiftPower race result for the rider (ISC-121). Keyed on the
// ZwiftPower event id (`event_id`, UNIQUE) so re-syncing the same result is
// idempotent (ISC-122). Power metrics are nullable because not every result
// carries them, and a rider category is only stored when ZwiftPower supplies
// one (ISC-123). This table is entirely separate from `activities`, since race
// results are not training activities (ISC-128).
export type ZwiftPowerResultRow = {
  id: number;
  event_id: string;
  event_date: string | null; // UTC ISO-8601
  title: string | null;
  category: string | null; // A/B/C/D/E when provided, else null
  position: number | null;
  avg_power: number | null; // watts
  norm_power: number | null; // watts
  time_s: number | null; // race time in seconds
  weight_kg: number | null; // rider body weight (kg) recorded by Zwift at ride time
  created_at: string;
  updated_at: string;
};

// One row per logged meal/snack (ISC-189). Nutrition is deliberately its own
// spine, entirely separate from `activities`: it never feeds the G1 training
// metric (ISC-214). `kcal`/macros are the computed sum of the entry's items,
// recomputed on every save/edit so the header numbers can never drift from the
// itemized rows. `source` records provenance: 'estimated' (LLM), 'manual'
// (hand-entered), or 'edited' (an estimate a human corrected). `logged_date` is
// the America/New_York calendar day (YYYY-MM-DD) the meal belongs to, so the
// day rollup groups on a plain string with no timezone math at query time.
export type NutritionEntryRow = {
  id: number;
  logged_date: string; // YYYY-MM-DD (America/New_York calendar day)
  logged_at: string; // UTC ISO-8601 instant the entry was logged
  description: string | null;
  source: "estimated" | "manual" | "edited";
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

// One row per food item inside an entry (ISC-190). Deleting the parent entry
// cascades these away (ON DELETE CASCADE, foreign_keys is ON in this
// connection). The per-item numbers are what the entry totals are summed from.
export type NutritionItemRow = {
  id: number;
  entry_id: number;
  food: string;
  quantity: string | null;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
};

// Cached, normalized per-activity Garmin detail (ISC-318). Only validated
// shapes are stored in the *_json columns (a laps array, a decimated polyline,
// a small summary object), never the raw unknown Garmin payloads.
export type ActivityDetailRow = {
  activity_id: number;
  laps_json: string | null;
  polyline_json: string | null;
  detail_summary_json: string | null;
  fetched_at: string;
};

// One dismissed duplicate pair (ISC-308), keyed on the stable (min,max) ids.
export type DuplicateDismissalRow = {
  id: number;
  a_id: number;
  b_id: number;
  created_at: string;
};

// One ZwiftPower critical-power best effort (ISC-342), one row per
// (duration_s, event_date).
export type PowerCurveEffortRow = {
  id: number;
  duration_s: number;
  watts: number;
  event_date: string;
  event_id: string | null;
  fetched_at: string;
};

// One row per ZwiftPower sync attempt, including failures (ISC-124), mirroring
// sync_runs but kept separate so the Garmin sync history stays clean.
export type ZwiftPowerSyncRunRow = {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: "running" | "success" | "error";
  results_seen: number;
  results_new: number;
  error: string | null;
};

// Guarded ALTER: add a column only if it is not already present. SQLite has
// no "ADD COLUMN IF NOT EXISTS", so we probe pragma_table_info first, the
// same idempotent-migration discipline as the CREATE TABLE IF NOT EXISTS
// statements (ISC-10, ISC-135). Safe to run on every boot.
function addColumnIfMissing(
  database: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const cols = database
    .query(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}

// Adds 'golf' to the activities sport CHECK constraint on databases created
// before 2026-07-23. SQLite cannot ALTER a CHECK, so this is a guarded table
// rebuild. Discipline per the advisor pass (ISA Decisions 2026-07-23):
// - PRAGMA foreign_keys is a NO-OP inside a transaction, so it is toggled
//   OUTSIDE the txn and restored in finally on every exit path. Without this
//   the DROP would cascade-delete every activity_details row.
// - The new DDL is the REAL DDL read from sqlite_master with only the CHECK
//   fragment modified, never hand-retyped.
// - Every dependent object (indexes, triggers, views) is captured from
//   sqlite_master and re-executed after the rename.
// - Row counts of activities AND activity_details are asserted unchanged.
function rebuildActivitiesForGolf(database: Database): void {
  const row = database
    .query("SELECT sql FROM sqlite_master WHERE type='table' AND name='activities'")
    .get() as { sql: string } | null;
  if (!row) return; // fresh DB: CREATE below already carries golf
  if (row.sql.includes("'golf'")) return; // already rebuilt
  const oldCheck = "CHECK (sport IN ('cycling','virtual_cycling','swimming','running','strength','other'))";
  if (!row.sql.includes(oldCheck)) {
    throw new Error("golf rebuild: activities CHECK fragment not found; refusing to guess at DDL");
  }
  // activity_details may not exist yet on DBs older than Wave 1 (prod at the
  // time this ships): count it only when present.
  const hasDetails =
    database
      .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_details'")
      .get() !== null;
  const countDetails = () =>
    hasDetails
      ? (database.query("SELECT COUNT(*) c FROM activity_details").get() as { c: number }).c
      : 0;
  const before = {
    activities: (database.query("SELECT COUNT(*) c FROM activities").get() as { c: number }).c,
    details: countDetails(),
  };
  const dependents = database
    .query(
      "SELECT sql FROM sqlite_master WHERE tbl_name='activities' AND type IN ('index','trigger','view') AND sql IS NOT NULL",
    )
    .all() as { sql: string }[];
  const newDdl = row.sql
    .replace(oldCheck, oldCheck.replace(",'other')", ",'other','golf')"))
    .replace(/CREATE TABLE "?activities"?/, "CREATE TABLE activities_new");
  database.exec("PRAGMA foreign_keys=OFF");
  try {
    database.exec("BEGIN");
    const cols = (database.query("PRAGMA table_info(activities)").all() as { name: string }[])
      .map((c) => `"${c.name}"`)
      .join(", ");
    database.exec(newDdl);
    database.exec(`INSERT INTO activities_new (${cols}) SELECT ${cols} FROM activities`);
    database.exec("DROP TABLE activities");
    database.exec("ALTER TABLE activities_new RENAME TO activities");
    for (const dep of dependents) database.exec(dep.sql);
    database.exec("COMMIT");
  } catch (err) {
    database.exec("ROLLBACK");
    throw err;
  } finally {
    database.exec("PRAGMA foreign_keys=ON");
  }
  const fkErrors = database.query("PRAGMA foreign_key_check").all();
  if (fkErrors.length > 0) {
    throw new Error(`golf rebuild: foreign_key_check reported ${fkErrors.length} violations`);
  }
  const after = {
    activities: (database.query("SELECT COUNT(*) c FROM activities").get() as { c: number }).c,
    details: countDetails(),
  };
  if (after.activities !== before.activities || after.details !== before.details) {
    throw new Error(
      `golf rebuild: row count changed (activities ${before.activities}->${after.activities}, details ${before.details}->${after.details})`,
    );
  }
}

// Garmin typeKeys that mean a round of golf. Kept separate from the schema
// rebuild so a rollback of one is never entangled with the other
// (advisor-raised provenance discipline). Idempotent: once remapped, no
// sport='other' golf rows remain.
const GOLF_TYPE_KEYS = ["golf"];
function remapGolfRows(database: Database): void {
  const placeholders = GOLF_TYPE_KEYS.map(() => "?").join(",");
  database
    .query(`UPDATE activities SET sport='golf' WHERE sport='other' AND raw_type IN (${placeholders})`)
    .run(...GOLF_TYPE_KEYS);
}

export function runMigrations(database: Database): void {
  rebuildActivitiesForGolf(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK (source IN ('garmin','manual')),
      garmin_id TEXT UNIQUE,
      sport TEXT NOT NULL CHECK (sport IN ('cycling','virtual_cycling','swimming','running','strength','other','golf')),
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

    CREATE INDEX IF NOT EXISTS idx_activities_start_time ON activities(start_time);
    CREATE INDEX IF NOT EXISTS idx_activities_sport ON activities(sport);

    -- Single-row-per-key settings table (ISC-3). Seeded with G1 defaults
    -- (sessions=5, hours=8) below, editable via PATCH /api/settings without
    -- a redeploy.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- One row per Garmin sync attempt (ISC-4), including failed ones, so
    -- /api/sync/status and the "Sync now" UI can show real history without
    -- ever crashing the server on a sync failure (ISC-28).
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running','success','error')),
      activities_seen INTEGER NOT NULL DEFAULT 0,
      activities_new INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    -- Single-user auth. No registration endpoint ever writes here — only
    -- bin/set-password.ts (ISC-17). Only ever holds one row; auth.ts refuses
    -- to create a second.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      failed_login_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- Bearer tokens for the MCP server / API clients (ISC-20). Only the
    -- SHA-256 hash is ever stored; bin/issue-token.ts prints the raw token
    -- once, at issue time, and it is never recoverable from the DB.
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT UNIQUE NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      revoked_at TEXT
    );

    -- ZwiftPower race results (ISC-121). event_id (the ZwiftPower event/result
    -- id) is UNIQUE so re-sync is idempotent (ISC-122). Never holds Zwift
    -- credentials, which live only in the box .env (ISC-120).
    CREATE TABLE IF NOT EXISTS zwiftpower_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      event_date TEXT,
      title TEXT,
      category TEXT,
      position INTEGER,
      avg_power INTEGER,
      norm_power INTEGER,
      time_s INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_zp_results_date ON zwiftpower_results(event_date);

    -- One row per ZwiftPower sync attempt, including failed ones (ISC-124),
    -- kept separate from Garmin's sync_runs so each history stays clean.
    CREATE TABLE IF NOT EXISTS zwiftpower_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('running','success','error')),
      results_seen INTEGER NOT NULL DEFAULT 0,
      results_new INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    -- Nutrition entries (ISC-189). One row per logged meal/snack. kcal and the
    -- macro columns are the computed sum of the entry items, written on every
    -- save/edit. source records provenance ('estimated' from the LLM, 'manual'
    -- hand-entered, 'edited' an estimate a human corrected). This spine is
    -- entirely separate from the activities table and never feeds the G1 metric
    -- (ISC-214). logged_date is the America/New_York calendar day so the daily
    -- rollup groups on a plain string.
    CREATE TABLE IF NOT EXISTS nutrition_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      logged_date TEXT NOT NULL,
      logged_at TEXT NOT NULL,
      description TEXT,
      source TEXT NOT NULL CHECK (source IN ('estimated','manual','edited')),
      kcal INTEGER NOT NULL DEFAULT 0,
      protein_g REAL NOT NULL DEFAULT 0,
      carbs_g REAL NOT NULL DEFAULT 0,
      fat_g REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_nutrition_entries_logged_date ON nutrition_entries(logged_date);

    -- Itemized foods inside an entry (ISC-190). Deleting the parent entry
    -- cascades these away (foreign_keys is ON in this connection). The entry's
    -- header totals are the sum of these rows.
    CREATE TABLE IF NOT EXISTS nutrition_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL REFERENCES nutrition_entries(id) ON DELETE CASCADE,
      food TEXT NOT NULL,
      quantity TEXT,
      kcal INTEGER NOT NULL DEFAULT 0,
      protein_g REAL NOT NULL DEFAULT 0,
      carbs_g REAL NOT NULL DEFAULT 0,
      fat_g REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_nutrition_items_entry ON nutrition_items(entry_id);

    -- Nightly Garmin sleep (ISC-243). calendar_date UNIQUE makes re-sync
    -- idempotent (ISC-245). Separate from activities; never feeds G1 (ISC-249).
    CREATE TABLE IF NOT EXISTS sleep (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_date TEXT UNIQUE NOT NULL,
      start_time TEXT,
      end_time TEXT,
      total_sleep_s INTEGER,
      deep_s INTEGER,
      light_s INTEGER,
      rem_s INTEGER,
      awake_s INTEGER,
      score INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sleep_date ON sleep(calendar_date);

    -- Lazily-fetched, cached per-activity Garmin detail (ISC-318). One row per
    -- activity, keyed on activity_id, ON DELETE CASCADE so deleting an activity
    -- removes its cached detail (ISC-327). Only VALIDATED, normalized shapes are
    -- ever stored here (laps, a decimated GPS polyline, a small summary), never
    -- the raw unknown-typed Garmin payloads. Populated on first detail view of a
    -- Garmin-sourced activity, refreshed on demand; the Garmin sync never writes
    -- here (ISC-320).
    CREATE TABLE IF NOT EXISTS activity_details (
      activity_id INTEGER PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
      laps_json TEXT,
      polyline_json TEXT,
      detail_summary_json TEXT,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- Dismissed duplicate pairs (ISC-308). Keyed on the stable (min id, max id)
    -- pair so the same two activities always resolve to one row regardless of
    -- the order they were compared in. A dismissed pair is excluded from the
    -- duplicate candidate list forever, even across re-sync (ISC-309), until it
    -- is explicitly undismissed.
    CREATE TABLE IF NOT EXISTS duplicate_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      a_id INTEGER NOT NULL,
      b_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(a_id, b_id)
    );

    -- Tombstone for Garmin ids whose activity was the loser of a duplicate
    -- merge (ISC-315). The Garmin sync checks this before inserting, so a
    -- merged-away Garmin activity can never be resurrected by a later re-sync.
    CREATE TABLE IF NOT EXISTS merged_garmin_ids (
      garmin_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- ZwiftPower critical-power best efforts (ISC-342). One row per
    -- (duration_s, event_date) so repeated fetches of the same effort are
    -- idempotent. The rolling-90-day best per duration is computed at read time
    -- (ISC-343) by filtering on event_date, never precomputed here. Cycling-only
    -- by construction: the source is ZwiftPower (ISC-345).
    CREATE TABLE IF NOT EXISTS power_curve_efforts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      duration_s INTEGER NOT NULL,
      watts INTEGER NOT NULL,
      event_date TEXT NOT NULL,
      event_id TEXT,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(duration_s, event_date)
    );
    CREATE INDEX IF NOT EXISTS idx_power_curve_duration ON power_curve_efforts(duration_s);
  `);

  // RPE on activities (ISC-296), guarded ALTER so an existing production DB
  // gains the nullable column without a rebuild and a double run is a no-op
  // (ISC-347). Range 1..10 is enforced at the route/MCP layer, not by a DB
  // CHECK, so the ALTER cannot fail on any existing row.
  addColumnIfMissing(database, "activities", "rpe", "INTEGER");

  // Golf score on activities (ISC-405), guarded ALTER. Sanity range 18..200
  // enforced at the route/MCP layer. The remap of pre-golf rows whose
  // raw_type is a golf typeKey runs right after, as its own step (ISC-401).
  addColumnIfMissing(database, "activities", "golf_score", "INTEGER");
  remapGolfRows(database);

  // Garmin Golf scorecards (ISC-423), synced best-effort from the Garmin Golf
  // backend. Keyed on Garmin's own scorecard id (UNIQUE) so re-sync is
  // idempotent. round_date is the America/New_York calendar day derived from
  // start_time, used to match scorecards to golf activities. Entirely separate
  // from activities; never feeds G1 or the load engine (ISC-434).
  database.exec(`
    CREATE TABLE IF NOT EXISTS golf_scorecards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scorecard_id TEXT NOT NULL UNIQUE,
      course_name TEXT,
      start_time TEXT,
      round_date TEXT,
      strokes INTEGER,
      holes_played INTEGER,
      round_type TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // Power columns on activities (ISC-135), added via the guarded ALTER so an
  // existing production DB gains them without a rebuild and a fresh DB is
  // unaffected by the double run (ISC-10).
  addColumnIfMissing(database, "activities", "avg_power", "INTEGER");
  addColumnIfMissing(database, "activities", "norm_power", "INTEGER");

  // Sleep tallies on sync_runs (ISC-243), added via the guarded ALTER so an
  // existing production sync_runs table gains them (defaulting to 0 on every
  // historical row) without a rebuild.
  addColumnIfMissing(database, "sync_runs", "sleep_seen", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(database, "sync_runs", "sleep_new", "INTEGER NOT NULL DEFAULT 0");

  // Rider weight on ZwiftPower results (dashboard weight-progress widget),
  // guarded ALTER so an existing prod table gains it (null on historical rows
  // until the next sync re-populates them) without a rebuild.
  addColumnIfMissing(database, "zwiftpower_results", "weight_kg", "REAL");

  // Seed default G1 targets exactly once (INSERT OR IGNORE so re-running
  // migrations, or a settings row a user already edited, is never clobbered).
  database.exec(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('target_sessions', '5');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('target_hours', '8');
  `);

  // Seed default nutrition targets exactly once (ISC-191), same INSERT OR
  // IGNORE discipline so a target Austin already edited is never clobbered.
  database.exec(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('nutrition_target_kcal', '2200');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('nutrition_target_protein_g', '150');
  `);

  // Planned workouts (training plan feature). Guarded additive table; content
  // arrives only via bin/seed-plan.ts, never at boot, so migrations stay
  // data-free and a double run is a no-op. status transitions are enforced by
  // the CHECK here plus route-layer validation. Entirely separate from
  // activities: nothing in G1, the load engine, or sync reads this table.
  database.exec(`
    CREATE TABLE IF NOT EXISTS planned_workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_day TEXT NOT NULL,
      sport TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      duration_min INTEGER NOT NULL DEFAULT 0,
      distance_m INTEGER,
      target TEXT,
      tss_planned INTEGER,
      week_no INTEGER NOT NULL,
      phase TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','skipped')),
      activity_id INTEGER,
      sort INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_planned_workouts_day ON planned_workouts(plan_day);
  `);

  // Adaptive plan engine (guarded ALTERs, safe on the live seeded table).
  addColumnIfMissing(database, "planned_workouts", "kind", "TEXT");
  addColumnIfMissing(database, "planned_workouts", "time_hint", "TEXT");
  addColumnIfMissing(database, "planned_workouts", "done_source", "TEXT");
  addColumnIfMissing(database, "planned_workouts", "adjusted", "INTEGER NOT NULL DEFAULT 0");

  // Kind backfill for rows seeded before the column existed. Deterministic
  // from the stable title prefixes; WHERE kind IS NULL makes a re-run a no-op.
  database.exec(`
    UPDATE planned_workouts SET kind = CASE
      WHEN title LIKE 'Zwift race%' THEN 'race'
      WHEN title LIKE 'Long ride%' THEN 'long_ride'
      WHEN title LIKE 'Long run%' THEN 'long_run'
      WHEN title LIKE 'Easy run%' THEN 'easy_run'
      WHEN title LIKE 'Easy spin%' THEN 'spin'
      WHEN title LIKE 'Strength A%' THEN 'strength_a'
      WHEN title LIKE 'Strength B%' THEN 'strength_b'
      WHEN title LIKE 'Brick run%' THEN 'brick'
      ELSE 'rest' END
    WHERE kind IS NULL;
  `);

  // Every adaptation the engine makes, human-readable, newest-first feed.
  database.exec(`
    CREATE TABLE IF NOT EXISTS plan_adaptations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      effective_from TEXT NOT NULL,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      reason TEXT NOT NULL,
      session_id INTEGER,
      activity_id INTEGER
    );
  `);

  // Garmin Training Readiness, one row per calendar day (UNIQUE upsert).
  // Display-only for now; the adaptive engine deliberately does not read it
  // yet (gating is a separate, careful step).
  database.exec(`
    CREATE TABLE IF NOT EXISTS readiness (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      calendar_date TEXT NOT NULL UNIQUE,
      score INTEGER NOT NULL,
      level TEXT,
      fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);

  // Durable auto-done idempotence: the same session/activity pair records one
  // auto_done row even if the in-process guard is ever lost. (Activity
  // start_time already carries idx_activities_start_time from the golf
  // rebuild, so the adapt pass's trailing windows need no new index.)
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_adapt_autodone_pair
      ON plan_adaptations(kind, session_id, activity_id)
      WHERE kind = 'auto_done';
  `);
}

runMigrations(db);
