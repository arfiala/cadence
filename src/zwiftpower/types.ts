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
  // Rider body weight in kg as recorded by Zwift for this ride (the profile
  // weight set at ride time, used for w/kg — a manually-entered value, not a
  // per-ride measurement). Powers the dashboard weight-progress widget.
  weightKg: number | null;
};

// One critical-power best effort for a duration (ISC-342), already mapped out
// of the wrapper's ZwiftPowerCriticalPowerProfile shape. Cycling-only by
// construction (the source is ZwiftPower).
export type ZwiftPowerCurvePoint = {
  durationSeconds: number; // one of POWER_CURVE_TARGETS
  watts: number;
  eventDate: string | null; // ISO-8601 UTC of the effort, when provided
  eventId: string | null; // ZwiftPower event id (zid) the effort came from
};

// The durations Cadence tracks on the power curve: 15s, 1m, 5m, 20m. Shared by
// the client (which extracts exactly these from the profile) and the read-side
// aggregation, so the set is defined once.
export const POWER_CURVE_TARGETS: { seconds: number; label: string }[] = [
  { seconds: 15, label: "15s" },
  { seconds: 60, label: "1m" },
  { seconds: 300, label: "5m" },
  { seconds: 1200, label: "20m" },
];

export interface ZwiftPowerClient {
  // Returns the rider's own recent race results (the community
  // /cache3/profile/{profileId}_all.json feed), newest first is not
  // guaranteed, the sync engine keys on eventId and does not depend on order.
  listRiderResults(): Promise<ZwiftPowerResult[]>;

  // Returns the rider's critical-power best efforts for the tracked durations
  // (ISC-342). OPTIONAL so a test fake or a future minimal client need not
  // implement it; the sync guards the call and treats its absence or failure as
  // "no new power-curve data" (ISC-344), degrading to whatever is already
  // stored. The real client fetches it from the SAME authenticated ZwiftPower
  // session as the results (no new session dance).
  getPowerCurve?(): Promise<ZwiftPowerCurvePoint[]>;
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
