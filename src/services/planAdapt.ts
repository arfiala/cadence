// Adaptive plan engine. Deterministic rules, no LLM, every change logged to
// plan_adaptations with a plain-language reason. Three responsibilities:
//   R5 auto-done: a synced activity completes its matching planned session
//   R2 time hints: learn median start hour per sport, annotate future cards
//   R1/R3 structure: day-affinity swaps and progression holds, max ONE
//        structural change per pass (holds outrank swaps), under hard rails
// Rails are sovereign: the 10 h ceiling and the RUNSAFE long-run rule are
// re-validated after any structural change; a violation aborts that change
// and logs rail_abort instead of applying. Volume never inflates.

import { db } from "../db";
import { startOfWeek, nyDateString, TIME_ZONE } from "../week";

export const BIKE_SPORTS = new Set(["cycling", "virtual_cycling", "indoor_cycling"]);
export const RUN_SPORTS = new Set(["running"]);
export const STRENGTH_SPORTS = new Set(["strength"]);
const CUTBACK_WEEKS = new Set([4, 8, 12]);
const WEEK_CEILING_MIN = 600;
const SWAP_COOLDOWN_DAYS = 28;
// Deliberately separate constants (Advisor 2026-07-30): tuning one must
// never silently move the other.
const MATCH_DURATION_FLOOR = 0.7; // share of planned minutes for full credit
const HOLD_COMPLETION_THRESHOLD = 0.7; // weekly completion below this holds
const CAUSE_CHECK_RATIO = 0.7; // actual synced share that reframes a bad week as fit, not capacity

type PlannedRow = {
  id: number; plan_day: string; sport: string; title: string; detail: string;
  duration_min: number; distance_m: number | null; target: string | null;
  tss_planned: number | null; week_no: number; phase: string; status: string;
  activity_id: number | null; sort: number; kind: string | null;
  time_hint: string | null; done_source: string | null; adjusted: number;
};
type ActivityRow = { id: number; sport: string; start_time: string; duration_s: number };

export function deriveKind(title: string): string {
  if (title.startsWith("Zwift race")) return "race";
  if (title.startsWith("Long ride")) return "long_ride";
  if (title.startsWith("Long run")) return "long_run";
  if (title.startsWith("Easy run")) return "easy_run";
  if (title.startsWith("Easy spin")) return "spin";
  if (title.startsWith("Strength A")) return "strength_a";
  if (title.startsWith("Strength B")) return "strength_b";
  if (title.startsWith("Brick run")) return "brick";
  return "rest";
}

export function isoAddDays(iso: string, n: number): string {
  const p = iso.split("-").map(Number);
  return new Date(Date.UTC(p[0] as number, (p[1] as number) - 1, (p[2] as number) + n))
    .toISOString().slice(0, 10);
}

function nextMonday(now: Date): string {
  const thisMonday = nyDateString(startOfWeek(now));
  return isoAddDays(thisMonday, 7);
}

function nyDow(iso: string): number {
  // 0=Mon..6=Sun for a plain calendar date
  const d = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return (d + 6) % 7;
}

function nyHourOf(startTime: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE, hour: "2-digit", hour12: false,
  }).format(new Date(startTime));
  return Number(h) % 24;
}

function logAdaptation(kind: string, description: string, reason: string, effectiveFrom: string, sessionId?: number, activityId?: number): void {
  // Dedupe repeated identical aborts (Advisor: a stuck invariant must not
  // flood the athlete-facing feed with the same line every pass).
  if (kind === "rail_abort") {
    const dup = db.query(
      "SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'rail_abort' AND description = ? AND created_at >= datetime('now', '-7 days')",
    ).get(description) as { n: number };
    if (dup.n > 0) return;
  }
  // OR IGNORE cooperates with the partial UNIQUE index on auto_done pairs:
  // durable idempotence even if the in-process guard is ever lost.
  db.query(
    `INSERT OR IGNORE INTO plan_adaptations (kind, description, reason, effective_from, session_id, activity_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(kind, description, reason, effectiveFrom, sessionId ?? null, activityId ?? null);
}

export function sportMatchesPlanned(plannedSport: string, activitySport: string): boolean {
  if (plannedSport === "bike") return BIKE_SPORTS.has(activitySport);
  if (plannedSport === "run") return RUN_SPORTS.has(activitySport);
  if (plannedSport === "strength") return STRENGTH_SPORTS.has(activitySport) || activitySport === "other";
  return false;
}

// --- R5: auto-done matching -------------------------------------------------

export function matchActivities(now: Date): number {
  const today = nyDateString(now);
  const windowStart = isoAddDays(today, -7);
  const planned = db.query(
    `SELECT * FROM planned_workouts
     WHERE status = 'planned' AND sport IN ('bike','run','strength')
       AND plan_day >= ? AND plan_day <= ?
     ORDER BY plan_day ASC, sort ASC`,
  ).all(windowStart, today) as PlannedRow[];
  if (planned.length === 0) return 0;

  const used = new Set<number>(
    (db.query("SELECT activity_id FROM planned_workouts WHERE activity_id IS NOT NULL").all() as { activity_id: number }[])
      .map((r) => r.activity_id),
  );
  const tombstoned = new Set<string>(
    (db.query("SELECT session_id, activity_id FROM plan_adaptations WHERE kind = 'auto_done_reverted'").all() as { session_id: number; activity_id: number }[])
      .map((r) => `${r.session_id}:${r.activity_id}`),
  );

  let matched = 0;
  for (const p of planned) {
    const acts = db.query(
      `SELECT id, sport, start_time, duration_s FROM activities
       WHERE date(start_time) >= ? AND date(start_time) <= ? ORDER BY start_time ASC`,
    ).all(isoAddDays(p.plan_day, -1), isoAddDays(p.plan_day, 1)) as ActivityRow[];
    for (const a of acts) {
      if (used.has(a.id)) continue;
      if (nyDateString(new Date(a.start_time)) !== p.plan_day) continue;
      if (!sportMatchesPlanned(p.sport, a.sport)) continue;
      const min = a.duration_s / 60;
      // MatchStrictness guard (SystemsThinking R1 "phantom completion"): a
      // liberal matcher corrupts the completion signal every other rule reads.
      // Full credit requires 70 percent of planned duration.
      if (p.sport === "strength") {
        if (min < 15) continue;
      } else if (min < p.duration_min * MATCH_DURATION_FLOOR || min > p.duration_min * 1.5) {
        continue;
      }
      if (tombstoned.has(`${p.id}:${a.id}`)) continue;
      db.query(
        "UPDATE planned_workouts SET status = 'done', done_source = 'auto', activity_id = ? WHERE id = ?",
      ).run(a.id, p.id);
      used.add(a.id);
      matched += 1;
      logAdaptation(
        "auto_done",
        `${p.title} on ${p.plan_day} marked done`,
        `Matched your ${Math.round(min)} min ${a.sport.replace("_", " ")} on ${p.plan_day}.`,
        p.plan_day, p.id, a.id,
      );
      break;
    }
  }
  return matched;
}

// --- R2: time-of-day hints --------------------------------------------------

export function updateTimeHints(now: Date): void {
  const since = isoAddDays(nyDateString(now), -56);
  for (const [plannedSport, sports] of [
    ["bike", BIKE_SPORTS], ["run", RUN_SPORTS], ["strength", STRENGTH_SPORTS],
  ] as const) {
    const acts = db.query(
      `SELECT start_time FROM activities WHERE date(start_time) >= ? AND sport IN (${[...sports].map(() => "?").join(",")})
       ORDER BY start_time ASC`,
    ).all(since, ...sports) as { start_time: string }[];
    if (acts.length < 3) continue;
    const hours = acts.map((a) => nyHourOf(a.start_time)).sort((x, y) => x - y);
    const median = hours[Math.floor(hours.length / 2)] as number;
    const hint = `You usually do this around ${String(median).padStart(2, "0")}:00`;
    const current = db.query(
      "SELECT DISTINCT time_hint FROM planned_workouts WHERE sport = ? AND plan_day >= ? AND time_hint IS NOT NULL",
    ).all(plannedSport, nyDateString(now)) as { time_hint: string }[];
    const already = current.length === 1 && current[0]!.time_hint === hint;
    db.query(
      "UPDATE planned_workouts SET time_hint = ? WHERE sport = ? AND plan_day >= ? AND status = 'planned'",
    ).run(hint, plannedSport, nyDateString(now));
    if (!already) {
      logAdaptation("time_hint", `${plannedSport} sessions now hint ${String(median).padStart(2, "0")}:00`,
        `Your last ${acts.length} ${plannedSport} sessions cluster around ${String(median).padStart(2, "0")}:00.`,
        nyDateString(now));
    }
  }
}

// --- rails ------------------------------------------------------------------

export function railViolations(): string[] {
  const out: string[] = [];
  const weeks = db.query(
    "SELECT week_no, SUM(duration_min) m FROM planned_workouts GROUP BY week_no",
  ).all() as { week_no: number; m: number }[];
  for (const w of weeks) {
    if (w.m > WEEK_CEILING_MIN) out.push(`week ${w.week_no} exceeds ${WEEK_CEILING_MIN} min`);
  }
  const longRuns = db.query(
    "SELECT plan_day, distance_m FROM planned_workouts WHERE kind = 'long_run' ORDER BY plan_day ASC",
  ).all() as { plan_day: string; distance_m: number | null }[];
  for (const run of longRuns) {
    const cutoff = isoAddDays(run.plan_day, -30);
    const prior = longRuns.filter((r) => r.plan_day < run.plan_day && r.plan_day >= cutoff);
    if (prior.length === 0) continue;
    const maxPrior = Math.max(...prior.map((r) => r.distance_m ?? 0));
    if ((run.distance_m ?? 0) > maxPrior * 1.1) out.push(`long run ${run.plan_day} breaks the 110 percent rule`);
  }
  return out;
}

function weekGuardsOk(): boolean {
  const rows = db.query(
    "SELECT week_no, plan_day, kind, duration_min FROM planned_workouts",
  ).all() as { week_no: number; plan_day: string; kind: string; duration_min: number }[];
  const byWeek = new Map<number, typeof rows>();
  for (const r of rows) {
    if (!byWeek.has(r.week_no)) byWeek.set(r.week_no, []);
    byWeek.get(r.week_no)!.push(r);
  }
  for (const [, ws] of byWeek) {
    const days = (k: string) => ws.filter((r) => r.kind === k).map((r) => nyDow(r.plan_day));
    const a = days("strength_a")[0], b = days("strength_b")[0];
    if (a !== undefined && b !== undefined && Math.abs(a - b) < 2 && Math.abs(a - b + 7) % 7 < 2) return false;
    if (ws.filter((r) => r.kind === "race").length !== 1) return false;
    if (ws.filter((r) => r.kind === "rest").length !== 1) return false;
    const weekendLong = ws.filter((r) => nyDow(r.plan_day) >= 5 && r.duration_min > 90);
    if (weekendLong.length > 1) return false;
    // SpreadGuard (SystemsThinking R2 "shrinking week"): swaps must not
    // collapse the week onto stacked days.
    const perDay = new Map<string, { count: number; endurance: number }>();
    for (const r of ws) {
      if (r.kind === "rest") continue;
      const e = perDay.get(r.plan_day) ?? { count: 0, endurance: 0 };
      e.count += 1;
      if ((r.kind === "long_ride" || r.kind === "long_run" || r.kind === "easy_run" || r.kind === "race" || r.kind === "spin") && r.duration_min >= 60) e.endurance += 1;
      perDay.set(r.plan_day, e);
    }
    for (const [, e] of perDay) {
      if (e.count > 2) return false;
      if (e.endurance > 1) return false;
    }
  }
  return true;
}

// --- R3: progression hold ---------------------------------------------------

export function elapsedWeekCompletion(now: Date): { week: number; pct: number }[] {
  const today = nyDateString(now);
  // Auto-done sessions count their MATCHED activity's real minutes (capped at
  // planned), not the planned minutes (Advisor: a week of 70-percent-floor
  // matches must read 70, or the hold is blind exactly when it matters).
  // Manual done, or a matched activity later deleted, falls back to planned:
  // auto-done is deliberately sticky across activity deletion.
  const rows = db.query(
    `SELECT p.week_no, MAX(p.plan_day) last_day,
            SUM(p.duration_min) planned,
            SUM(CASE WHEN p.status = 'done' THEN
                  CASE WHEN p.done_source = 'auto' AND a.id IS NOT NULL
                       THEN MIN(CAST(a.duration_s AS REAL) / 60.0, p.duration_min)
                       ELSE p.duration_min END
                ELSE 0 END) done
     FROM planned_workouts p
     LEFT JOIN activities a ON a.id = p.activity_id
     WHERE p.sport != 'rest' GROUP BY p.week_no ORDER BY p.week_no ASC`,
  ).all() as { week_no: number; last_day: string; planned: number; done: number }[];
  return rows
    .filter((r) => r.last_day < today)
    .map((r) => ({ week: r.week_no, pct: r.planned > 0 ? r.done / r.planned : 1 }));
}

export function progressionHold(now: Date): boolean {
  const elapsed = elapsedWeekCompletion(now).filter((w) => !CUTBACK_WEEKS.has(w.week));
  if (elapsed.length < 2) return false;
  const [w1, w2] = elapsed.slice(-2) as [{ week: number; pct: number }, { week: number; pct: number }];
  if (w1.pct >= HOLD_COMPLETION_THRESHOLD || w2.pct >= HOLD_COMPLETION_THRESHOLD) return false;

  // Cause-check (SystemsThinking R3): if his ACTUAL synced minutes reached 70
  // percent of the planned minutes, he trained plenty and the sessions just
  // didn't match the template. That is a fit problem for the day-affinity
  // rule, not a capacity problem, so no hold.
  const lastWeekNo = (w2 as { week: number }).week;
  const weekRows = db.query(
    "SELECT MIN(plan_day) a, MAX(plan_day) b, SUM(duration_min) m FROM planned_workouts WHERE week_no = ? AND sport != 'rest'",
  ).get(lastWeekNo) as { a: string; b: string; m: number };
  const actual = db.query(
    "SELECT COALESCE(SUM(duration_s), 0) s FROM activities WHERE date(start_time) >= ? AND date(start_time) <= ?",
  ).get(weekRows.a, weekRows.b) as { s: number };
  if (actual.s / 60 >= weekRows.m * CAUSE_CHECK_RATIO) return false;

  // HoldCeiling (SystemsThinking R3 "deload spiral"): two consecutive holds
  // maximum; the third becomes a visible request for a human decision.
  const recentHolds = db.query(
    "SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'progression_hold' AND created_at >= datetime('now', '-42 days')",
  ).get() as { n: number };
  if (recentHolds.n >= 2) {
    const already = db.query(
      "SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'hold_escalation' AND created_at >= datetime('now', '-14 days')",
    ).get() as { n: number };
    if (already.n === 0) {
      logAdaptation(
        "hold_escalation",
        "The plan has held twice and completion is still low",
        "Two holds in a row is where I stop deciding for you. Life might be asking for a smaller plan, or the schedule needs a rethink. Tell Ardee what changed and the plan gets rebuilt around it.",
        nyDateString(now),
      );
    }
    return false;
  }

  const from = nextMonday(now);
  const target = db.query(
    `SELECT DISTINCT week_no FROM planned_workouts WHERE plan_day >= ? ORDER BY week_no ASC`,
  ).all(from) as { week_no: number }[];
  const targetWeek = target.map((t) => t.week_no).find((w) => !CUTBACK_WEEKS.has(w));
  if (targetWeek === undefined || targetWeek <= 1) return false;
  const already = db.query(
    "SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'progression_hold' AND description LIKE ?",
  ).get(`%week ${targetWeek}%`) as { n: number };
  if (already.n > 0) return false;

  // A hold SHIFTS the whole remaining ramp back one step rather than denting
  // a single week: every future non-cutback week takes the ORIGINAL volumes
  // of the non-cutback week before it. Step sizes are preserved exactly, so
  // the RUNSAFE spike rule survives by construction (a one-week dent would
  // make the following designed step an over-10-percent jump).
  const nonCutback = (db.query(
    "SELECT DISTINCT week_no FROM planned_workouts ORDER BY week_no ASC",
  ).all() as { week_no: number }[])
    .map((r) => r.week_no)
    .filter((w) => !CUTBACK_WEEKS.has(w));
  type Vol = { id: number; duration_min: number; distance_m: number | null; title: string };
  const original = new Map<string, Vol>();
  for (const w of nonCutback) {
    for (const kind of ["long_run", "long_ride", "spin"]) {
      const row = db.query(
        "SELECT id, duration_min, distance_m, title FROM planned_workouts WHERE week_no = ? AND kind = ?",
      ).get(w, kind) as Vol | null;
      if (row) original.set(`${w}:${kind}`, row);
    }
  }
  let changed = false;
  for (const fw of nonCutback.filter((w) => w >= targetWeek)) {
    const sourceWeek = nonCutback.filter((w) => w < fw).pop();
    if (sourceWeek === undefined) continue;
    for (const kind of ["long_run", "long_ride", "spin"]) {
      const src = original.get(`${sourceWeek}:${kind}`);
      const cur = original.get(`${fw}:${kind}`);
      if (!src || !cur) continue;
      if (src.duration_min >= cur.duration_min) continue; // never raise, never churn equals
      let title = cur.title;
      if (kind === "long_run" && src.distance_m !== null) {
        title = title.replace(/[\d.]+ km/, `${(src.distance_m / 1000).toFixed(1)} km`);
      }
      if (kind === "long_ride") {
        const h = Math.floor(src.duration_min / 60), m = src.duration_min % 60;
        title = title.replace(/\d+:\d{2}/, `${h}:${String(m).padStart(2, "0")}`);
      }
      db.query(
        "UPDATE planned_workouts SET duration_min = ?, distance_m = ?, title = ?, adjusted = 1 WHERE id = ?",
      ).run(src.duration_min, src.distance_m, title, cur.id);
      changed = true;
    }
  }
  if (!changed) return false;
  const rails = railViolations();
  if (rails.length > 0) {
    logAdaptation("rail_abort", `hold on week ${targetWeek} aborted`, rails.join("; "), from);
    return false;
  }
  logAdaptation(
    "progression_hold",
    `Ramp shifted back one step from week ${targetWeek}`,
    `The last two full weeks landed at ${Math.round(w1.pct * 100)} and ${Math.round(w2.pct * 100)} percent, so from week ${targetWeek} every step repeats the one before it. Same ramp, one week later. Hit most of a week and it carries on from there.`,
    from,
  );
  return true;
}

// --- R1: day-affinity swap --------------------------------------------------

export function dayAffinitySwap(now: Date): boolean {
  const today = nyDateString(now);
  const kinds = ["long_run", "easy_run", "race", "long_ride", "strength_a", "strength_b", "spin"];
  for (const kind of kinds) {
    const cooldown = db.query(
      "SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'day_swap' AND description LIKE ? AND created_at >= datetime('now', ?)",
    ).get(`%${kind}%`, `-${SWAP_COOLDOWN_DAYS} days`) as { n: number };
    if (cooldown.n > 0) continue;

    const past = db.query(
      `SELECT plan_day, status FROM planned_workouts WHERE kind = ? AND plan_day < ? ORDER BY plan_day DESC LIMIT 4`,
    ).all(kind, today) as { plan_day: string; status: string }[];
    if (past.length < 3) continue;
    const doneCount = past.filter((p) => p.status === "done").length;
    if (doneCount / past.length > 0.5) continue;

    const plannedSport = kind.startsWith("strength") ? "strength" : (kind === "race" || kind === "long_ride" || kind === "spin") ? "bike" : "run";
    const sports = plannedSport === "bike" ? BIKE_SPORTS : plannedSport === "run" ? RUN_SPORTS : STRENGTH_SPORTS;
    const acts = db.query(
      `SELECT start_time FROM activities WHERE date(start_time) >= ? AND sport IN (${[...sports].map(() => "?").join(",")})`,
    ).all(isoAddDays(today, -28), ...sports) as { start_time: string }[];
    if (acts.length < 2) continue;
    const byDow = new Map<number, number>();
    for (const a of acts) {
      const dow = nyDow(nyDateString(new Date(a.start_time)));
      byDow.set(dow, (byDow.get(dow) ?? 0) + 1);
    }
    const plannedDow = nyDow((past[0] as { plan_day: string }).plan_day);
    const [bestDow, bestCount] = [...byDow.entries()].sort((x, y) => y[1] - x[1])[0] as [number, number];
    if (bestDow === plannedDow || bestCount / acts.length < 0.6) continue;

    const from = nextMonday(now);
    const future = db.query(
      "SELECT id, plan_day, week_no FROM planned_workouts WHERE kind = ? AND plan_day >= ?",
    ).all(kind, from) as { id: number; plan_day: string; week_no: number }[];
    if (future.length === 0) continue;

    // Snapshot originals BEFORE applying so the abort path is a mechanical
    // restore, never a recomputation.
    const moving: { id: number; originalDay: string; newDay: string; wasAdjusted: number }[] = [];
    const collect = (rows: { id: number; plan_day: string }[]) => {
      for (const r of rows) {
        const monday = isoAddDays(r.plan_day, -nyDow(r.plan_day));
        const adj = (db.query("SELECT adjusted FROM planned_workouts WHERE id = ?").get(r.id) as { adjusted: number }).adjusted;
        moving.push({ id: r.id, originalDay: r.plan_day, newDay: isoAddDays(monday, bestDow), wasAdjusted: adj });
      }
    };
    collect(future);
    if (kind === "long_ride") {
      collect(db.query(
        "SELECT id, plan_day FROM planned_workouts WHERE kind = 'brick' AND plan_day >= ?",
      ).all(from) as { id: number; plan_day: string }[]);
    }

    db.transaction(() => {
      for (const m of moving) {
        db.query("UPDATE planned_workouts SET plan_day = ?, adjusted = 1 WHERE id = ?").run(m.newDay, m.id);
      }
    })();

    if (!weekGuardsOk() || railViolations().length > 0) {
      db.transaction(() => {
        for (const m of moving) {
          db.query("UPDATE planned_workouts SET plan_day = ?, adjusted = ? WHERE id = ?").run(m.originalDay, m.wasAdjusted, m.id);
        }
      })();
      logAdaptation("rail_abort", `${kind} day swap aborted`, "Moving it would break a safety guard, so the plan stays put.", from);
      continue; // nothing changed; another kind may still have a safe move
    }

    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    logAdaptation(
      "day_swap",
      `${kind} moves to ${dayNames[bestDow]} from ${dayNames[plannedDow]}`,
      `You completed ${doneCount} of the last ${past.length} planned ${dayNames[plannedDow]} sessions, and ${bestCount} of your last ${acts.length} ${plannedSport} workouts happened on ${dayNames[bestDow]}. Future weeks follow your lead. Keep training on ${dayNames[plannedDow]} instead and the plan will learn back in a few weeks.`,
      from,
    );
    return true;
  }
  return false;
}

// --- orchestration ----------------------------------------------------------

let passRunning = false;

export function runAdaptPass(now: Date = new Date()): void {
  if (passRunning) return;
  passRunning = true;
  try {
    matchActivities(now);
    updateTimeHints(now);
    const held = progressionHold(now);
    if (!held) dayAffinitySwap(now);
  } catch (err) {
    console.error("plan adapt pass failed:", err);
  } finally {
    passRunning = false;
  }
}
