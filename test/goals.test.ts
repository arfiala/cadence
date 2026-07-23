// Weight goal + macro targets (ISC-439/443/444). Validation, clearing, and
// payload shapes for the three goal surfaces.
import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedToken, apiRequest } from "./helpers";

let token: string;
beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

describe("weight goal (ISC-439)", () => {
  test("set, read back, clear", async () => {
    let res = await apiRequest("PATCH", "/api/settings", { token, body: { weight_goal_kg: 60 } });
    expect(res.status).toBe(200);
    let st = (await (await apiRequest("GET", "/api/settings", { token })).json()) as Record<string, unknown>;
    expect(st.weight_goal_kg).toBe(60);
    res = await apiRequest("PATCH", "/api/settings", { token, body: { weight_goal_kg: null } });
    expect(res.status).toBe(200);
    st = (await (await apiRequest("GET", "/api/settings", { token })).json()) as Record<string, unknown>;
    expect(st.weight_goal_kg).toBeNull();
  });
  test("sanity range enforced", async () => {
    for (const bad of [10, 250, "60"]) {
      const res = await apiRequest("PATCH", "/api/settings", { token, body: { weight_goal_kg: bad } });
      expect(res.status).toBe(400);
    }
  });
  test("weight metrics payload carries the goal", async () => {
    await apiRequest("PATCH", "/api/settings", { token, body: { weight_goal_kg: 60 } });
    const w = (await (await apiRequest("GET", "/api/metrics/weight", { token })).json()) as Record<string, unknown>;
    expect(w.weight_goal_kg).toBe(60);
  });
});

describe("macro targets (ISC-443/444)", () => {
  test("carbs/fat set and clear, nutrition day payload carries all four", async () => {
    let res = await apiRequest("PATCH", "/api/settings", {
      token,
      body: { nutrition_target_protein_g: 140, nutrition_target_carbs_g: 180, nutrition_target_fat_g: 60 },
    });
    expect(res.status).toBe(200);
    const day = (await (await apiRequest("GET", "/api/nutrition", { token })).json()) as Record<string, unknown>;
    expect(day.target_protein_g).toBe(140);
    expect(day.target_carbs_g).toBe(180);
    expect(day.target_fat_g).toBe(60);
    res = await apiRequest("PATCH", "/api/settings", { token, body: { nutrition_target_carbs_g: null } });
    expect(res.status).toBe(200);
    const day2 = (await (await apiRequest("GET", "/api/nutrition", { token })).json()) as Record<string, unknown>;
    expect(day2.target_carbs_g).toBeNull();
  });
  test("invalid macro targets rejected", async () => {
    for (const body of [{ nutrition_target_carbs_g: -5 }, { nutrition_target_fat_g: "x" }]) {
      const res = await apiRequest("PATCH", "/api/settings", { token, body });
      expect(res.status).toBe(400);
    }
  });
});
