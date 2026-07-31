// FTP auto-sync: mirror Zwift's FTP into Cadence whenever it changes.
// Recalibration, not adaptation: the plan's watt strings re-derive from the
// same templates the seed used (single source in data/trainingPlan.ts), only
// for FUTURE still-planned bike sessions. The change lands in the plan feed
// so it is never silent. Sanity guards keep a glitched profile read from
// rewriting anything.

import { db } from "../db";
import { nyDateString } from "../week";
import type { ZwiftPowerClient } from "../zwiftpower/types";
import { raceTarget, raceDetail, rideTarget, spinTarget } from "../data/trainingPlan";

const FTP_MIN = 50;
const FTP_MAX = 400;
const MAX_STEP_RATIO = 0.3; // a jump over 30 percent is a glitch, not fitness

function currentFtp(): number | null {
  const row = db.query("SELECT value FROM settings WHERE key = 'ftp_watts'").get() as { value: string } | null;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function logFeed(kind: string, description: string, reason: string): void {
  db.query(
    `INSERT OR IGNORE INTO plan_adaptations (kind, description, reason, effective_from)
     VALUES (?, ?, ?, ?)`,
  ).run(kind, description, reason, nyDateString(new Date()));
}

export async function syncFtpFromZwift(client: ZwiftPowerClient): Promise<boolean> {
  if (client.getZwiftFtp === undefined) return false;
  const zwiftFtp = await client.getZwiftFtp();
  if (zwiftFtp === null) return false;

  if (zwiftFtp < FTP_MIN || zwiftFtp > FTP_MAX) {
    logOnceAnomaly(`Zwift reported an FTP of ${zwiftFtp} W, outside sanity bounds; ignored.`);
    return false;
  }

  const old = currentFtp();
  if (old === zwiftFtp) return false;

  if (old !== null && Math.abs(zwiftFtp - old) / old > MAX_STEP_RATIO) {
    logOnceAnomaly(
      `Zwift reported ${zwiftFtp} W against a stored ${old} W, a jump over 30 percent; ignored as a glitch. If this is real, set it by hand in Trends.`,
    );
    return false;
  }

  db.query(
    "INSERT INTO settings (key, value) VALUES ('ftp_watts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(zwiftFtp));

  // Regenerate watt strings on future still-planned bike sessions from the
  // shared templates. Past rows and done/skipped rows keep their history.
  const today = nyDateString(new Date());
  const apply = db.transaction(() => {
    db.query(
      "UPDATE planned_workouts SET target = ?, detail = ? WHERE kind = 'race' AND status = 'planned' AND plan_day >= ?",
    ).run(raceTarget(zwiftFtp), raceDetail(zwiftFtp), today);
    db.query(
      "UPDATE planned_workouts SET target = ? WHERE kind = 'long_ride' AND status = 'planned' AND plan_day >= ?",
    ).run(rideTarget(zwiftFtp), today);
    db.query(
      "UPDATE planned_workouts SET target = ? WHERE kind = 'spin' AND status = 'planned' AND plan_day >= ?",
    ).run(spinTarget(zwiftFtp), today);
  });
  apply();

  logFeed(
    "ftp_update",
    `FTP ${old ?? "unset"} to ${zwiftFtp} W from Zwift`,
    `Zwift now rates your FTP at ${zwiftFtp} W${old !== null ? ` (was ${old})` : ""}. Power zones and every upcoming watt target were recalculated to match.`,
  );
  return true;
}

function logOnceAnomaly(reason: string): void {
  const dup = db.query(
    "SELECT COUNT(*) n FROM plan_adaptations WHERE kind = 'ftp_anomaly' AND reason = ? AND created_at >= datetime('now', '-7 days')",
  ).get(reason) as { n: number };
  if (dup.n > 0) return;
  logFeed("ftp_anomaly", "Ignored a suspicious Zwift FTP reading", reason);
}
