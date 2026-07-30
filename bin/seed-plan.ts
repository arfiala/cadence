// Seed the training plan into planned_workouts. Idempotent by refusal: a
// populated table blocks a re-run unless --force, which wipes the table and
// seeds exactly one block. Plan content is deterministic (src/data/trainingPlan.ts,
// fixed PLAN_START, no clock reads), so any two seeds produce identical rows.
//
// Usage: DB_PATH=/path/to/cadence.db bun bin/seed-plan.ts [--force]

import { db } from "../src/db";
import { buildPlan, PLAN_PHASE, PLAN_START } from "../src/data/trainingPlan";

const force = process.argv.includes("--force");
const existing = (db.query("SELECT COUNT(*) AS n FROM planned_workouts").get() as { n: number }).n;

if (existing > 0 && !force) {
  console.error(
    `planned_workouts already holds ${existing} rows. Re-run with --force to wipe and reseed.`,
  );
  process.exit(1);
}

if (force) {
  db.query("DELETE FROM planned_workouts").run();
}

const rows = buildPlan();
const insert = db.query(
  `INSERT INTO planned_workouts
   (plan_day, sport, title, detail, duration_min, distance_m, target, tss_planned, week_no, phase, sort, kind)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const seedAll = db.transaction((all: ReturnType<typeof buildPlan>) => {
  for (const s of all) {
    insert.run(
      s.planDay, s.sport, s.title, s.detail, s.durationMin,
      s.distanceM, s.target, s.tssPlanned, s.weekNo, s.phase, s.sort, s.kind,
    );
  }
});
seedAll(rows);

console.log(`Seeded ${rows.length} planned sessions (${PLAN_PHASE}, starting ${PLAN_START}).`);
