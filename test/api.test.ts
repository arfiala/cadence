// API route tests (ISC-36..47, ISC-86). Every route gets at least one test,
// exercised through the real fetchHandler with a bearer token.

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";

let token: string;
beforeEach(() => {
  resetDb();
  // A user must exist for a bearer token to resolve to a user_id.
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

describe("GET /api/activities (ISC-36)", () => {
  test("returns rows newest-first with from/to/sport/limit filters", async () => {
    insertActivity({ sport: "cycling", start_time: "2026-07-10T10:00:00Z", duration_s: 3600 });
    insertActivity({ sport: "swimming", start_time: "2026-07-14T10:00:00Z", duration_s: 1800 });
    insertActivity({ sport: "running", start_time: "2026-07-12T10:00:00Z", duration_s: 2400 });

    const all = await apiRequest("GET", "/api/activities", { token });
    const body = (await all.json()) as { activities: { start_time: string; sport: string }[] };
    expect(body.activities.length).toBe(3);
    // Newest first.
    expect(body.activities[0]!.start_time).toBe("2026-07-14T10:00:00Z");

    const filtered = await apiRequest("GET", "/api/activities?sport=cycling", { token });
    const fbody = (await filtered.json()) as { activities: unknown[] };
    expect(fbody.activities.length).toBe(1);

    const ranged = await apiRequest(
      "GET",
      "/api/activities?from=2026-07-11T00:00:00Z&to=2026-07-13T00:00:00Z",
      { token },
    );
    const rbody = (await ranged.json()) as { activities: unknown[] };
    expect(rbody.activities.length).toBe(1); // only the running one

    const limited = await apiRequest("GET", "/api/activities?limit=2", { token });
    const lbody = (await limited.json()) as { activities: unknown[] };
    expect(lbody.activities.length).toBe(2);
  });

  test("rejects an invalid sport filter with 400", async () => {
    const res = await apiRequest("GET", "/api/activities?sport=kayaking", { token });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/activities (ISC-37)", () => {
  test("creates a manual activity", async () => {
    const res = await apiRequest("POST", "/api/activities", {
      token,
      body: { sport: "swimming", start_time: "2026-07-14T06:00:00Z", duration_s: 1800, distance_m: 1500 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { activity: { source: string; sport: string } };
    expect(body.activity.source).toBe("manual");
    expect(body.activity.sport).toBe("swimming");
  });

  test("rejects a zero/negative duration and an invalid sport", async () => {
    const bad1 = await apiRequest("POST", "/api/activities", {
      token,
      body: { sport: "swimming", start_time: "2026-07-14T06:00:00Z", duration_s: 0 },
    });
    expect(bad1.status).toBe(400);

    const bad2 = await apiRequest("POST", "/api/activities", {
      token,
      body: { sport: "kayaking", start_time: "2026-07-14T06:00:00Z", duration_s: 1800 },
    });
    expect(bad2.status).toBe(400);
  });
});

describe("PATCH /api/activities/:id (ISC-38)", () => {
  test("edits a field and flags it as edited", async () => {
    const id = insertActivity({
      source: "garmin",
      garmin_id: "G9",
      sport: "virtual_cycling",
      start_time: "2026-07-14T10:00:00Z",
      duration_s: 3600,
    });
    const res = await apiRequest("PATCH", `/api/activities/${id}`, {
      token,
      body: { sport: "cycling", notes: "outdoor after all" },
    });
    expect(res.status).toBe(200);
    const row = db.query("SELECT sport, sport_edited, notes, notes_edited FROM activities WHERE id=?").get(id) as {
      sport: string;
      sport_edited: number;
      notes: string;
      notes_edited: number;
    };
    expect(row.sport).toBe("cycling");
    expect(row.sport_edited).toBe(1);
    expect(row.notes).toBe("outdoor after all");
    expect(row.notes_edited).toBe(1);
  });

  test("404 for a missing id, 400 for no editable fields", async () => {
    const missing = await apiRequest("PATCH", "/api/activities/9999", { token, body: { sport: "cycling" } });
    expect(missing.status).toBe(404);

    const id = insertActivity({ sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const empty = await apiRequest("PATCH", `/api/activities/${id}`, { token, body: {} });
    expect(empty.status).toBe(400);
  });
});

describe("DELETE /api/activities/:id (ISC-39)", () => {
  test("deletes a manual row freely", async () => {
    const id = insertActivity({ sport: "cycling", start_time: "2026-07-14T10:00:00Z", duration_s: 3600 });
    const res = await apiRequest("DELETE", `/api/activities/${id}`, { token });
    expect(res.status).toBe(200);
    const count = db.query("SELECT COUNT(*) as n FROM activities WHERE id=?").get(id) as { n: number };
    expect(count.n).toBe(0);
  });

  test("a Garmin row requires ?confirm=true", async () => {
    const id = insertActivity({
      source: "garmin",
      garmin_id: "G7",
      sport: "cycling",
      start_time: "2026-07-14T10:00:00Z",
      duration_s: 3600,
    });
    const noConfirm = await apiRequest("DELETE", `/api/activities/${id}`, { token });
    expect(noConfirm.status).toBe(400);
    // Still there.
    expect((db.query("SELECT COUNT(*) as n FROM activities WHERE id=?").get(id) as { n: number }).n).toBe(1);

    const confirmed = await apiRequest("DELETE", `/api/activities/${id}?confirm=true`, { token });
    expect(confirmed.status).toBe(200);
    expect((db.query("SELECT COUNT(*) as n FROM activities WHERE id=?").get(id) as { n: number }).n).toBe(0);
  });
});

describe("GET /api/week (ISC-40)", () => {
  test("summarizes a fixture week with G1 sessions, hours, and gap", async () => {
    // 2 qualifying sessions (cycling + swimming), 1 non-qualifying (running).
    insertActivity({ sport: "cycling", start_time: "2026-07-13T10:00:00Z", duration_s: 3600 }); // Mon, 1h
    insertActivity({ sport: "swimming", start_time: "2026-07-15T10:00:00Z", duration_s: 1800 }); // Wed, 0.5h
    insertActivity({ sport: "running", start_time: "2026-07-16T10:00:00Z", duration_s: 3600 }); // Thu, 1h (not G1)

    const res = await apiRequest("GET", "/api/week?date=2026-07-14T12:00:00Z", { token });
    const body = (await res.json()) as {
      sessions: number;
      hours_g1: number;
      hours_total: number;
      target_sessions: number;
      gap_sessions: number;
      gap_message: string;
      days: { sessions: number }[];
    };
    expect(body.sessions).toBe(2);
    expect(body.hours_g1).toBe(1.5);
    expect(body.hours_total).toBe(2.5);
    expect(body.target_sessions).toBe(5);
    expect(body.gap_sessions).toBe(3);
    expect(body.days.length).toBe(7);
    expect(body.gap_message).toContain("need 3 more sessions");
  });
});

describe("GET /api/trends (ISC-41)", () => {
  test("returns N weekly aggregates oldest-first", async () => {
    const res = await apiRequest("GET", "/api/trends?weeks=4", { token });
    const body = (await res.json()) as { weeks: { week_start: string }[] };
    expect(body.weeks.length).toBe(4);
    // Oldest first: week_start strings ascending.
    const starts = body.weeks.map((w) => w.week_start);
    expect([...starts].sort()).toEqual(starts);
  });
});

describe("GET/PATCH /api/settings (ISC-42)", () => {
  test("reads defaults and updates targets", async () => {
    const get1 = await apiRequest("GET", "/api/settings", { token });
    expect(await get1.json()).toEqual({ target_sessions: 5, target_hours: 8, ftp_watts: null, lthr_bpm: null });

    const patch = await apiRequest("PATCH", "/api/settings", { token, body: { target_sessions: 6, target_hours: 10 } });
    expect(patch.status).toBe(200);
    expect(await patch.json()).toEqual({ target_sessions: 6, target_hours: 10, ftp_watts: null, lthr_bpm: null });

    const bad = await apiRequest("PATCH", "/api/settings", { token, body: { target_sessions: -1 } });
    expect(bad.status).toBe(400);
  });
});

describe("GET /api/sync/status (ISC-43)", () => {
  test("reports recent sync runs", async () => {
    db.query(
      "INSERT INTO sync_runs (started_at, status, activities_seen, activities_new) VALUES ('2026-07-14T10:00:00Z','success',3,1)",
    ).run();
    const res = await apiRequest("GET", "/api/sync/status", { token });
    const body = (await res.json()) as { runs: { status: string }[] };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0]!.status).toBe("success");
  });
});

describe("errors are JSON (ISC-45, ISC-46)", () => {
  test("unknown API route is 404 JSON", async () => {
    const res = await apiRequest("GET", "/api/nonexistent", { token });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  test("no response body echoes a token or credential (ISC-46)", async () => {
    const res = await apiRequest("GET", "/api/activities", { token });
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(text.toLowerCase()).not.toContain("password_hash");
    expect(text.toLowerCase()).not.toContain("token_hash");
  });
});
