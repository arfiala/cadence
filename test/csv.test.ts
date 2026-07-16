// CSV import tests (ISC-99). The Garmin-outage survival path: parse
// validation, quoted-field handling, and per-row skip reporting.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedToken } from "./helpers";
import { fetchHandler } from "../src/server";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

const stubServer = { requestIP: () => ({ address: "127.0.0.1" }) };

async function postCsv(csv: string): Promise<Response> {
  const req = new Request("http://localhost/api/import/csv", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/csv" },
    body: csv,
  });
  return fetchHandler(req, stubServer);
}

describe("CSV import (ISC-99)", () => {
  test("imports valid rows and inserts them as manual activities", async () => {
    const csv = [
      "date,sport,duration_minutes,distance_km,notes",
      "2026-07-13T10:00:00Z,cycling,60,30,Morning ride",
      "2026-07-14T06:00:00Z,swimming,30,1.5,Pool",
    ].join("\n");
    const res = await postCsv(csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { imported: number; skipped_count: number };
    expect(body.imported).toBe(2);
    expect(body.skipped_count).toBe(0);

    const rows = db.query("SELECT sport, source, duration_s, distance_m FROM activities ORDER BY start_time").all() as {
      sport: string;
      source: string;
      duration_s: number;
      distance_m: number | null;
    }[];
    expect(rows.length).toBe(2);
    expect(rows[0]!.source).toBe("manual");
    expect(rows[0]!.duration_s).toBe(3600); // 60 min
    expect(rows[1]!.distance_m).toBe(1500); // 1.5 km
  });

  test("skips invalid rows with reasons, keeps the good ones", async () => {
    const csv = [
      "date,sport,duration_minutes",
      "2026-07-13T10:00:00Z,cycling,60",
      "not-a-date,cycling,60",
      "2026-07-14T10:00:00Z,kayaking,60",
      "2026-07-15T10:00:00Z,cycling,0",
    ].join("\n");
    const res = await postCsv(csv);
    const body = (await res.json()) as { imported: number; skipped_count: number; skipped: { row: number; reason: string }[] };
    expect(body.imported).toBe(1);
    expect(body.skipped_count).toBe(3);
    expect(body.skipped.some((s) => s.reason.includes("date"))).toBe(true);
    expect(body.skipped.some((s) => s.reason.includes("sport"))).toBe(true);
    expect(body.skipped.some((s) => s.reason.includes("duration"))).toBe(true);
  });

  test("handles a quoted notes field containing a comma", async () => {
    const csv = [
      "date,sport,duration_minutes,distance_km,notes",
      '2026-07-13T10:00:00Z,cycling,60,30,"Hard ride, big hills"',
    ].join("\n");
    const res = await postCsv(csv);
    const body = (await res.json()) as { imported: number };
    expect(body.imported).toBe(1);
    const row = db.query("SELECT notes FROM activities LIMIT 1").get() as { notes: string };
    expect(row.notes).toBe("Hard ride, big hills");
  });

  test("rejects a CSV missing a required column with 400", async () => {
    const csv = "date,sport\n2026-07-13T10:00:00Z,cycling";
    const res = await postCsv(csv);
    expect(res.status).toBe(400);
  });

  test("rejects an empty body with 400", async () => {
    const res = await postCsv("");
    expect(res.status).toBe(400);
  });
});
