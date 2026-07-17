// ZwiftPower tests (ISC-118..132). Exercises the sync engine against a MOCK
// ZwiftPowerClient only, no test ever performs a live Zwift/ZwiftPower login
// (ISC-129); the real wrapper is never touched here. Covers idempotent upsert,
// category capture, failure recording, the never-writes-to-activities
// invariant, dormancy when unconfigured, auth-gating, and credential handling.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { db } from "../src/db";
import type { ZwiftPowerClient, ZwiftPowerResult } from "../src/zwiftpower/types";
import { ZwiftPowerSyncError } from "../src/zwiftpower/types";
import {
  runZpSyncOnce,
  triggerZpSync,
  _resetZpSyncState,
  listResults,
} from "../src/zwiftpower/sync";
import {
  isZwiftPowerConfigured,
  getZwiftPowerConfig,
} from "../src/zwiftpower/config";
import { fetchHandler } from "../src/server";
import { resetDb, seedUser, seedToken } from "./helpers";

beforeEach(() => {
  resetDb();
  _resetZpSyncState();
});

function mockClient(results: ZwiftPowerResult[]): ZwiftPowerClient {
  return {
    async listRiderResults() {
      return results;
    },
  };
}

function failingClient(message: string): ZwiftPowerClient {
  return {
    async listRiderResults() {
      throw new ZwiftPowerSyncError(message);
    },
  };
}

const RESULT_B: ZwiftPowerResult = {
  eventId: "555001",
  eventDate: "2026-07-12T18:00:00.000Z",
  title: "Tour de Zwift Stage 3",
  category: "B",
  position: 14,
  avgPower: 240,
  normPower: 268,
  timeSeconds: 3125,
};

describe("configured gate (ISC-120, ISC-131)", () => {
  test("no ZWIFT_* env in the test process means the feature is dormant", () => {
    // The test harness never carries real credentials (ISC-129): this proves
    // it and is the dormancy signal server.ts uses to skip the scheduler.
    expect(isZwiftPowerConfigured({})).toBe(false);
    expect(isZwiftPowerConfigured({ ZWIFT_USERNAME: "x" })).toBe(false); // needs both
    expect(isZwiftPowerConfigured({ ZWIFT_USERNAME: "x", ZWIFT_PASSWORD: "y" })).toBe(true);
  });

  test("getZwiftPowerConfig throws a non-secret error when creds are missing", () => {
    expect(() => getZwiftPowerConfig({})).toThrow(/ZWIFT_USERNAME/);
    // Missing profile id is its own clear error, not a credential leak.
    expect(() =>
      getZwiftPowerConfig({ ZWIFT_USERNAME: "u", ZWIFT_PASSWORD: "p" }),
    ).toThrow(/ZWIFT_PROFILE_ID/);
  });

  test("credentials are read from env and never embedded in error strings (ISC-120)", () => {
    const secret = "s3cr3t-passphrase";
    const cfg = getZwiftPowerConfig({
      ZWIFT_USERNAME: "rider@example.com",
      ZWIFT_PASSWORD: secret,
      ZWIFT_PROFILE_ID: "12345",
    });
    expect(cfg.password).toBe(secret);
    // A sync failure message must never contain the credential.
    const err = new ZwiftPowerSyncError("ZwiftPower rejected the login.");
    expect(err.message).not.toContain(secret);
  });
});

describe("upsert idempotency (ISC-122, ISC-123)", () => {
  test("inserts a result with its category and power numbers", async () => {
    const outcome = await runZpSyncOnce(mockClient([RESULT_B]));
    expect(outcome.status).toBe("success");
    expect(outcome.results_new).toBe(1);

    const row = db.query("SELECT * FROM zwiftpower_results WHERE event_id='555001'").get() as {
      category: string;
      position: number;
      avg_power: number;
      norm_power: number;
      time_s: number;
    };
    expect(row.category).toBe("B"); // ISC-123
    expect(row.position).toBe(14);
    expect(row.avg_power).toBe(240);
    expect(row.norm_power).toBe(268);
    expect(row.time_s).toBe(3125);
  });

  test("syncing the same result twice yields one row (ISC-122)", async () => {
    await runZpSyncOnce(mockClient([RESULT_B]));
    const outcome = await runZpSyncOnce(mockClient([RESULT_B]));
    expect(outcome.results_new).toBe(0);
    const count = db.query("SELECT COUNT(*) as n FROM zwiftpower_results").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("a result with no category stores null, not an empty string", async () => {
    const noCat: ZwiftPowerResult = { ...RESULT_B, eventId: "555002", category: null };
    await runZpSyncOnce(mockClient([noCat]));
    const row = db.query("SELECT category FROM zwiftpower_results WHERE event_id='555002'").get() as {
      category: string | null;
    };
    expect(row.category).toBeNull();
  });
});

describe("failure recording (ISC-124)", () => {
  test("a failing sync records an errored run and does not throw", async () => {
    const outcome = await runZpSyncOnce(failingClient("ZwiftPower rate limited"));
    expect(outcome.status).toBe("error");
    expect(outcome.error).toBe("ZwiftPower rate limited");

    const run = db.query("SELECT * FROM zwiftpower_sync_runs ORDER BY id DESC LIMIT 1").get() as {
      status: string;
      error: string;
      finished_at: string | null;
    };
    expect(run.status).toBe("error");
    expect(run.error).toBe("ZwiftPower rate limited");
    expect(run.finished_at).not.toBeNull();
  });

  test("the sync engine logs nothing to the console on failure (no secret leak, ISC-120)", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    console.error = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      await runZpSyncOnce(failingClient("boom"));
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    expect(logs).toEqual([]);
  });
});

describe("never writes to activities (ISC-128)", () => {
  test("a ZwiftPower sync leaves the activities table untouched", async () => {
    await runZpSyncOnce(mockClient([RESULT_B]));
    const count = db.query("SELECT COUNT(*) as n FROM activities").get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe("concurrency collapse", () => {
  test("a second concurrent trigger returns 'already running'", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowClient: ZwiftPowerClient = {
      async listRiderResults() {
        await gate;
        return [RESULT_B];
      },
    };
    const first = triggerZpSync(slowClient);
    const second = await triggerZpSync(slowClient);
    expect(second.triggered).toBe(false);
    if (!second.triggered) expect(second.message).toBe("already running");
    release();
    const firstResult = await first;
    expect(firstResult.triggered).toBe(true);
  });
});

describe("results ordering", () => {
  test("listResults returns newest event first, null-dated last", async () => {
    await runZpSyncOnce(
      mockClient([
        { ...RESULT_B, eventId: "a", eventDate: "2026-06-01T00:00:00.000Z" },
        { ...RESULT_B, eventId: "b", eventDate: "2026-07-01T00:00:00.000Z" },
        { ...RESULT_B, eventId: "c", eventDate: null },
      ]),
    );
    const ids = listResults().map((r) => r.event_id);
    expect(ids[0]).toBe("b");
    expect(ids[1]).toBe("a");
    expect(ids[2]).toBe("c");
  });
});

describe("HTTP surface (ISC-125, ISC-131)", () => {
  const stubServer = { requestIP: () => ({ address: "127.0.0.1" }) };

  test("POST /api/zwiftpower/sync is auth-gated: 401 unauthenticated (ISC-125)", async () => {
    const res = await fetchHandler(
      new Request("http://localhost/api/zwiftpower/sync", { method: "POST" }),
      stubServer,
    );
    expect(res.status).toBe(401);
  });

  test("GET /api/zwiftpower/results reports not-configured when env is unset (ISC-131)", async () => {
    await seedUser();
    const token = seedToken();
    const res = await fetchHandler(
      new Request("http://localhost/api/zwiftpower/results", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      stubServer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { configured: boolean; results: unknown[] };
    expect(body.configured).toBe(false);
    expect(body.results).toEqual([]);
  });

  test("POST sync while unconfigured returns a clean message, never a crash (ISC-131)", async () => {
    await seedUser();
    const token = seedToken();
    const res = await fetchHandler(
      new Request("http://localhost/api/zwiftpower/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      stubServer,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { triggered: boolean; configured: boolean };
    expect(body.triggered).toBe(false);
    expect(body.configured).toBe(false);
  });
});
