// Garmin Golf scorecard sync tests (ISC-422..430, 433). Shape fixture mirrors
// the LIVE probe of 2026-07-23 (22 real scorecards; keys: id, courseName,
// startTime, strokes, scoreWithoutHandicap, holesCompleted, roundType, ...).

import { test, expect, describe, beforeEach } from "bun:test";
import { db } from "../src/db";
import { runSyncOnce, syncGolf, toScorecard } from "../src/garmin/sync";
import type { GarminClient } from "../src/garmin/types";
import { listGolfRounds } from "../src/routes/golf";
import { resetDb, seedToken, apiRequest, insertActivity } from "./helpers";

const CARD = {
  id: 555001,
  customerId: "x",
  courseName: "Neshanic Valley",
  startTime: "2026-07-19T13:05:00.0",
  strokes: 94,
  scoreWithoutHandicap: 94,
  holesCompleted: 18,
  roundType: "STROKE_PLAY",
};

function golfClient(payload: unknown): GarminClient {
  return {
    listRecentActivities: async () => [],
    listGolfScorecards: async () => payload,
  };
}

beforeEach(() => resetDb());

describe("toScorecard defensive parse (ISC-425)", () => {
  test("full live-shape card normalizes", () => {
    const c = toScorecard(CARD as Record<string, unknown>);
    expect(c).not.toBeNull();
    expect(c!.scorecardId).toBe("555001");
    expect(c!.courseName).toBe("Neshanic Valley");
    expect(c!.strokes).toBe(94);
    expect(c!.holesPlayed).toBe(18);
  });
  test("missing id rejects the card, missing fields degrade to null", () => {
    expect(toScorecard({ courseName: "X" })).toBeNull();
    const c = toScorecard({ id: 1 });
    expect(c!.courseName).toBeNull();
    expect(c!.strokes).toBeNull();
  });
  test("strokes falls back to scoreWithoutHandicap", () => {
    const c = toScorecard({ id: 2, scoreWithoutHandicap: 88 });
    expect(c!.strokes).toBe(88);
  });
});

describe("syncGolf (ISC-424/426/427)", () => {
  test("stores cards from the summary envelope and is idempotent", async () => {
    const client = golfClient({ scorecardSummaries: [CARD] });
    const first = await syncGolf(client);
    expect(first).toEqual({ seen: 1, new: 1 });
    const again = await syncGolf(client);
    expect(again).toEqual({ seen: 1, new: 0 });
    expect((db.query("SELECT COUNT(*) c FROM golf_scorecards").get() as { c: number }).c).toBe(1);
    const row = db.query("SELECT round_date, strokes FROM golf_scorecards").get() as {
      round_date: string;
      strokes: number;
    };
    expect(row.strokes).toBe(94);
    expect(row.round_date).toBe("2026-07-19");
  });
  test("a throwing golf fetch never fails the sync run (ISC-424)", async () => {
    const client: GarminClient = {
      listRecentActivities: async () => [],
      listGolfScorecards: async () => {
        throw new Error("golf backend down");
      },
    };
    const outcome = await runSyncOnce(client);
    expect(outcome.status).toBe("success");
  });
  test("a client without the method is skipped cleanly", async () => {
    const outcome = await runSyncOnce({ listRecentActivities: async () => [] });
    expect(outcome.status).toBe("success");
  });
  test("changed strokes update on re-sync", async () => {
    await syncGolf(golfClient({ scorecardSummaries: [CARD] }));
    await syncGolf(golfClient({ scorecardSummaries: [{ ...CARD, strokes: 91, scoreWithoutHandicap: 91 }] }));
    const row = db.query("SELECT strokes FROM golf_scorecards").get() as { strokes: number };
    expect(row.strokes).toBe(91);
  });
});

describe("merged rounds (ISC-428/429/430/433)", () => {
  test("scorecard joins the same-NY-day golf activity; user score wins", async () => {
    const id = insertActivity({
      source: "garmin",
      garmin_id: "g-golf-9",
      sport: "golf",
      start_time: "2026-07-19T13:00:00Z",
      duration_s: 15300,
    });
    await syncGolf(golfClient({ scorecardSummaries: [CARD] }));
    let rounds = listGolfRounds();
    expect(rounds.length).toBe(1);
    expect(rounds[0]!.kind).toBe("scorecard");
    expect(rounds[0]!.display_score).toBe(94);
    expect(rounds[0]!.score_source).toBe("garmin");
    expect(rounds[0]!.activity!.id).toBe(id);
    // user enters an explicit score: it outranks the synced strokes
    db.query("UPDATE activities SET golf_score = 92 WHERE id = ?").run(id);
    rounds = listGolfRounds();
    expect(rounds[0]!.display_score).toBe(92);
    expect(rounds[0]!.score_source).toBe("manual");
    // and the sync never wrote golf_score (ISC-430): only our UPDATE did
    const a = db.query("SELECT golf_score FROM activities WHERE id=?").get(id) as {
      golf_score: number;
    };
    expect(a.golf_score).toBe(92);
  });
  test("scorecard-only and activity-only rounds both appear", async () => {
    await syncGolf(golfClient({ scorecardSummaries: [CARD] }));
    insertActivity({
      sport: "golf",
      start_time: "2026-06-01T13:00:00Z",
      duration_s: 10800,
      title: "Heron Glen",
    });
    const rounds = listGolfRounds();
    expect(rounds.length).toBe(2);
    expect(rounds.map((r) => r.kind).sort()).toEqual(["activity", "scorecard"]);
  });
  test("route is auth-gated", async () => {
    const res = await apiRequest("GET", "/api/golf/rounds", {});
    expect(res.status).toBe(401);
  });
  test("authed route returns the merged shape", async () => {
    db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
    const token = seedToken();
    await syncGolf(golfClient({ scorecardSummaries: [CARD] }));
    const res = await apiRequest("GET", "/api/golf/rounds", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rounds: { course_name: string }[] };
    expect(body.rounds[0]!.course_name).toBe("Neshanic Valley");
  });
});
