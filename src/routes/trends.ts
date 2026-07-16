// GET /api/trends?weeks=N (ISC-41) — weekly aggregates for the trends chart
// (last N weeks including the current one, oldest first, so the UI can draw
// bars left-to-right chronologically).

import { jsonError } from "../lib/http";
import { computeWeekSummary } from "../services/weekSummary";
import { startOfWeek } from "../week";

const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 52;

export function getTrends(url: URL): Response {
  const weeksParam = url.searchParams.get("weeks");
  let weeks = DEFAULT_WEEKS;
  if (weeksParam !== null) {
    const parsed = Number(weeksParam);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return jsonError("Invalid 'weeks'", 400);
    }
    weeks = Math.min(parsed, MAX_WEEKS);
  }

  const currentWeekStart = startOfWeek(new Date());
  const summaries = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const instant = new Date(currentWeekStart.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    summaries.push(computeWeekSummary(instant));
  }

  return Response.json({ weeks: summaries });
}
