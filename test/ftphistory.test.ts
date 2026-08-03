// FTP history tests: the ftp_history log written by the Zwift sync seam and
// manual settings edits, the per-day series collapse, and the
// /api/metrics/ftp-history route. The migration seed path is covered by
// construction (guarded on an empty table) and proven at deploy rehearsal;
// these tests exercise the steady-state behavior.

import { test, expect, describe, beforeEach } from "bun:test";
import { db, runMigrations } from "../src/db";
import { nyDateString } from "../src/week";
import { resetDb, seedToken, apiRequest } from "./helpers";
import { syncFtpFromZwift } from "../src/services/ftpSync";
import { computeFtpSeries, recordFtpChange } from "../src/metrics/ftpHistory";
import type { ZwiftPowerClient } from "../src/zwiftpower/types";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function setFtp(v: number): void {
  db.query(
    "INSERT INTO settings (key, value) VALUES ('ftp_watts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(v));
}
function historyRows(): { recorded_on: string; watts: number; source: string }[] {
  return db
    .query("SELECT recorded_on, watts, source FROM ftp_history ORDER BY id ASC")
    .all() as { recorded_on: string; watts: number; source: string }[];
}
function fakeClient(ftp: number | null): ZwiftPowerClient {
  return { async listRiderResults() { return []; }, async getZwiftFtp() { return ftp; } };
}

describe("FTP history writes", () => {
  test("an accepted Zwift change lands one zwift-source row", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(175))).toBe(true);
    const rows = historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.watts).toBe(175);
    expect(rows[0]?.source).toBe("zwift");
  });

  test("an unchanged Zwift reading writes no history", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(169))).toBe(false);
    expect(historyRows().length).toBe(0);
  });

  test("a rejected glitch (over 30 percent step) writes no history", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(300))).toBe(false);
    expect(historyRows().length).toBe(0);
  });

  test("a manual settings change writes one manual-source row", async () => {
    setFtp(169);
    const res = await apiRequest("PATCH", "/api/settings", { token, body: { ftp_watts: 180 } });
    expect(res.status).toBe(200);
    const rows = historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.watts).toBe(180);
    expect(rows[0]?.source).toBe("manual");
  });

  test("re-saving the same manual value writes nothing", async () => {
    setFtp(169);
    const res = await apiRequest("PATCH", "/api/settings", { token, body: { ftp_watts: 169 } });
    expect(res.status).toBe(200);
    expect(historyRows().length).toBe(0);
  });

  test("clearing the threshold writes nothing", async () => {
    setFtp(169);
    const res = await apiRequest("PATCH", "/api/settings", { token, body: { ftp_watts: null } });
    expect(res.status).toBe(200);
    expect(historyRows().length).toBe(0);
  });

  test("a first-ever manual set (no prior value) records a row", async () => {
    const res = await apiRequest("PATCH", "/api/settings", { token, body: { ftp_watts: 200 } });
    expect(res.status).toBe(200);
    const rows = historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("manual");
  });
});

describe("FTP series compute", () => {
  test("collapses multiple same-day changes to the last one", () => {
    setFtp(190);
    db.query(
      "INSERT INTO ftp_history (recorded_on, watts, source) VALUES ('2026-08-01', 169, 'seed'), ('2026-08-01', 175, 'zwift'), ('2026-08-02', 190, 'manual')",
    ).run();
    const s = computeFtpSeries();
    expect(s.points.length).toBe(2);
    expect(s.points[0]).toEqual({ date: "2026-08-01", watts: 175, source: "zwift" });
    expect(s.points[1]).toEqual({ date: "2026-08-02", watts: 190, source: "manual" });
    expect(s.first).toBe(175);
    expect(s.delta).toBe(15); // current 190 - first 175
    expect(s.min).toBe(175);
    expect(s.max).toBe(190);
  });

  test("current mirrors the live setting: cleared threshold reads null with history intact", () => {
    recordFtpChange(169, "manual");
    const s = computeFtpSeries();
    expect(s.current).toBeNull(); // no ftp_watts setting row
    expect(s.points.length).toBe(1);
    expect(s.delta).toBeNull();
  });

  test("empty history and no setting is all-null and empty", () => {
    const s = computeFtpSeries();
    expect(s.current).toBeNull();
    expect(s.first).toBeNull();
    expect(s.count).toBe(0);
    expect(s.points).toEqual([]);
  });
});

describe("migration seed guard (the prod-shaped cases)", () => {
  test("no ftp setting: re-running migrations seeds nothing", () => {
    runMigrations(db);
    expect(historyRows().length).toBe(0);
  });

  test("live setting: seeds exactly one seed-source row, idempotent across re-runs, NY-date parity", () => {
    setFtp(169);
    runMigrations(db);
    runMigrations(db);
    const rows = historyRows();
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("seed");
    expect(rows[0]?.watts).toBe(169);
    // The migration derives the date via Intl en-CA; the write path uses
    // nyDateString. Both must land on the same NY calendar day.
    expect(rows[0]?.recorded_on).toBe(nyDateString(new Date()));
  });

  test("zero or non-numeric setting seeds nothing (never a poisoned 0 row)", () => {
    db.query("INSERT INTO settings (key, value) VALUES ('ftp_watts','0')").run();
    runMigrations(db);
    db.query("UPDATE settings SET value = 'garbage' WHERE key = 'ftp_watts'").run();
    runMigrations(db);
    expect(historyRows().length).toBe(0);
  });
});

describe("GET /api/metrics/ftp-history", () => {
  test("requires auth", async () => {
    const res = await apiRequest("GET", "/api/metrics/ftp-history");
    expect(res.status).toBe(401);
  });

  test("returns the series shape", async () => {
    setFtp(169);
    recordFtpChange(169, "manual");
    const res = await apiRequest("GET", "/api/metrics/ftp-history", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.unit).toBe("W");
    expect(body.current).toBe(169);
    expect(body.count).toBe(1);
    expect(Array.isArray(body.points)).toBe(true);
  });
});
