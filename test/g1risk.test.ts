// G1 risk + pacing tests (ISC-334..338). Deterministic via a fixed clock. The
// week under test contains Wednesday 2026-07-15; its Monday is 2026-07-13.
// Verdict thresholds (met / on_track / at_risk) are each exercised, plus the
// pacing insufficient-history gate and the anti-import guard (ISC-336).

import { test, expect, describe, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeG1Risk, computePacing } from "../src/metrics/g1risk";
import { addWeeks, startOfWeek, nyDateString } from "../src/week";
import { resetDb, insertActivity } from "./helpers";

const NOW = new Date("2026-07-15T12:00:00Z"); // Wednesday
const WEEK_START = startOfWeek(NOW);

beforeEach(() => resetDb());

// Seed a G1 activity on a given completed-week offset (0 = current week) and
// weekday index (0=Mon..6=Sun) at a safe mid-morning NY hour.
function seedOnWeekday(weekOffset: number, weekdayIdx: number, sport: string, minutes: number): void {
  const ws = addWeeks(WEEK_START, weekOffset);
  const dayNy = nyDateString(new Date(ws.getTime() + weekdayIdx * 24 * 3600 * 1000 + 12 * 3600 * 1000));
  insertActivity({ sport, start_time: `${dayNy}T14:00:00Z`, duration_s: minutes * 60 });
}

describe("verdict states (ISC-335)", () => {
  test("met: this week's targets are already hit", () => {
    // 5 G1 sessions, 10 hours, all in the current week (Mon/Tue/Wed).
    seedOnWeekday(0, 0, "cycling", 120);
    seedOnWeekday(0, 0, "swimming", 120);
    seedOnWeekday(0, 1, "cycling", 120);
    seedOnWeekday(0, 1, "swimming", 120);
    seedOnWeekday(0, 2, "cycling", 120);
    const risk = computeG1Risk(NOW);
    expect(risk.sessions).toBe(5);
    expect(risk.hours).toBe(10);
    expect(risk.verdict).toBe("met");
    expect(risk.daysLeft).toBe(4); // Thu..Sun after Wednesday
  });

  test("on_track: projection from the trailing rhythm reaches both targets", () => {
    // Current week (to date): 2 sessions, 3h.
    seedOnWeekday(0, 0, "cycling", 90); // Mon 1.5h
    seedOnWeekday(0, 1, "swimming", 90); // Tue 1.5h
    // Trailing 4 weeks: a steady Thu/Fri/Sat/Sun rhythm so remaining-day
    // projection adds 4 sessions and 5h → projected 6 sessions, 8h.
    for (let w = 1; w <= 4; w++) {
      seedOnWeekday(-w, 3, "cycling", 60); // Thu 1h
      seedOnWeekday(-w, 4, "swimming", 60); // Fri 1h
      seedOnWeekday(-w, 5, "cycling", 120); // Sat 2h
      seedOnWeekday(-w, 6, "cycling", 60); // Sun 1h
    }
    const risk = computeG1Risk(NOW);
    expect(risk.sessions).toBe(2);
    expect(risk.projectedSessions).toBeGreaterThanOrEqual(5);
    expect(risk.projectedHours).toBeGreaterThanOrEqual(8);
    expect(risk.verdict).toBe("on_track");
  });

  test("at_risk: nothing logged and no trailing rhythm to project from", () => {
    const risk = computeG1Risk(NOW);
    expect(risk.sessions).toBe(0);
    expect(risk.sessionsNeeded).toBe(5);
    expect(risk.hoursNeeded).toBe(8);
    expect(risk.verdict).toBe("at_risk");
  });
});

describe("pacing (ISC-337, ISC-338)", () => {
  test("insufficient_history with under two weeks of data", () => {
    // Only one completed week has any data.
    seedOnWeekday(-1, 2, "cycling", 60);
    const pacing = computePacing(NOW);
    expect(pacing).toEqual({ insufficient_history: true });
  });

  test("returns a per-weekday rhythm once enough history exists", () => {
    for (let w = 1; w <= 3; w++) {
      seedOnWeekday(-w, 1, "cycling", 60); // Tue every week
      seedOnWeekday(-w, 5, "swimming", 90); // Sat every week
    }
    const pacing = computePacing(NOW);
    expect(pacing.insufficient_history).toBe(false);
    if (!pacing.insufficient_history) {
      expect(pacing.weeks_of_history).toBe(3);
      expect(pacing.weekdays.length).toBe(7);
      const tue = pacing.weekdays.find((d) => d.weekday === 1)!;
      expect(tue.avg_sessions).toBe(1);
      expect(tue.avg_hours).toBe(1);
      const sat = pacing.weekdays.find((d) => d.weekday === 5)!;
      expect(sat.avg_hours).toBe(1.5);
    }
  });
});

describe("anti: g1-risk reads sessions/hours only (ISC-336)", () => {
  test("g1risk.ts imports neither the load series nor the training-load engine", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "metrics", "g1risk.ts"), "utf8");
    // Check the actual import statements (module specifiers), not prose in the
    // header comment which legitimately names the modules it avoids.
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l) || /from\s+["']/.test(l));
    const imports = importLines.join("\n");
    expect(imports).not.toContain("./series");
    expect(imports).not.toContain("./trainingLoad");
  });
});
