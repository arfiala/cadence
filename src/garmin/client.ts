// The ONLY file in Cadence that imports garmin-connect-client (ISC-100).
// Everything else programs against the GarminClient interface in
// ./types.ts. A future library swap means rewriting this file only.
//
// Library choice (ISC-24, full reasoning in ISA Decisions): of the three
// candidates probed (garmin-connect, garmin-connect-client,
// @gooin/garmin-connect), only garmin-connect-client explicitly implements
// an MFA resume flow (`login()` returns `{mfaRequired: true}`, resumed with
// `login(pending, code)`) — the other two both list "Handle MFA" as an
// unchecked TODO in their own READMEs. garmin-connect-client also ships
// native TypeScript types and documented session persistence
// (`client.getSession()` / `fromSession()`), which is exactly ISC-29's
// requirement (MFA is not re-prompted on every 6h sync).

import { mkdirSync, chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  GarminConnectClient as RealGarminClient,
  PersistedSession,
} from "garmin-connect-client";
import type { GarminClient, GarminActivity } from "./types";
import { GarminSyncError } from "./types";

// garmin-connect-client is imported DYNAMICALLY (inside authenticate) rather
// than at module top level for two reasons: (1) it pulls a native binding
// (node-libcurl-ja3, curl-impersonate TLS fingerprinting) that is only needed
// when actually talking to Garmin — a lazy import keeps the server, the API,
// and every test able to load src/garmin/ without the native module present;
// (2) it reinforces ISC-100's isolation — the ONLY reference to the library
// anywhere in Cadence is this one dynamic import. The `import type` above is
// erased at compile time and adds no runtime load.
type GarminLib = typeof import("garmin-connect-client");
let libPromise: Promise<GarminLib> | null = null;
function loadLib(): Promise<GarminLib> {
  if (libPromise === null) {
    libPromise = import("garmin-connect-client");
  }
  return libPromise;
}

const TOKEN_PATH = process.env.GARMIN_TOKEN_PATH ?? "./garmin-tokens/session.json";

function loadPersistedSession(): PersistedSession | null {
  if (!existsSync(TOKEN_PATH)) return null;
  try {
    const raw = readFileSync(TOKEN_PATH, "utf-8");
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
}

function savePersistedSession(session: PersistedSession): void {
  const dir = dirname(TOKEN_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify(session), { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600); // belt-and-suspenders in case the file pre-existed
}

// Authenticate, preferring a persisted session (no network round trip, no
// MFA prompt) and falling back to a fresh username/password login. A fresh
// login that requires MFA cannot complete unattended in the 6h scheduler —
// GARMIN_MFA_CODE is read once for that first, human-triggered login (set
// transiently, then unset); every sync after that reuses the saved session
// (ISC-29).
async function authenticate(): Promise<RealGarminClient> {
  const { login, fromSession } = await loadLib();
  const persisted = loadPersistedSession();
  if (persisted !== null) {
    try {
      const client = fromSession(persisted);
      client.onSessionUpdate((updated) => savePersistedSession(updated));
      return client;
    } catch (err) {
      // Persisted session is stale/invalid — fall through to a fresh login
      // rather than failing the whole sync on a session file that just
      // needs replacing.
    }
  }

  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  if (email === undefined || password === undefined || email.length === 0 || password.length === 0) {
    throw new GarminSyncError(
      "GARMIN_EMAIL / GARMIN_PASSWORD not set and no saved session — cannot authenticate.",
    );
  }

  const result = await login({ username: email, password });
  let client: RealGarminClient;
  if (result.mfaRequired) {
    const mfaCode = process.env.GARMIN_MFA_CODE;
    if (mfaCode === undefined || mfaCode.length === 0) {
      throw new GarminSyncError(
        "Garmin requires an MFA code for this login and GARMIN_MFA_CODE is not set. " +
          "Set GARMIN_MFA_CODE to the code from your authenticator and re-run sync once to establish a session; " +
          "subsequent syncs will reuse the saved session file and won't prompt again.",
      );
    }
    client = await login(result, mfaCode);
  } else {
    client = result.client;
  }

  savePersistedSession(client.getSession());
  client.onSessionUpdate((updated) => savePersistedSession(updated));
  return client;
}

function toGarminActivity(raw: {
  activityId: number;
  activityName: string;
  activityType: { typeKey: string };
  duration: number;
  startTimeGMT: string;
  distance?: number;
  calories?: number;
  averageHR?: number;
}): GarminActivity {
  return {
    garminId: String(raw.activityId),
    typeKey: raw.activityType.typeKey,
    title: raw.activityName,
    // startTimeGMT is Garmin's local-format GMT string; normalize to a real
    // ISO-8601 UTC instant so the rest of Cadence never has to think about
    // Garmin's timestamp quirks (ISC-8).
    startTimeUtc: new Date(`${raw.startTimeGMT.replace(" ", "T")}Z`).toISOString(),
    durationSeconds: Math.round(raw.duration),
    distanceMeters: raw.distance ?? null,
    calories: raw.calories ?? null,
    avgHr: raw.averageHR ?? null,
  };
}

export function createRealGarminClient(): GarminClient {
  return {
    async listRecentActivities(limit = 50): Promise<GarminActivity[]> {
      try {
        const client = await authenticate();
        const activities = await client.getActivities(0, limit);
        return activities.map((a) =>
          toGarminActivity({
            activityId: a.activityId,
            activityName: a.activityName,
            activityType: { typeKey: a.activityType.typeKey },
            duration: a.duration,
            startTimeGMT: a.startTimeGMT,
            distance: a.distance,
            calories: a.calories,
            averageHR: a.averageHR,
          }),
        );
      } catch (err) {
        if (err instanceof GarminSyncError) throw err;
        throw new GarminSyncError(
          `Garmin Connect request failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
