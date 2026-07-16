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
  error: string | null;
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

export function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS activities (
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
  `);

  // Seed default G1 targets exactly once (INSERT OR IGNORE so re-running
  // migrations, or a settings row a user already edited, is never clobbered).
  database.exec(`
    INSERT OR IGNORE INTO settings (key, value) VALUES ('target_sessions', '5');
    INSERT OR IGNORE INTO settings (key, value) VALUES ('target_hours', '8');
  `);
}

runMigrations(db);
