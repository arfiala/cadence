// POST /api/sync (trigger) + GET /api/sync/status (ISC-43). The route layer
// wires the real Garmin client factory into the shared sync engine — tests
// exercise triggerSync()/runSyncOnce() directly with a mock GarminClient
// instead of going through these HTTP handlers.

import { createRealGarminClient } from "../garmin/client";
import { triggerSync, getRecentSyncRuns } from "../garmin/sync";

export async function postSync(): Promise<Response> {
  const result = await triggerSync(createRealGarminClient());
  if (!result.triggered) {
    return Response.json({ triggered: false, message: result.message }, { status: 202 });
  }
  return Response.json({ triggered: true, outcome: result.outcome });
}

export function getSyncStatus(): Response {
  return Response.json({ runs: getRecentSyncRuns() });
}
