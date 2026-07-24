// Daily calorie tracking: quick-add + history (ISC-457..472).
import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedToken, apiRequest } from "./helpers";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

describe("quick-add calories (ISC-457..459)", () => {
  test("bare kcal creates an entry that flows into the day total", async () => {
    const res = await apiRequest("POST", "/api/nutrition", { token, body: { quick: true, kcal: 600 } });
    expect(res.status).toBe(201);
    const day = (await (await apiRequest("GET", "/api/nutrition", { token })).json()) as {
      totals: { kcal: number; protein_g: number };
      entries: unknown[];
    };
    expect(day.totals.kcal).toBe(600);
    expect(day.entries.length).toBe(1);
  });
  test("optional protein is stored, carbs/fat are zero not guessed", async () => {
    await apiRequest("POST", "/api/nutrition", { token, body: { quick: true, kcal: 500, protein_g: 40 } });
    const day = (await (await apiRequest("GET", "/api/nutrition", { token })).json()) as {
      totals: { protein_g: number; carbs_g: number; fat_g: number };
    };
    expect(day.totals.protein_g).toBe(40);
    expect(day.totals.carbs_g).toBe(0);
    expect(day.totals.fat_g).toBe(0);
  });
  test("invalid kcal rejected", async () => {
    for (const bad of [0, -100, 12.5, "500"]) {
      const res = await apiRequest("POST", "/api/nutrition", { token, body: { quick: true, kcal: bad } });
      expect(res.status).toBe(400);
    }
  });
  test("quick entry is editable and deletable like any entry", async () => {
    const created = (await (await apiRequest("POST", "/api/nutrition", { token, body: { quick: true, kcal: 300 } })).json()) as { entry: { id: number } };
    const del = await apiRequest("DELETE", `/api/nutrition/${created.entry.id}`, { token });
    expect(del.status).toBe(200);
    const day = (await (await apiRequest("GET", "/api/nutrition", { token })).json()) as { totals: { kcal: number } };
    expect(day.totals.kcal).toBe(0);
  });
  test("quick-add to a past day lands on that day (edit at any time)", async () => {
    await apiRequest("POST", "/api/nutrition", { token, body: { quick: true, kcal: 700, logged_date: "2026-07-01" } });
    const day = (await (await apiRequest("GET", "/api/nutrition?date=2026-07-01", { token })).json()) as { totals: { kcal: number } };
    expect(day.totals.kcal).toBe(700);
  });
});

describe("nutrition history (ISC-462/463)", () => {
  test("returns N continuous days including zero days, plus targets", async () => {
    await apiRequest("POST", "/api/nutrition", { token, body: { quick: true, kcal: 1800, protein_g: 120 } });
    const res = await apiRequest("GET", "/api/nutrition/history?days=7", { token });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      days: number;
      history: { date: string; kcal: number; protein_g: number }[];
      target_kcal: number;
      target_protein_g: number;
    };
    expect(data.days).toBe(7);
    expect(data.history.length).toBe(7);
    expect(data.target_kcal).toBe(2200);
    // last day is today and carries the logged total
    expect(data.history[6]!.kcal).toBe(1800);
    // an earlier day is a real zero, not missing
    expect(data.history[0]!.kcal).toBe(0);
  });
  test("days param is clamped to 1..365", async () => {
    const hi = (await (await apiRequest("GET", "/api/nutrition/history?days=9999", { token })).json()) as { days: number };
    expect(hi.days).toBe(365);
    const lo = (await (await apiRequest("GET", "/api/nutrition/history?days=0", { token })).json()) as { days: number };
    expect(lo.days).toBe(1);
  });
  test("route is auth-gated", async () => {
    const res = await apiRequest("GET", "/api/nutrition/history", {});
    expect(res.status).toBe(401);
  });
});
