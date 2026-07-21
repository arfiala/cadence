// Tool definitions for the Cadence MCP server. Each tool is a JSON-Schema
// input contract plus a handler that makes ONE authenticated API call via
// CadenceClient and formats the result for conversation. No SQL, no business
// logic — the API is the single source of truth (ISC-71). Kept in its own
// module (separate from server.ts stdio wiring) so the tool set can be
// exercised directly in tests without spawning a stdio transport.

import { CadenceClient, CadenceApiError } from "./client";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  handler: (client: CadenceClient, args: Record<string, unknown>) => Promise<string>;
};

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Formats a week/goal payload into a plain-language, conversation-ready line
// plus the raw numbers, so the DA can either read the sentence aloud or
// reason over the fields.
function formatWeek(week: Record<string, unknown>): string {
  const gap = typeof week.gap_message === "string" ? week.gap_message : "";
  return `${gap}\n\n${pretty(week)}`;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_week_summary",
    description:
      "Get the training summary for a week: G1-qualifying sessions vs the target, hours vs the target, per-day breakdown, and a plain-language gap line. Optional 'date' selects the week; omit for the current week.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Any ISO-8601 date/time inside the target week (e.g. 2026-07-14). Omit for this week.",
        },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const date = typeof args.date === "string" ? args.date : undefined;
      const week = (await client.getWeek(date)) as Record<string, unknown>;
      return formatWeek(week);
    },
  },
  {
    name: "get_goal_progress",
    description:
      "Get progress toward TELOS goal G1 (5 swim/bike sessions per week totaling 8 hours) for the current week: sessions and hours completed vs targets, with a plain-language gap statement.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const week = (await client.getWeek()) as Record<string, unknown>;
      const summary = {
        sessions: week.sessions,
        target_sessions: week.target_sessions,
        hours_g1: week.hours_g1,
        target_hours: week.target_hours,
        gap_sessions: week.gap_sessions,
        gap_hours: week.gap_hours,
        week_start: week.week_start,
        week_end: week.week_end,
      };
      return `${week.gap_message as string}\n\n${pretty(summary)}`;
    },
  },
  {
    name: "list_activities",
    description:
      "List training activities, newest first. Optional filters: from/to (ISO dates), sport (cycling, virtual_cycling, swimming, running, strength, other), limit (default 100).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "ISO-8601 lower bound on start time (inclusive)." },
        to: { type: "string", description: "ISO-8601 upper bound on start time (exclusive)." },
        sport: {
          type: "string",
          enum: ["cycling", "virtual_cycling", "swimming", "running", "strength", "other"],
        },
        limit: { type: "number", description: "Max rows (default 100, cap 500)." },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const result = await client.listActivities({
        from: typeof args.from === "string" ? args.from : undefined,
        to: typeof args.to === "string" ? args.to : undefined,
        sport: typeof args.sport === "string" ? args.sport : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
      });
      return pretty(result);
    },
  },
  {
    name: "log_activity",
    description:
      "Log a NEW manual training activity in Austin's REAL training log. This writes a permanent record. sport is required (cycling, virtual_cycling, swimming, running, strength, other), date is the ISO-8601 start time, duration_minutes is required. distance_km and notes are optional.",
    inputSchema: {
      type: "object",
      properties: {
        sport: {
          type: "string",
          enum: ["cycling", "virtual_cycling", "swimming", "running", "strength", "other"],
        },
        date: { type: "string", description: "ISO-8601 start time, e.g. 2026-07-14T06:30:00Z." },
        duration_minutes: { type: "number", description: "Duration in minutes (> 0)." },
        distance_km: { type: "number", description: "Optional distance in kilometers." },
        notes: { type: "string", description: "Optional free-text notes." },
      },
      required: ["sport", "date", "duration_minutes"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const durationMinutes = args.duration_minutes;
      if (typeof durationMinutes !== "number" || durationMinutes <= 0) {
        throw new Error("duration_minutes must be a positive number");
      }
      const body: Record<string, unknown> = {
        sport: args.sport,
        start_time: args.date,
        duration_s: Math.round(durationMinutes * 60),
      };
      if (typeof args.distance_km === "number") body.distance_m = args.distance_km * 1000;
      if (typeof args.notes === "string") body.notes = args.notes;

      const result = await client.createActivity(body);
      return `Logged activity.\n\n${pretty(result)}`;
    },
  },
  {
    name: "edit_activity",
    description:
      "Edit an existing activity in Austin's REAL training log. Provide the activity id and a 'fields' object with any of: sport, title, notes, start_time (ISO), duration_s, distance_m. Editing sport/title/notes on a Garmin-sourced activity is preserved across future syncs.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The activity id to edit." },
        fields: {
          type: "object",
          description: "Partial fields to update.",
          additionalProperties: true,
        },
      },
      required: ["id", "fields"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const id = args.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error("id must be an integer");
      }
      const fields = args.fields;
      if (typeof fields !== "object" || fields === null) {
        throw new Error("fields must be an object");
      }
      const result = await client.updateActivity(id, fields);
      return `Updated activity ${id}.\n\n${pretty(result)}`;
    },
  },
  {
    name: "delete_activity",
    description:
      "Permanently DELETE an activity from Austin's REAL training log. Requires confirm=true. A Garmin-sourced activity will reappear on the next sync unless it is also deleted in Garmin Connect.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The activity id to delete." },
        confirm: { type: "boolean", description: "Must be true to actually delete." },
      },
      required: ["id", "confirm"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const id = args.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error("id must be an integer");
      }
      if (args.confirm !== true) {
        throw new Error("Refusing to delete: pass confirm=true to permanently delete this activity.");
      }
      // The API itself requires ?confirm=true for Garmin rows; we pass it
      // through so both manual and Garmin deletes work from a single tool.
      const result = await client.deleteActivity(id, true);
      return `Deleted activity ${id}.\n\n${pretty(result)}`;
    },
  },
  {
    name: "trigger_sync",
    description:
      "Trigger a Garmin Connect sync now. Returns the sync outcome, or a note that a sync is already running.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const result = await client.triggerSync();
      return pretty(result);
    },
  },
  {
    name: "get_sync_status",
    description: "Get recent Garmin sync runs (status, timestamps, counts, and any errors).",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const result = await client.getSyncStatus();
      return pretty(result);
    },
  },
  {
    name: "get_sleep",
    description:
      "Get Austin's recent nightly sleep from Garmin (newest night first): total sleep time, sleep stages (deep/light/REM/awake seconds), bedtime and wake time, and Garmin's overall sleep score when available. Read-only. Sleep is context for recovery; it is not a training activity and never counts toward the G1 goal.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const result = await client.getSleep();
      return pretty(result);
    },
  },
  {
    name: "get_race_results",
    description:
      "Get Austin's stored ZwiftPower race results (date, event, category, finishing position, and power numbers). Reports whether ZwiftPower is configured yet.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const result = await client.getRaceResults();
      return pretty(result);
    },
  },
  {
    name: "get_training_load",
    description:
      "Get Austin's current training-load standing: Fitness (long-term load), Fatigue (short-term load), Form (freshness), and this week's total load. Higher Form means fresher; strongly negative means fatigued.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const result = (await client.getTrainingLoad()) as Record<string, unknown>;
      const current = result.current as Record<string, unknown> | undefined;
      const summary = {
        fitness: current?.fitness,
        fatigue: current?.fatigue,
        form: current?.form,
        week_load: result.week_load,
        thresholds_set: result.thresholds_set,
      };
      return pretty(summary);
    },
  },
  {
    name: "get_activity_detail",
    description:
      "Get the full detail for one activity by id: the local summary (sport, date, duration, distance, HR, power, RPE, notes) plus, for Garmin-sourced activities, lap splits and a GPS track when available. The rich Garmin detail is fetched lazily and cached on first view; if Garmin cannot be reached the local summary is still returned with detail_error set.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The activity id to fetch detail for." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const id = args.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error("id must be an integer");
      }
      const result = await client.getActivityDetail(id);
      return pretty(result);
    },
  },
  {
    name: "get_g1_risk",
    description:
      "Get whether Austin is on pace for TELOS goal G1 this week: week-to-date sessions and hours, how many more are needed, days left, a projection from the trailing four-week rhythm, and a verdict of met, on_track, or at_risk. Read-only, based only on session and hour counts.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const result = await client.getG1Risk();
      return pretty(result);
    },
  },
  {
    name: "get_week_digest",
    description:
      "Get the Monday digest for the LAST COMPLETED week: G1 sessions and hours vs target with a verdict, current Fitness/Fatigue/Form, any personal records set that week, and any ZwiftPower races that week. Read-only, for the weekly review.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async (client) => {
      const digest = await client.getWeekDigest();
      return pretty(digest);
    },
  },
  {
    name: "log_nutrition",
    description:
      "Log a meal in Austin's REAL nutrition log by describing it in plain language (e.g. 'two eggs, toast with butter, black coffee'). The server estimates itemized calories and macros and saves an editable entry. Optional 'date' (YYYY-MM-DD) sets the day; omit for today. If auto-estimation is unavailable (the API key is not set on the server, or the estimator fails), this returns an error asking you to add the entry manually with explicit macros instead.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Plain-language description of what was eaten.",
        },
        date: {
          type: "string",
          description: "Optional day as YYYY-MM-DD (America/New_York). Omit for today.",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const description = args.description;
      if (typeof description !== "string" || description.trim().length === 0) {
        throw new Error("description is required");
      }
      const body: Record<string, unknown> = { description, estimate: true };
      if (typeof args.date === "string") body.logged_date = args.date;
      const result = await client.logNutrition(body);
      return `Logged nutrition entry.\n\n${pretty(result)}`;
    },
  },
  {
    name: "get_nutrition_day",
    description:
      "Get a day's nutrition: every logged entry with its itemized foods, the day's calorie and macro totals, and the calorie/protein targets. Optional 'date' (YYYY-MM-DD); omit for today.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Optional day as YYYY-MM-DD (America/New_York). Omit for today.",
        },
      },
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const date = typeof args.date === "string" ? args.date : undefined;
      const day = await client.getNutritionDay(date);
      return pretty(day);
    },
  },
  {
    name: "edit_nutrition",
    description:
      "Edit an existing entry in Austin's REAL nutrition log. Provide the entry id and a 'fields' object with any of: description, notes, logged_date (YYYY-MM-DD), or items (an array of {food, quantity, kcal, protein_g, carbs_g, fat_g} that fully replaces the entry's items). Editing marks the entry as human-corrected and recomputes its totals.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The nutrition entry id to edit." },
        fields: {
          type: "object",
          description: "Partial fields to update.",
          additionalProperties: true,
        },
      },
      required: ["id", "fields"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const id = args.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error("id must be an integer");
      }
      const fields = args.fields;
      if (typeof fields !== "object" || fields === null) {
        throw new Error("fields must be an object");
      }
      const result = await client.editNutrition(id, fields);
      return `Updated nutrition entry ${id}.\n\n${pretty(result)}`;
    },
  },
  {
    name: "delete_nutrition",
    description:
      "Permanently DELETE an entry from Austin's REAL nutrition log. Requires confirm=true. The entry's itemized foods are removed with it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The nutrition entry id to delete." },
        confirm: { type: "boolean", description: "Must be true to actually delete." },
      },
      required: ["id", "confirm"],
      additionalProperties: false,
    },
    handler: async (client, args) => {
      const id = args.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        throw new Error("id must be an integer");
      }
      if (args.confirm !== true) {
        throw new Error("Refusing to delete: pass confirm=true to permanently delete this nutrition entry.");
      }
      const result = await client.deleteNutrition(id);
      return `Deleted nutrition entry ${id}.\n\n${pretty(result)}`;
    },
  },
];

// Invoke a tool by name, turning any API/validation failure into a
// human-readable string flagged as an error (ISC-69) rather than letting an
// exception propagate as a raw stack trace across the stdio boundary.
export async function callTool(
  client: CadenceClient,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) {
    return { text: `Unknown tool: ${name}`, isError: true };
  }
  try {
    const text = await tool.handler(client, args);
    return { text, isError: false };
  } catch (err) {
    if (err instanceof CadenceApiError) {
      return { text: `Cadence API error: ${err.message}`, isError: true };
    }
    return { text: err instanceof Error ? err.message : String(err), isError: true };
  }
}
