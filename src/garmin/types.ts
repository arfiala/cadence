// The thin interface every Garmin-touching module in Cadence programs
// against. src/garmin/client.ts is the ONLY file that imports the actual
// garmin-connect-client library (ISC-100) — everything else, including
// src/garmin/sync.ts and every test, depends only on this interface, so a
// future library swap changes one file.

export type GarminActivity = {
  garminId: string;
  typeKey: string; // Garmin's raw activityType.typeKey, e.g. "virtual_ride"
  title: string | null;
  startTimeUtc: string; // ISO-8601 UTC
  durationSeconds: number;
  distanceMeters: number | null;
  calories: number | null;
  avgHr: number | null;
  // Power metrics (ISC-135), null unless the Garmin summary carried them
  // (power meter or smart trainer). Feed the native training-load engine.
  avgPower: number | null;
  normPower: number | null;
};

export interface GarminClient {
  // Returns recent activities, newest first, paged internally by the
  // implementation up to `limit`.
  listRecentActivities(limit?: number): Promise<GarminActivity[]>;
}

// Thrown by a GarminClient implementation on any failure (bad creds,
// network, rate limit, MFA required but not available non-interactively).
// sync.ts catches this specifically to record a clean errored sync_run
// (ISC-28) rather than letting a raw library exception surface.
export class GarminSyncError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GarminSyncError";
  }
}
