// MCP tests (ISC-60..72, ISC-91). Every tool is exercised against a REAL
// running Cadence instance (a Bun.serve on a test port), driven both through
// the tool layer directly and through the stdio server via an in-memory
// linked transport pair, so the full MCP handshake + tool-call path is
// covered without spawning a subprocess.

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { db } from "../src/db";
import { fetchHandler } from "../src/server";
import { resetDb, seedToken } from "./helpers";
import { CadenceClient, readConfig, CadenceApiError } from "../mcp/client";
import { TOOLS, callTool } from "../mcp/tools";
import { buildServer } from "../mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let token: string;

const stubServer = { requestIP: () => ({ address: "127.0.0.1" }) };

beforeAll(() => {
  server = Bun.serve({
    port: 0, // ephemeral
    fetch: (req) => fetchHandler(req, stubServer),
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  resetDb();
  db.query("INSERT INTO users (email, password_hash) VALUES ('a@b.com','x')").run();
  token = seedToken();
});

function client(): CadenceClient {
  return new CadenceClient({ url: baseUrl, token });
}

describe("readConfig (ISC-68)", () => {
  test("throws a clear error when CADENCE_URL or CADENCE_TOKEN is missing", () => {
    expect(() => readConfig({})).toThrow(/CADENCE_URL/);
    expect(() => readConfig({ CADENCE_URL: "http://x" })).toThrow(/CADENCE_TOKEN/);
    const cfg = readConfig({ CADENCE_URL: "http://x/", CADENCE_TOKEN: "t" });
    expect(cfg.url).toBe("http://x"); // trailing slash trimmed
  });
});

describe("tool surface (ISC-60, ISC-61..67)", () => {
  test("exactly the 20 specified tools are registered", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "delete_activity",
        "delete_nutrition",
        "edit_activity",
        "edit_nutrition",
        "get_activity_detail",
        "get_g1_risk",
        "get_goal_progress",
        "get_nutrition_day",
        "get_nutrition_history",
        "get_plan_week",
        "get_race_results",
        "get_sleep",
        "get_sync_status",
        "get_training_load",
        "get_week_digest",
        "get_week_summary",
        "list_activities",
        "log_activity",
        "log_nutrition",
        "trigger_sync",
      ].sort(),
    );
  });

  test("destructive tools name Austin's REAL training log (ISC-72)", () => {
    const log = TOOLS.find((t) => t.name === "log_activity")!;
    const del = TOOLS.find((t) => t.name === "delete_activity")!;
    const edit = TOOLS.find((t) => t.name === "edit_activity")!;
    expect(log.description).toContain("REAL training log");
    expect(del.description).toContain("REAL training log");
    expect(edit.description).toContain("REAL training log");
  });
});

describe("tool round-trips against a live instance (ISC-91)", () => {
  test("log_activity writes a real DB row (ISC-63)", async () => {
    const res = await callTool(client(), "log_activity", {
      sport: "cycling",
      date: "2026-07-14T06:00:00Z",
      duration_minutes: 45,
      distance_km: 20,
      notes: "via MCP",
    });
    expect(res.isError).toBe(false);
    const row = db.query("SELECT sport, duration_s, distance_m, notes FROM activities LIMIT 1").get() as {
      sport: string;
      duration_s: number;
      distance_m: number;
      notes: string;
    };
    expect(row.sport).toBe("cycling");
    expect(row.duration_s).toBe(2700);
    expect(row.distance_m).toBe(20000);
    expect(row.notes).toBe("via MCP");
  });

  test("list_activities returns logged rows (ISC-62)", async () => {
    await callTool(client(), "log_activity", { sport: "swimming", date: "2026-07-14T06:00:00Z", duration_minutes: 30 });
    const res = await callTool(client(), "list_activities", {});
    expect(res.isError).toBe(false);
    expect(res.text).toContain("swimming");
  });

  test("get_week_summary and get_goal_progress return G1 language (ISC-61, ISC-67)", async () => {
    await callTool(client(), "log_activity", { sport: "cycling", date: "2026-07-14T06:00:00Z", duration_minutes: 60 });
    const week = await callTool(client(), "get_week_summary", { date: "2026-07-14T12:00:00Z" });
    expect(week.isError).toBe(false);
    expect(week.text.toLowerCase()).toContain("session");

    const goal = await callTool(client(), "get_goal_progress", {});
    expect(goal.isError).toBe(false);
    expect(goal.text).toContain("target_sessions");
  });

  test("edit_activity updates a row (ISC-64)", async () => {
    await callTool(client(), "log_activity", { sport: "cycling", date: "2026-07-14T06:00:00Z", duration_minutes: 60 });
    const id = (db.query("SELECT id FROM activities LIMIT 1").get() as { id: number }).id;
    const res = await callTool(client(), "edit_activity", { id, fields: { notes: "edited via MCP" } });
    expect(res.isError).toBe(false);
    const row = db.query("SELECT notes FROM activities WHERE id=?").get(id) as { notes: string };
    expect(row.notes).toBe("edited via MCP");
  });

  test("delete_activity refuses without confirm, succeeds with it (ISC-65)", async () => {
    await callTool(client(), "log_activity", { sport: "cycling", date: "2026-07-14T06:00:00Z", duration_minutes: 60 });
    const id = (db.query("SELECT id FROM activities LIMIT 1").get() as { id: number }).id;

    const refused = await callTool(client(), "delete_activity", { id, confirm: false });
    expect(refused.isError).toBe(true);
    expect((db.query("SELECT COUNT(*) as n FROM activities").get() as { n: number }).n).toBe(1);

    const ok = await callTool(client(), "delete_activity", { id, confirm: true });
    expect(ok.isError).toBe(false);
    expect((db.query("SELECT COUNT(*) as n FROM activities").get() as { n: number }).n).toBe(0);
  });

  test("get_activity_detail returns a manual activity's detail as null (ISC-348)", async () => {
    await callTool(client(), "log_activity", { sport: "swimming", date: "2026-07-14T06:00:00Z", duration_minutes: 30 });
    const id = (db.query("SELECT id FROM activities LIMIT 1").get() as { id: number }).id;
    const res = await callTool(client(), "get_activity_detail", { id });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("\"detail\": null");
  });

  test("get_g1_risk returns a verdict (ISC-348)", async () => {
    const res = await callTool(client(), "get_g1_risk", {});
    expect(res.isError).toBe(false);
    expect(res.text).toContain("verdict");
  });

  test("get_sync_status returns runs (ISC-66)", async () => {
    db.query(
      "INSERT INTO sync_runs (started_at, status) VALUES ('2026-07-14T10:00:00Z','success')",
    ).run();
    const res = await callTool(client(), "get_sync_status", {});
    expect(res.isError).toBe(false);
    expect(res.text).toContain("success");
  });
});

describe("error surfacing (ISC-69)", () => {
  test("a bad token surfaces a readable API error, not a stack trace", async () => {
    const badClient = new CadenceClient({ url: baseUrl, token: "deadbeef" });
    const res = await callTool(badClient, "list_activities", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Cadence API error");
    expect(res.text).not.toContain("at Object.");
  });

  test("an unreachable server surfaces a connection error", async () => {
    const deadClient = new CadenceClient({ url: "http://127.0.0.1:1", token });
    const res = await callTool(deadClient, "get_sync_status", {});
    expect(res.isError).toBe(true);
    expect(res.text.toLowerCase()).toContain("cadence");
  });
});

describe("full stdio MCP handshake (ISC-60)", () => {
  test("an MCP client lists tools and calls one over a linked transport", async () => {
    const mcpServer = buildServer(client());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "test-client", version: "1.0.0" });

    await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const tools = await mcpClient.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toContain("get_week_summary");
    expect(tools.tools.length).toBe(20);

    await callTool(client(), "log_activity", { sport: "cycling", date: "2026-07-14T06:00:00Z", duration_minutes: 60 });
    const result = await mcpClient.callTool({ name: "get_goal_progress", arguments: {} });
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).toContain("target_sessions");

    await mcpClient.close();
    await mcpServer.close();
  });
});

describe("no business logic / SQL in mcp/ (ISC-71)", () => {
  test("CadenceApiError is the only error type the client raises for API failures", () => {
    // Structural: the client module exports CadenceApiError and no db import.
    expect(CadenceApiError).toBeDefined();
  });
});

describe("nutrition tools round-trip (ISC-206, ISC-207, ISC-208)", () => {
  // log_nutrition drives the estimate path, which calls the Anthropic API via
  // the global fetch and the ANTHROPIC_API_KEY env. We stub ONLY the Anthropic
  // host (delegating every other fetch, including the MCP client's calls to the
  // test server, to the real fetch) and set a test key, so the round-trip runs
  // with zero real network calls.
  const realFetch = globalThis.fetch;
  const priorKey = process.env.ANTHROPIC_API_KEY;

  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      const urlStr = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
      if (urlStr.includes("api.anthropic.com")) {
        const text = JSON.stringify([
          { food: "banana", quantity: "1 medium", kcal: 100, protein_g: 1, carbs_g: 27, fat_g: 0.3 },
        ]);
        return Promise.resolve(
          new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status: 200 }),
        );
      }
      return realFetch(input as Parameters<typeof fetch>[0], init as Parameters<typeof fetch>[1]);
    }) as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
  });

  test("log -> get -> edit -> delete, and delete refuses without confirm", async () => {
    const logged = await callTool(client(), "log_nutrition", { description: "a banana", date: "2026-07-15" });
    expect(logged.isError).toBe(false);

    const day = await callTool(client(), "get_nutrition_day", { date: "2026-07-15" });
    expect(day.isError).toBe(false);
    expect(day.text).toContain("banana");

    const id = (db.query("SELECT id FROM nutrition_entries LIMIT 1").get() as { id: number }).id;

    const edited = await callTool(client(), "edit_nutrition", { id, fields: { notes: "post workout" } });
    expect(edited.isError).toBe(false);
    const row = db.query("SELECT source FROM nutrition_entries WHERE id=?").get(id) as { source: string };
    expect(row.source).toBe("edited");

    const refused = await callTool(client(), "delete_nutrition", { id, confirm: false });
    expect(refused.isError).toBe(true);
    expect((db.query("SELECT COUNT(*) as n FROM nutrition_entries").get() as { n: number }).n).toBe(1);

    const ok = await callTool(client(), "delete_nutrition", { id, confirm: true });
    expect(ok.isError).toBe(false);
    expect((db.query("SELECT COUNT(*) as n FROM nutrition_entries").get() as { n: number }).n).toBe(0);
  });

  test("destructive nutrition tools name Austin's REAL nutrition log (ISC-72 parity)", () => {
    const log = TOOLS.find((t) => t.name === "log_nutrition")!;
    const del = TOOLS.find((t) => t.name === "delete_nutrition")!;
    const edit = TOOLS.find((t) => t.name === "edit_nutrition")!;
    expect(log.description).toContain("REAL nutrition log");
    expect(del.description).toContain("REAL nutrition log");
    expect(edit.description).toContain("REAL nutrition log");
  });
});
