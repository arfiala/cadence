// The thin interface every ZwiftPower-touching module in Cadence programs
// against, the same swap-friendly pattern as src/garmin/types.ts. Only
// src/zwiftpower/client.ts imports the @codingwithspike/zwift-api-wrapper
// library (ISC-118); everything else, including sync.ts and every test,
// depends only on this interface, so a library swap changes one file and no
// test ever performs a live login (ISC-129).

// One normalized ZwiftPower result for the rider, already mapped out of the
// wrapper's raw DataTables-style tuples into flat scalar fields.
export type ZwiftPowerResult = {
  eventId: string; // ZwiftPower event/result id (zid), the idempotency key
  eventDate: string | null; // ISO-8601 UTC
  title: string | null;
  category: string | null; // A/B/C/D/E when ZwiftPower provides it, else null
  position: number | null; // overall finishing position
  avgPower: number | null; // watts
  normPower: number | null; // watts
  timeSeconds: number | null; // race time in seconds
};

export interface ZwiftPowerClient {
  // Returns the rider's own recent race results (the community
  // /cache3/profile/{profileId}_all.json feed), newest first is not
  // guaranteed, the sync engine keys on eventId and does not depend on order.
  listRiderResults(): Promise<ZwiftPowerResult[]>;
}

// Thrown by a ZwiftPowerClient implementation on any failure (auth rejected,
// rate limit, missing profile, network). sync.ts catches this to record a
// clean errored sync run (ISC-124) rather than letting a raw library
// exception surface or crash the server. Its message never contains the
// Zwift credentials (ISC-120).
export class ZwiftPowerSyncError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ZwiftPowerSyncError";
  }
}
