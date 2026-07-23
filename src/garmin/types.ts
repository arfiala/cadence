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

// One night of Garmin sleep, normalized to what Cadence stores. Every field
// except calendarDate is nullable because Garmin returns partial nights
// (a nap, a watch taken off mid-night, an older device without stage
// tracking). calendarDate is the night's local calendar day (YYYY-MM-DD) and
// is the natural key — one row per night, upserted on re-sync. Durations are
// seconds; score is Garmin's 0-100 overall sleep score when the device/plan
// provides it, else null. start/endTimeUtc are ISO-8601 UTC instants.
export type GarminSleep = {
  calendarDate: string; // YYYY-MM-DD, the night's local calendar day (natural key)
  startTimeUtc: string | null;
  endTimeUtc: string | null;
  totalSleepSeconds: number | null;
  deepSeconds: number | null;
  lightSeconds: number | null;
  remSeconds: number | null;
  awakeSeconds: number | null;
  score: number | null; // Garmin overall sleep score (0-100) when present
};

export interface GarminClient {
  // Returns recent activities, newest first, paged internally by the
  // implementation up to `limit`.
  listRecentActivities(limit?: number): Promise<GarminActivity[]>;

  // Returns recent nightly sleep, one entry per night, over the last `days`.
  // OPTIONAL on the interface so a client (or a test fake) that only cares
  // about activities need not implement it — sync.ts guards the call and
  // skips the sleep pull when it is absent. The real garmin-connect-sdk
  // client always implements it (via garmin.sleep.getSleepRange).
  listRecentSleep?(days?: number): Promise<GarminSleep[]>;

  // Per-activity detail, fetched lazily and one activity at a time (ISC-319),
  // NEVER in bulk during sync (ISC-320). Both return `unknown`: the Garmin
  // splits/details payloads are undeclared and vary by sport/firmware, so every
  // consumer parses them defensively at the boundary (ISC-321) and degrades to
  // null. OPTIONAL so existing fakes that only implement activities/sleep keep
  // working (same precedent as listRecentSleep). The real garmin-connect-sdk
  // client implements them via garmin.activities.getSplits/getDetails, using a
  // SESSION-RESTORE-ONLY authentication that never performs a fresh login
  // (ISC-330).
  getSplits?(garminId: string): Promise<unknown>;
  getDetails?(garminId: string): Promise<unknown>;

  // Garmin Golf scorecard summaries (ISC-421..427). OPTIONAL, same fake-safe
  // precedent as sleep/detail. The endpoint is outside the SDK; the real
  // client rides the SDK's own captured session headers. Returns `unknown`:
  // parsed defensively at the sync boundary.
  listGolfScorecards?(): Promise<unknown>;
}

// Normalized Garmin Golf scorecard, parsed defensively from the live shape
// (probed 2026-07-23: id, courseName, startTime, strokes, scoreWithoutHandicap,
// holesCompleted, roundType among 16 keys).
export type GolfScorecard = {
  scorecardId: string;
  courseName: string | null;
  startTime: string | null; // as Garmin sent it
  strokes: number | null;
  holesPlayed: number | null;
  roundType: string | null;
};

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
