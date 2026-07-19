// Nutrition route + schema tests (ISC-189..205, ISC-214, ISC-216, ISC-217).
// Exercised through the real fetchHandler with a bearer token. No ANTHROPIC key
// is set in the test env, so the estimate paths exercise the "unavailable"
// fallback (200 with unavailable:true for the estimate endpoint, 422 for the
// save-with-estimate path) without any network call.

import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { db, runMigrations } from "../src/db";
import { resetDb, seedToken, apiRequest } from "./helpers";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

describe("nutrition schema (ISC-189, ISC-190, ISC-193)", () => {
  function columnNames(database: Database, table: string): string[] {
    const rows = database.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((r) => r.name);
  }

  test("nutrition_entries has the required columns", () => {
    const cols = columnNames(db, "nutrition_entries");
    for (const expected of [
      "id",
      "logged_date",
      "logged_at",
      "description",
      "source",
      "kcal",
      "protein_g",
      "carbs_g",
      "fat_g",
      "notes",
      "created_at",
      "updated_at",
    ]) {
      expect(cols).toContain(expected);
    }
  });

  test("nutrition_items has the required columns", () => {
    const cols = columnNames(db, "nutrition_items");
    for (const expected of ["id", "entry_id", "food", "quantity", "kcal", "protein_g", "carbs_g", "fat_g"]) {
      expect(cols).toContain(expected);
    }
  });

  test("indexes exist on logged_date and entry_id", () => {
    const entryIdx = (db.query("PRAGMA index_list(nutrition_entries)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    const itemIdx = (db.query("PRAGMA index_list(nutrition_items)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(entryIdx).toContain("idx_nutrition_entries_logged_date");
    expect(itemIdx).toContain("idx_nutrition_items_entry");
  });

  test("source CHECK constraint rejects an out-of-vocab value", () => {
    expect(() =>
      db
        .query(
          "INSERT INTO nutrition_entries (logged_date, logged_at, source) VALUES ('2026-07-15','2026-07-15T12:00:00Z','guessed')",
        )
        .run(),
    ).toThrow();
  });

  test("runMigrations twice on a throwaway DB does not throw or duplicate (ISC-192)", () => {
    const mem = new Database(":memory:");
    runMigrations(mem);
    expect(() => runMigrations(mem)).not.toThrow();
    const tables = (mem.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toContain("nutrition_entries");
    expect(tables).toContain("nutrition_items");
  });
});

describe("auth gate (ISC-204)", () => {
  test("every nutrition route is 401 without a token", async () => {
    const calls = [
      apiRequest("POST", "/api/nutrition/estimate", { body: { description: "x" } }),
      apiRequest("GET", "/api/nutrition"),
      apiRequest("POST", "/api/nutrition", { body: { items: [], source: "manual" } }),
      apiRequest("PATCH", "/api/nutrition/1", { body: { notes: "x" } }),
      apiRequest("DELETE", "/api/nutrition/1"),
    ];
    const results = await Promise.all(calls);
    for (const res of results) expect(res.status).toBe(401);
  });
});

describe("POST /api/nutrition/estimate (ISC-199)", () => {
  test("with no API key returns 200 unavailable and does NOT persist", async () => {
    const res = await apiRequest("POST", "/api/nutrition/estimate", {
      token,
      body: { description: "two eggs and toast" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unavailable?: boolean; reason?: string; items: unknown[] };
    expect(body.unavailable).toBe(true);
    expect(body.reason).toBe("no_key");
    // DB is untouched.
    const count = db.query("SELECT COUNT(*) as n FROM nutrition_entries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("rejects an empty description with 400", async () => {
    const res = await apiRequest("POST", "/api/nutrition/estimate", { token, body: { description: "  " } });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/nutrition save (ISC-200)", () => {
  test("saves a manual entry with items and computed totals", async () => {
    const res = await apiRequest("POST", "/api/nutrition", {
      token,
      body: {
        logged_date: "2026-07-15",
        description: "lunch",
        source: "manual",
        items: [
          { food: "rice", quantity: "1 cup", kcal: 200, protein_g: 4, carbs_g: 44, fat_g: 0.4 },
          { food: "chicken breast", kcal: 180, protein_g: 35, carbs_g: 0, fat_g: 4 },
        ],
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      entry: { source: string; kcal: number; protein_g: number; items: unknown[] };
    };
    expect(body.entry.source).toBe("manual");
    expect(body.entry.kcal).toBe(380);
    expect(body.entry.protein_g).toBe(39);
    expect(body.entry.items.length).toBe(2);
  });

  test("estimate:true with no key returns 422 so the client falls back to manual (ISC-196)", async () => {
    const res = await apiRequest("POST", "/api/nutrition", {
      token,
      body: { description: "two eggs", estimate: true },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { reason: string };
    expect(body.reason).toBe("no_key");
    const count = db.query("SELECT COUNT(*) as n FROM nutrition_entries").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("rejects a bad date, a negative kcal, and an oversized description with 400", async () => {
    const badDate = await apiRequest("POST", "/api/nutrition", {
      token,
      body: { logged_date: "2026-13-40", items: [{ food: "x", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    });
    expect(badDate.status).toBe(400);

    const badKcal = await apiRequest("POST", "/api/nutrition", {
      token,
      body: { items: [{ food: "x", kcal: -5, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    });
    expect(badKcal.status).toBe(400);

    const bigDesc = await apiRequest("POST", "/api/nutrition", {
      token,
      body: { description: "a".repeat(2001), items: [{ food: "x", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    });
    expect(bigDesc.status).toBe(400);
  });
});

describe("GET /api/nutrition day rollup (ISC-201)", () => {
  test("sums the day's entries and reports the target", async () => {
    for (const items of [
      [{ food: "oats", kcal: 300, protein_g: 10, carbs_g: 54, fat_g: 6 }],
      [{ food: "banana", kcal: 100, protein_g: 1, carbs_g: 27, fat_g: 0.3 }],
    ]) {
      await apiRequest("POST", "/api/nutrition", {
        token,
        body: { logged_date: "2026-07-15", items, source: "manual" },
      });
    }
    const res = await apiRequest("GET", "/api/nutrition?date=2026-07-15", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: unknown[];
      totals: { kcal: number; protein_g: number; carbs_g: number; fat_g: number };
      target_kcal: number;
      target_protein_g: number;
    };
    expect(body.entries.length).toBe(2);
    expect(body.totals.kcal).toBe(400);
    expect(body.totals.protein_g).toBe(11);
    expect(body.totals.carbs_g).toBe(81);
    expect(body.totals.fat_g).toBe(6.3);
    expect(body.target_kcal).toBe(2200);
    expect(body.target_protein_g).toBe(150);
  });

  test("rejects an invalid date with 400", async () => {
    const res = await apiRequest("GET", "/api/nutrition?date=nonsense", { token });
    expect(res.status).toBe(400);
  });

  test("a different day does not see the entries", async () => {
    await apiRequest("POST", "/api/nutrition", {
      token,
      body: { logged_date: "2026-07-15", items: [{ food: "x", kcal: 100, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    });
    const res = await apiRequest("GET", "/api/nutrition?date=2026-07-16", { token });
    const body = (await res.json()) as { entries: unknown[]; totals: { kcal: number } };
    expect(body.entries.length).toBe(0);
    expect(body.totals.kcal).toBe(0);
  });
});

describe("PATCH /api/nutrition/:id (ISC-202, ISC-216)", () => {
  test("replacing items recomputes totals and sets source=edited", async () => {
    const created = await apiRequest("POST", "/api/nutrition", {
      token,
      body: { logged_date: "2026-07-15", items: [{ food: "x", kcal: 100, protein_g: 5, carbs_g: 10, fat_g: 2 }] },
    });
    const id = ((await created.json()) as { entry: { id: number } }).entry.id;

    const patched = await apiRequest("PATCH", `/api/nutrition/${id}`, {
      token,
      body: {
        description: "corrected",
        items: [{ food: "y", kcal: 250, protein_g: 20, carbs_g: 5, fat_g: 9 }],
      },
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as {
      entry: { source: string; kcal: number; description: string; items: { food: string }[] };
    };
    expect(body.entry.source).toBe("edited");
    expect(body.entry.kcal).toBe(250);
    expect(body.entry.description).toBe("corrected");
    expect(body.entry.items.length).toBe(1);
    expect(body.entry.items[0]!.food).toBe("y");
  });

  test("404 for a missing id, 400 for no editable fields", async () => {
    const missing = await apiRequest("PATCH", "/api/nutrition/9999", { token, body: { notes: "x" } });
    expect(missing.status).toBe(404);

    const created = await apiRequest("POST", "/api/nutrition", {
      token,
      body: { items: [{ food: "x", kcal: 1, protein_g: 0, carbs_g: 0, fat_g: 0 }] },
    });
    const id = ((await created.json()) as { entry: { id: number } }).entry.id;
    const empty = await apiRequest("PATCH", `/api/nutrition/${id}`, { token, body: {} });
    expect(empty.status).toBe(400);
  });
});

describe("DELETE /api/nutrition/:id (ISC-203)", () => {
  test("deletes the entry and cascades its items", async () => {
    const created = await apiRequest("POST", "/api/nutrition", {
      token,
      body: {
        items: [
          { food: "a", kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1 },
          { food: "b", kcal: 100, protein_g: 1, carbs_g: 1, fat_g: 1 },
        ],
      },
    });
    const id = ((await created.json()) as { entry: { id: number } }).entry.id;

    const res = await apiRequest("DELETE", `/api/nutrition/${id}`, { token });
    expect(res.status).toBe(200);

    const entryCount = db.query("SELECT COUNT(*) as n FROM nutrition_entries WHERE id=?").get(id) as { n: number };
    const itemCount = db.query("SELECT COUNT(*) as n FROM nutrition_items WHERE entry_id=?").get(id) as { n: number };
    expect(entryCount.n).toBe(0);
    expect(itemCount.n).toBe(0);
  });

  test("404 for a missing id", async () => {
    const res = await apiRequest("DELETE", "/api/nutrition/9999", { token });
    expect(res.status).toBe(404);
  });
});

describe("nutrition never touches the activities/G1 spine (ISC-214)", () => {
  test("saving nutrition does not create an activity row", async () => {
    await apiRequest("POST", "/api/nutrition", {
      token,
      body: { items: [{ food: "steak", kcal: 500, protein_g: 40, carbs_g: 0, fat_g: 30 }] },
    });
    const activityCount = db.query("SELECT COUNT(*) as n FROM activities").get() as { n: number };
    expect(activityCount.n).toBe(0);
  });
});

describe("nutrition targets via PATCH /api/settings (ISC-191)", () => {
  test("updates and reads back the calorie and protein targets", async () => {
    const patch = await apiRequest("PATCH", "/api/settings", {
      token,
      body: { nutrition_target_kcal: 2500, nutrition_target_protein_g: 175 },
    });
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { nutrition_target_kcal: number; nutrition_target_protein_g: number };
    expect(body.nutrition_target_kcal).toBe(2500);
    expect(body.nutrition_target_protein_g).toBe(175);

    // The day rollup reflects the new target.
    const day = await apiRequest("GET", "/api/nutrition", { token });
    const dayBody = (await day.json()) as { target_kcal: number; target_protein_g: number };
    expect(dayBody.target_kcal).toBe(2500);
    expect(dayBody.target_protein_g).toBe(175);
  });

  test("rejects a non-positive calorie target with 400", async () => {
    const res = await apiRequest("PATCH", "/api/settings", { token, body: { nutrition_target_kcal: 0 } });
    expect(res.status).toBe(400);
  });
});
