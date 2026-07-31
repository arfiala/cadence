// FTP auto-sync tests: change detection, sanity guards, future-only target
// regeneration from the shared templates, feed logging, and the ZP sync seam.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedToken, apiRequest } from "./helpers";
import { syncFtpFromZwift } from "../src/services/ftpSync";
import { runZpSyncOnce } from "../src/zwiftpower/sync";
import type { ZwiftPowerClient } from "../src/zwiftpower/types";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function setFtp(v: number): void {
  db.query("INSERT INTO settings (key, value) VALUES ('ftp_watts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(v));
}
function getFtp(): string | null {
  const r = db.query("SELECT value FROM settings WHERE key = 'ftp_watts'").get() as { value: string } | null;
  return r?.value ?? null;
}
function fakeClient(ftp: number | null): ZwiftPowerClient {
  return { async listRiderResults() { return []; }, async getZwiftFtp() { return ftp; } };
}
function insertBike(over: Partial<Record<string, unknown>> = {}): number {
  const row = {
    plan_day: "2099-01-05", sport: "bike", title: "Zwift race",
    detail: "old detail 95 to 127 W", duration_min: 75, week_no: 1,
    phase: "Base 1", status: "planned", sort: 1, kind: "race",
    target: "Race effort after a 95 to 127 W warmup", ...over,
  };
  db.query(
    `INSERT INTO planned_workouts (plan_day, sport, title, detail, duration_min, target, week_no, phase, status, sort, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.plan_day as string, row.sport as string, row.title as string, row.detail as string,
    row.duration_min as number, row.target as string, row.week_no as number, row.phase as string,
    row.status as string, row.sort as number, row.kind as string);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

describe("FTP auto-sync", () => {
  test("a client without the capability changes nothing", async () => {
    setFtp(169);
    const changed = await syncFtpFromZwift({ async listRiderResults() { return []; } });
    expect(changed).toBe(false);
    expect(getFtp()).toBe("169");
  });

  test("null profile reading changes nothing", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(null))).toBe(false);
  });

  test("unchanged FTP produces zero writes and zero feed rows", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(169))).toBe(false);
    const n = (db.query("SELECT COUNT(*) n FROM plan_adaptations").get() as { n: number }).n;
    expect(n).toBe(0);
  });

  test("a changed FTP updates the setting, future targets, and the feed", async () => {
    setFtp(169);
    const future = insertBike();
    const ride = insertBike({ kind: "long_ride", title: "Long ride 1:45", target: "95 to 127 W (Z2)", detail: "Steady Z2." });
    const past = insertBike({ plan_day: "2020-01-01" });
    const done = insertBike({ status: "done", plan_day: "2099-01-06" });
    expect(await syncFtpFromZwift(fakeClient(175))).toBe(true);
    expect(getFtp()).toBe("175");
    const f = db.query("SELECT target, detail FROM planned_workouts WHERE id = ?").get(future) as { target: string; detail: string };
    expect(f.target).toBe("Race effort after a 98 to 131 W warmup");
    expect(f.detail).toContain("98 to 131 W");
    expect(f.detail).toContain("186 to 210 W");
    const r = db.query("SELECT target FROM planned_workouts WHERE id = ?").get(ride) as { target: string };
    expect(r.target).toBe("98 to 131 W (Z2)");
    const p = db.query("SELECT target FROM planned_workouts WHERE id = ?").get(past) as { target: string };
    expect(p.target).toContain("95 to 127");
    const d = db.query("SELECT target FROM planned_workouts WHERE id = ?").get(done) as { target: string };
    expect(d.target).toContain("95 to 127");
    const feed = db.query("SELECT description FROM plan_adaptations WHERE kind = 'ftp_update'").get() as { description: string };
    expect(feed.description).toBe("FTP 169 to 175 W from Zwift");
  });

  test("a lower FTP recalibrates too", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(160))).toBe(true);
    expect(getFtp()).toBe("160");
  });

  test("out-of-bounds readings are ignored and logged once", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(30))).toBe(false);
    expect(await syncFtpFromZwift(fakeClient(30))).toBe(false);
    expect(getFtp()).toBe("169");
    const n = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'ftp_anomaly'").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  test("a jump over 30 percent is treated as a glitch", async () => {
    setFtp(169);
    expect(await syncFtpFromZwift(fakeClient(260))).toBe(false);
    expect(getFtp()).toBe("169");
    const n = (db.query("SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'ftp_anomaly'").get() as { n: number }).n;
    expect(n).toBe(1);
  });

  test("no stored FTP accepts any sane value", async () => {
    expect(await syncFtpFromZwift(fakeClient(200))).toBe(true);
    expect(getFtp()).toBe("200");
    const feed = db.query("SELECT description FROM plan_adaptations WHERE kind = 'ftp_update'").get() as { description: string };
    expect(feed.description).toBe("FTP unset to 200 W from Zwift");
  });

  test("the plan summary zone table reflects the new FTP", async () => {
    setFtp(175);
    const res = await apiRequest("GET", "/api/plan/summary", { token });
    const body = (await res.json()) as { zonesPower: { zone: string; range: string }[] };
    expect(body.zonesPower.find((z) => z.zone.startsWith("Z2"))?.range).toBe("98 to 131 W");
  });

  test("rides along with the ZP sync without breaking it", async () => {
    setFtp(169);
    const outcome = await runZpSyncOnce(fakeClient(172));
    expect(outcome.status).toBe("success");
    expect(getFtp()).toBe("172");
  });
});
