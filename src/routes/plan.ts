// Training plan routes. Read/mark-only surface over planned_workouts: the
// plan's CONTENT lives in src/data/trainingPlan.ts and lands via
// bin/seed-plan.ts. These routes never create or edit sessions, so the seeded
// plan stays the single source of truth (edit the data file, reseed --force).

import { db } from "../db";
import { jsonError, readJsonBody } from "../lib/http";
import { startOfWeek, nyDateString, TIME_ZONE } from "../week";
import {
  PLAN_PHASE,
  PLAN_START,
  PLAN_WEEKS,
  MACRO_ROADMAP,
  PRIORITY_NOTE,
  FTP_W,
  zonesPowerFor,
  ZONES_HR,
} from "../data/trainingPlan";
import { getThresholds } from "../services/weekSummary";

type PlannedRow = {
  id: number;
  plan_day: string;
  sport: string;
  title: string;
  detail: string;
  duration_min: number;
  distance_m: number | null;
  target: string | null;
  tss_planned: number | null;
  week_no: number;
  phase: string;
  status: string;
  activity_id: number | null;
  sort: number;
};

const VALID_STATUS = new Set(["planned", "done", "skipped"]);

function isoAddDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y as number, (m as number) - 1, (d as number) + n))
    .toISOString()
    .slice(0, 10);
}

// The 7 NY-calendar dates (Mon..Sun) of the week containing the given ISO
// date. Noon UTC on that date is unambiguously the same NY calendar day in
// both EST and EDT, so DST transitions cannot shift the anchor.
export function weekDaysFor(isoDate: string): string[] {
  const instant = new Date(`${isoDate}T12:00:00Z`);
  const monday = nyDateString(startOfWeek(instant));
  return Array.from({ length: 7 }, (_, i) => isoAddDays(monday, i));
}

export function getPlanWeek(url: URL): Response {
  const date = url.searchParams.get("date") ?? nyDateString(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonError("Invalid date", 400);
  const days = weekDaysFor(date);
  const rows = db
    .query(
      `SELECT * FROM planned_workouts WHERE plan_day IN (${days.map(() => "?").join(",")})
       ORDER BY plan_day ASC, sort ASC, id ASC`,
    )
    .all(...days) as PlannedRow[];
  return Response.json({ weekStart: days[0], days, sessions: rows });
}

export function getPlanSummary(): Response {
  const today = nyDateString(new Date());
  const totals = db
    .query(
      `SELECT
         COALESCE(SUM(duration_min), 0) AS planned_min,
         COALESCE(SUM(CASE WHEN status = 'done' THEN duration_min ELSE 0 END), 0) AS done_min,
         COUNT(*) AS total_rows,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_rows
       FROM planned_workouts`,
    )
    .get() as { planned_min: number; done_min: number; total_rows: number; done_rows: number };

  // Current plan week from today's NY date; clamped so pre-start shows week 1
  // and post-block shows the final week rather than nonsense.
  const dayDiff = Math.floor(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${PLAN_START}T00:00:00Z`)) / 86400000,
  );
  const rawWeek = Math.floor(dayDiff / 7) + 1;
  const weekNo = Math.min(Math.max(rawWeek, 1), PLAN_WEEKS);

  const next = db
    .query(
      `SELECT plan_day, sport, title, duration_min FROM planned_workouts
       WHERE status = 'planned' AND plan_day >= ? AND sport != 'rest'
       ORDER BY plan_day ASC, sort ASC LIMIT 1`,
    )
    .get(today) as { plan_day: string; sport: string; title: string; duration_min: number } | null;

  const pastPlanned = db
    .query(
      `SELECT COALESCE(SUM(duration_min), 0) AS m FROM planned_workouts WHERE plan_day <= ?`,
    )
    .get(today) as { m: number };

  return Response.json({
    phase: PLAN_PHASE,
    planStart: PLAN_START,
    totalWeeks: PLAN_WEEKS,
    weekNo,
    timeZone: TIME_ZONE,
    plannedMinutes: totals.planned_min,
    doneMinutes: totals.done_min,
    totalSessions: totals.total_rows,
    doneSessions: totals.done_rows,
    // Completion is measured against what the calendar has offered so far,
    // not the whole block, so week 2 of 12 can honestly read 100 percent.
    completionPercent:
      pastPlanned.m > 0 ? Math.round((totals.done_min / pastPlanned.m) * 100) : 0,
    nextSession: next,
    macroRoadmap: MACRO_ROADMAP,
    priorityNote: PRIORITY_NOTE,
    zonesPower: zonesPowerFor(getThresholds().ftpWatts ?? FTP_W),
    zonesHr: ZONES_HR,
  });
}

export async function patchPlanStatus(req: Request, id: string): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const status = (body as { status?: unknown }).status;
  if (typeof status !== "string" || !VALID_STATUS.has(status)) {
    return jsonError("status must be one of planned, done, skipped", 400);
  }
  const row = db.query(
    "SELECT id, title, plan_day, done_source, activity_id FROM planned_workouts WHERE id = ?",
  ).get(Number(id)) as { id: number; title: string; plan_day: string; done_source: string | null; activity_id: number | null } | null;
  if (row === null) return jsonError("Not found", 404);

  // Reverting an auto-done is a signal, not noise: tombstone the pair so the
  // matcher never re-marks what he explicitly un-marked (trust guard).
  if (status === "planned" && row.done_source === "auto" && row.activity_id !== null) {
    db.query(
      `INSERT INTO plan_adaptations (kind, description, reason, effective_from, session_id, activity_id)
       VALUES ('auto_done_reverted', ?, ?, ?, ?, ?)`,
    ).run(
      `${row.title} on ${row.plan_day} un-marked`,
      "You reverted an automatic match, so that activity will not re-complete this session.",
      row.plan_day, row.id, row.activity_id,
    );
    db.query(
      "UPDATE planned_workouts SET status = ?, done_source = NULL, activity_id = NULL WHERE id = ?",
    ).run(status, row.id);
  } else {
    const doneSource = status === "done" ? "manual" : null;
    db.query(
      "UPDATE planned_workouts SET status = ?, done_source = ? WHERE id = ?",
    ).run(status, doneSource, row.id);
  }

  // Best-effort adapt pass after every status change.
  try {
    const { runAdaptPass } = await import("../services/planAdapt");
    runAdaptPass();
  } catch {
    // never fail the request over adaptation
  }

  const updated = db.query("SELECT * FROM planned_workouts WHERE id = ?").get(Number(id));
  return Response.json({ session: updated });
}

export function getPlanAdaptations(): Response {
  const rows = db.query(
    "SELECT id, created_at, effective_from, kind, description, reason FROM plan_adaptations ORDER BY id DESC LIMIT 20",
  ).all();
  return Response.json({ adaptations: rows });
}
