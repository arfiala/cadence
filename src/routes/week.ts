// GET /api/week?date= (ISC-40). `date` (optional) is any parseable
// timestamp identifying which week to summarize; defaults to now.

import { jsonError } from "../lib/http";
import { computeWeekSummary } from "../services/weekSummary";

export function getWeek(url: URL): Response {
  const dateParam = url.searchParams.get("date");
  let instant = new Date();
  if (dateParam !== null) {
    const parsed = new Date(dateParam);
    if (Number.isNaN(parsed.getTime())) {
      return jsonError("Invalid 'date'", 400);
    }
    instant = parsed;
  }

  return Response.json(computeWeekSummary(instant));
}
