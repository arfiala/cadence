// Wave-1 cross-cutting tests (ISC-346, ISC-347) and the race-target settings
// (ISC-332, ISC-333). Every new route is swept unauthenticated for a 401, the
// new tables/column are proven double-boot idempotent, and the race name/date
// round-trip + validation are checked.

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { db, runMigrations } from "../src/db";
import { fetchHandler } from "../src/server";
import { resetDb, seedToken, apiRequest } from "./helpers";

const stubServer = { requestIP: () => ({ address: "127.0.0.1" }) };

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

describe("all new routes are auth-gated (ISC-346)", () => {
  const routes: [string, string][] = [
    ["GET", "/api/activities/1/detail"],
    ["GET", "/api/duplicates"],
    ["POST", "/api/duplicates/dismiss"],
    ["POST", "/api/duplicates/undismiss"],
    ["POST", "/api/duplicates/merge"],
    ["GET", "/api/metrics/g1-risk"],
    ["GET", "/api/metrics/pacing"],
    ["GET", "/api/metrics/yoy"],
    ["GET", "/api/metrics/power-curve"],
  ];

  test("each returns 401 without a session or bearer token", async () => {
    for (const [method, path] of routes) {
      const res = await fetchHandler(new Request(`http://localhost${path}`, { method }), stubServer);
      expect(res.status).toBe(401);
    }
  });

  test("each is reachable (not 401) with a valid token", async () => {
    for (const [method, path] of routes) {
      // Bodyless POSTs to duplicate routes will 400 on validation, never 401.
      const res = await apiRequest(method, path, { token });
      expect(res.status).not.toBe(401);
    }
  });
});

describe("migrations are guarded + double-boot idempotent (ISC-347)", () => {
  test("running migrations twice on a fresh DB adds the new tables and rpe column without error", () => {
    const mem = new Database(":memory:");
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();

    const tables = (mem.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    for (const t of ["activity_details", "duplicate_dismissals", "merged_garmin_ids", "power_curve_efforts"]) {
      expect(tables).toContain(t);
    }

    const cols = (mem.query("PRAGMA table_info(activities)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("rpe");

    // The guarded ALTER did not duplicate the column on the second run.
    expect(cols.filter((c) => c === "rpe").length).toBe(1);
  });
});

describe("race target settings (ISC-332, ISC-333)", () => {
  test("race_name and race_date round-trip, validate, and clear to null", async () => {
    const patch = await apiRequest("PATCH", "/api/settings", {
      token,
      body: { race_name: "Ironman NJ", race_date: "2026-09-20" },
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { race_name: string; race_date: string };
    expect(body.race_name).toBe("Ironman NJ");
    expect(body.race_date).toBe("2026-09-20");

    const get = await apiRequest("GET", "/api/settings", { token });
    const gbody = (await get.json()) as { race_name: string; race_date: string };
    expect(gbody.race_name).toBe("Ironman NJ");
    expect(gbody.race_date).toBe("2026-09-20");

    // Invalid date rejected.
    const bad = await apiRequest("PATCH", "/api/settings", { token, body: { race_date: "2026-13-40" } });
    expect(bad.status).toBe(400);
    const bad2 = await apiRequest("PATCH", "/api/settings", { token, body: { race_date: "not-a-date" } });
    expect(bad2.status).toBe(400);

    // Clear both to null.
    const cleared = await apiRequest("PATCH", "/api/settings", { token, body: { race_name: null, race_date: null } });
    const cbody = (await cleared.json()) as { race_name: string | null; race_date: string | null };
    expect(cbody.race_name).toBeNull();
    expect(cbody.race_date).toBeNull();
  });
});
