// The ONLY file in Cadence that imports garmin-connect-sdk (ISC-100).
// Everything else programs against the GarminClient interface in
// ./types.ts. A future library swap means rewriting this file only —
// which is exactly what happened once already:
//
// Library history (ISC-24, full reasoning in ISA Decisions):
// - v1 chose garmin-connect-client for its MFA resume flow, but its native
//   dependency (node-libcurl-ja3) binds raw V8 C++ APIs that Bun does not
//   implement — the module can never load under Bun (proven in prod:
//   "undefined symbol: _ZN2v86Object17DefineOwnProperty…", 2026-07-16).
// - v2 (this file) uses garmin-connect-sdk (pinned 1.0.0-alpha.4): pure
//   TypeScript, zero native modules, single dep (zod), first-class MFA
//   (GarminMfaRequiredError / login({ mfaCode })), and FileTokenStorage with
//   restoreSession() + token refresh, which is exactly ISC-29's requirement
//   (MFA is not re-prompted on every 6h sync). Alpha-versioned — the pin is
//   exact, and this adapter is the only blast radius if its API shifts.

import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  GarminConnectSDK,
  FileTokenStorage,
  GarminMfaRequiredError,
  GarminAuthError,
  GarminBotChallengeError,
  GarminRateLimitError,
} from "garmin-connect-sdk";
import type { GarminClient, GarminActivity, GarminSleep } from "./types";
import { GarminSyncError } from "./types";

// GARMIN_TOKEN_PATH historically pointed at a session.json FILE; the SDK's
// FileTokenStorage manages a DIRECTORY of token files. Accept both shapes:
// a *.json value means "use its parent directory".
function tokenDir(): string {
  const configured = process.env.GARMIN_TOKEN_PATH ?? "./garmin-tokens";
  return configured.endsWith(".json") ? dirname(configured) : configured;
}

async function authenticate(): Promise<GarminConnectSDK> {
  const dir = tokenDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  const garmin = new GarminConnectSDK({ storage: new FileTokenStorage(dir) });

  // Preferred path: a previously persisted session, refreshed by the SDK.
  // No password, no MFA, no fresh login (ISC-29).
  try {
    const restored = await garmin.restoreSession();
    if (restored) return garmin;
  } catch {
    // Stale/corrupt tokens — fall through to a fresh login rather than
    // failing the sync on a token file that just needs replacing.
  }

  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (email === undefined || password === undefined || email.length === 0 || password.length === 0) {
    throw new GarminSyncError(
      "GARMIN_EMAIL / GARMIN_PASSWORD not set and no saved session — cannot authenticate.",
    );
  }

  const mfaCode = process.env.GARMIN_MFA_CODE;
  try {
    await garmin.login({
      email,
      password,
      ...(mfaCode !== undefined && mfaCode.length > 0 ? { mfaCode } : {}),
    });
  } catch (err) {
    if (err instanceof GarminMfaRequiredError) {
      throw new GarminSyncError(
        "Garmin requires an MFA code for this login and GARMIN_MFA_CODE is not set. " +
          "Garmin has just sent a code to your registered email/phone. Set GARMIN_MFA_CODE " +
          "to that code, restart cadence, and run sync once to establish a session; then " +
          "unset it — subsequent syncs reuse the saved tokens and never prompt again.",
        { cause: err },
      );
    }
    if (err instanceof GarminBotChallengeError) {
      throw new GarminSyncError(
        "Garmin presented a bot challenge to this login. Wait a while and retry; if it persists, " +
          "log in once from a browser on this network, then retry the sync.",
        { cause: err },
      );
    }
    if (err instanceof GarminRateLimitError) {
      throw new GarminSyncError("Garmin rate-limited the login. The next scheduled sync will retry.", {
        cause: err,
      });
    }
    if (err instanceof GarminAuthError) {
      throw new GarminSyncError(
        "Garmin rejected the credentials (GARMIN_EMAIL / GARMIN_PASSWORD). Check them in /opt/cadence/.env.",
        { cause: err },
      );
    }
    throw err;
  }

  return garmin;
}

// The SDK validates summaries with zod .passthrough(), so raw Garmin fields
// like startTimeGMT survive parsing even though they are not in the SDK's
// declared type. startTimeGMT ("YYYY-MM-DD HH:MM:SS" in UTC) is preferred for
// ISC-8 normalization; startTimeLocal is the fallback, interpreted as
// America/New_York — a deliberate single-user simplification (Austin's Garmin
// account timezone) recorded in the ISA Decisions.
function toGarminActivity(raw: Record<string, unknown>): GarminActivity {
  const activityType = raw.activityType as { typeKey?: string } | undefined;
  const gmt = typeof raw.startTimeGMT === "string" ? raw.startTimeGMT : null;
  const local = typeof raw.startTimeLocal === "string" ? raw.startTimeLocal : null;
  let startTimeUtc: string;
  if (gmt !== null) {
    startTimeUtc = new Date(`${gmt.replace(" ", "T")}Z`).toISOString();
  } else if (local !== null) {
    // Interpret account-local time as America/New_York (see comment above).
    startTimeUtc = new Date(`${local.replace(" ", "T")}-04:00`).toISOString();
  } else {
    startTimeUtc = new Date(0).toISOString();
  }

  return {
    garminId: String(raw.activityId),
    typeKey: activityType?.typeKey ?? "other",
    title: typeof raw.activityName === "string" ? raw.activityName : "Garmin activity",
    startTimeUtc,
    durationSeconds: typeof raw.duration === "number" ? Math.round(raw.duration) : 0,
    distanceMeters: typeof raw.distance === "number" ? raw.distance : null,
    calories: typeof raw.calories === "number" ? raw.calories : null,
    avgHr: typeof raw.averageHR === "number" ? raw.averageHR : null,
    // Garmin's activity summary carries power under a few names depending on
    // sport/firmware; the SDK's zod .passthrough() keeps them. We read the
    // common ones defensively and leave null when none are present. (See ISA
    // Decisions: the exact field names cannot be confirmed without a live
    // power-meter activity, so this maps the documented Garmin Connect summary
    // keys and degrades to null otherwise.)
    avgPower: firstNumber(raw.avgPower, raw.averagePower),
    normPower: firstNumber(raw.normPower, raw.normalizedPower, raw.normPowerBike),
  };
}

// Returns the first argument that is a finite positive number, else null.
function firstNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.round(v);
  }
  return null;
}

// Returns the first argument that is a finite number >= 0, else null. Used
// for sleep-stage seconds, where 0 (e.g. zero awake time) is a legitimate
// value that firstNumber() would wrongly reject.
function firstNonNegative(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  }
  return null;
}

// Garmin sleep timestamps arrive in several shapes across firmware/endpoints:
// an epoch-milliseconds number, that same number as a string, or a
// "YYYY-MM-DD HH:MM:SS" wall-clock string. Normalize any of them to an ISO
// UTC instant; return null on anything unparseable rather than an Invalid
// Date. (The exact field names/units cannot be pinned without a live sleep
// sync — see ISA Decisions — so this reads defensively and degrades to null.)
function parseGarminInstant(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    if (/^\d+$/.test(value)) return new Date(Number(value)).toISOString();
    const iso = value.includes("T") ? value : value.replace(" ", "T");
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

// Maps one raw Garmin sleep record (as returned by sleep.getSleepRange) to a
// normalized GarminSleep, or null when the record carries no usable night
// (no dailySleepDTO / no calendarDate). The SDK validates with zod
// .passthrough(), so undeclared fields like the GMT timestamps and the sleep
// score survive parsing and are read here defensively.
function toGarminSleep(raw: Record<string, unknown>): GarminSleep | null {
  const dto = raw.dailySleepDTO as Record<string, unknown> | undefined;
  if (dto === undefined) return null;
  const calendarDate = typeof dto.calendarDate === "string" ? dto.calendarDate : null;
  if (calendarDate === null || calendarDate.length === 0) return null;

  // Prefer the GMT timestamp (unambiguous) over the local one.
  const startTimeUtc = parseGarminInstant(dto.sleepStartTimestampGMT ?? dto.sleepStartTimestampLocal);
  const endTimeUtc = parseGarminInstant(dto.sleepEndTimestampGMT ?? dto.sleepEndTimestampLocal);

  // Sleep score lives at dailySleepDTO.sleepScores.overall.value on modern
  // devices, or a flat overallSleepScore on older payloads. Read both.
  const scores = dto.sleepScores as { overall?: { value?: unknown } } | undefined;
  const score = firstNonNegative(scores?.overall?.value, dto.overallSleepScore);

  return {
    calendarDate,
    startTimeUtc,
    endTimeUtc,
    totalSleepSeconds: firstNonNegative(dto.sleepTimeSeconds),
    deepSeconds: firstNonNegative(dto.deepSleepSeconds),
    lightSeconds: firstNonNegative(dto.lightSleepSeconds),
    remSeconds: firstNonNegative(dto.remSleepSeconds),
    awakeSeconds: firstNonNegative(dto.awakeSleepSeconds),
    score,
  };
}

export function createRealGarminClient(): GarminClient {
  return {
    async listRecentActivities(limit = 50): Promise<GarminActivity[]> {
      try {
        const garmin = await authenticate();
        const activities = await garmin.activities.list({ limit });
        return (activities as unknown as Record<string, unknown>[]).map(toGarminActivity);
      } catch (err) {
        if (err instanceof GarminSyncError) throw err;
        throw new GarminSyncError(
          `Garmin Connect request failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },

    async listRecentSleep(days = 14): Promise<GarminSleep[]> {
      try {
        const garmin = await authenticate();
        const end = new Date();
        const start = new Date(end.getTime() - Math.max(1, days - 1) * 24 * 60 * 60 * 1000);
        const range = await garmin.sleep.getSleepRange(start, end);
        const raw = range as unknown as Record<string, unknown>[];
        const nights = raw.map(toGarminSleep).filter((s): s is GarminSleep => s !== null);

        // DEFERRED-VERIFY trigger (ISC-252): the exact Garmin field names/units
        // are unconfirmed until a live prod sleep sync. If Garmin returned
        // records but NONE mapped to a usable night — or every mapped night is
        // entirely null — a wrong field-name assumption would look identical to
        // "the user didn't wear the watch". Log the raw key set once (keys only,
        // never values) so the first real sync surfaces a shape mismatch loudly
        // instead of a silently-empty Sleep tab.
        const allEmpty =
          nights.length === 0 ||
          nights.every(
            (n) =>
              n.totalSleepSeconds === null &&
              n.deepSeconds === null &&
              n.lightSeconds === null &&
              n.remSeconds === null,
          );
        if (raw.length > 0 && allEmpty) {
          const first = raw[0] ?? {};
          const dto = (first.dailySleepDTO ?? {}) as Record<string, unknown>;
          console.warn(
            `[cadence] Garmin sleep returned ${raw.length} record(s) but no usable sleep data was parsed. ` +
              `This likely means the sleep field mapping needs updating for the live payload shape. ` +
              `Top-level keys: [${Object.keys(first).join(", ")}]; dailySleepDTO keys: [${Object.keys(dto).join(", ")}]`,
          );
        }

        return nights;
      } catch (err) {
        if (err instanceof GarminSyncError) throw err;
        throw new GarminSyncError(
          `Garmin Connect sleep request failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
