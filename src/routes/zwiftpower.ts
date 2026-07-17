// /api/zwiftpower/*, trigger a ZwiftPower results sync, list stored results,
// and report sync status (ISC-125, ISC-126). All routes sit under /api/ so
// they are already auth-gated by the server (ISC-125: 401 unauthenticated).
// When ZwiftPower is not configured the endpoints stay quiet and truthful:
// the panel says "not configured" (ISC-131) and a sync trigger returns a clean
// message instead of erroring.

import { createRealZwiftPowerClient } from "../zwiftpower/client";
import { isZwiftPowerConfigured } from "../zwiftpower/config";
import { triggerZpSync, listResults, getRecentZpRuns } from "../zwiftpower/sync";
import type { ZwiftPowerResultRow } from "../db";

function serializeResult(row: ZwiftPowerResultRow) {
  return {
    id: row.id,
    event_id: row.event_id,
    event_date: row.event_date,
    title: row.title,
    category: row.category,
    position: row.position,
    avg_power: row.avg_power,
    norm_power: row.norm_power,
    time_s: row.time_s,
  };
}

export async function postZwiftPowerSync(): Promise<Response> {
  if (!isZwiftPowerConfigured()) {
    return Response.json(
      { triggered: false, configured: false, message: "ZwiftPower is not configured." },
      { status: 200 },
    );
  }
  const result = await triggerZpSync(createRealZwiftPowerClient());
  if (!result.triggered) {
    return Response.json({ triggered: false, configured: true, message: result.message }, { status: 202 });
  }
  return Response.json({ triggered: true, configured: true, outcome: result.outcome });
}

export function getZwiftPowerResults(): Response {
  return Response.json({
    configured: isZwiftPowerConfigured(),
    results: listResults().map(serializeResult),
  });
}

export function getZwiftPowerStatus(): Response {
  return Response.json({
    configured: isZwiftPowerConfigured(),
    runs: getRecentZpRuns(),
  });
}
