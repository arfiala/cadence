// The ONLY file in Cadence that imports @codingwithspike/zwift-api-wrapper
// (ISC-118). Everything else programs against the ZwiftPowerClient interface
// in ./types.ts, so a future library swap rewrites this file alone, the same
// blast-radius discipline that made the Garmin library swap a one-file change.
//
// Auth model (probed from the wrapper's compiled surface this build):
//   - ZwiftPowerAPI(username, password) then authenticate(cookies?) drives the
//     Zwift SSO login and returns a serialized tough-cookie jar (a JSON
//     string). Passing a previously serialized jar back into authenticate()
//     reuses the session when it is still valid, skipping a fresh login.
//   - getActivityResults(profileId) fetches the rider's own results feed
//     (https://zwiftpower.com/cache3/profile/{profileId}_all.json), which is
//     exactly the "rider's own results" community endpoint called out in the
//     spec, wrapped and JSON-parsed by the library.
//
// Secrets: Zwift credentials are read from env via getZwiftPowerConfig and are
// never logged (ISC-120). The session jar is persisted to a mode-600 file so
// re-auth is not required every sync (ISC-130).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ZwiftAPI, ZwiftPowerAPI } from "@codingwithspike/zwift-api-wrapper";
import type { ZwiftPowerClient, ZwiftPowerResult, ZwiftPowerCurvePoint } from "./types";
import { ZwiftPowerSyncError, POWER_CURVE_TARGETS } from "./types";
import { getZwiftPowerConfig, zwiftCookieDir, zwiftCookiePath } from "./config";

// The wrapper's raw result rows are DataTables-style: most numeric fields are
// [value, sortKey] tuples. We only need the first (display) element. This
// shape is intentionally loose, we read defensively and null anything absent.
type RawResult = Record<string, unknown>;

function tupleNumber(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === "number") {
    return Number.isFinite(value[0]) && value[0] > 0 ? value[0] : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
}

// Some tuple fields carry their display value as a STRING first element (e.g.
// weight arrives as ["84.5", 0]). Parse a float from a string-or-number tuple,
// or a bare string/number, and null anything non-positive or unparseable.
function tupleFloat(value: unknown): number | null {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first === "string") {
    const n = Number.parseFloat(first);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof first === "number") {
    return Number.isFinite(first) && first > 0 ? first : null;
  }
  return null;
}

function unixToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
}

// Exported for unit testing of the raw->result mapping (including the weight
// string-tuple parse). Tests import this pure function; they never construct
// the real client or perform a login (ISC-129).
export function toResult(raw: RawResult): ZwiftPowerResult {
  return {
    eventId: String(raw.zid ?? raw.DT_RowId ?? ""),
    eventDate: unixToIso(raw.event_date),
    title: typeof raw.event_title === "string" && raw.event_title.length > 0 ? raw.event_title : null,
    category: normalizeCategory(raw.category),
    position: typeof raw.pos === "number" && Number.isFinite(raw.pos) ? raw.pos : null,
    avgPower: tupleNumber(raw.avg_power),
    normPower: tupleNumber(raw.np),
    timeSeconds: tupleNumber(raw.time),
    weightKg: tupleFloat(raw.weight),
  };
}

// Parse the wrapper's ZwiftPowerCriticalPowerProfile into best-effort points
// for the tracked durations (ISC-342). The profile shape (probed this build) is
// `{ efforts: Record<string, Array<{ x: number; y: number; date: number; zid:
// string }>> }`, where each point's x is the effort duration in seconds and y
// the best watts, date a unix-seconds timestamp, zid the source event. We read
// the "watts" series (falling back to the first series present) and pick the
// point whose x exactly matches each target duration. Defensive throughout:
// anything missing or oddly-typed is skipped, never thrown.
export function toPowerCurve(profile: unknown): ZwiftPowerCurvePoint[] {
  const rec =
    typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>) : null;
  const effortsRec =
    rec !== null && typeof rec.efforts === "object" && rec.efforts !== null
      ? (rec.efforts as Record<string, unknown>)
      : null;
  if (effortsRec === null) return [];

  const series =
    (Array.isArray(effortsRec.watts) ? (effortsRec.watts as unknown[]) : null) ??
    (Object.values(effortsRec).find((v) => Array.isArray(v)) as unknown[] | undefined) ??
    [];

  const out: ZwiftPowerCurvePoint[] = [];
  for (const target of POWER_CURVE_TARGETS) {
    let best: ZwiftPowerCurvePoint | null = null;
    for (const raw of series) {
      const p =
        typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
      if (p === null) continue;
      const x = typeof p.x === "number" ? p.x : null;
      const y = typeof p.y === "number" && Number.isFinite(p.y) && p.y > 0 ? p.y : null;
      if (x !== target.seconds || y === null) continue;
      const eventDate = typeof p.date === "number" && p.date > 0 ? new Date(p.date * 1000).toISOString() : null;
      const eventId = typeof p.zid === "string" && p.zid.length > 0 ? p.zid : null;
      if (best === null || y > best.watts) {
        best = { durationSeconds: target.seconds, watts: Math.round(y), eventDate, eventId };
      }
    }
    if (best !== null) out.push(best);
  }
  return out;
}

// Load a previously persisted cookie jar (serialized JSON string), if any.
function loadCookies(): string | undefined {
  const path = zwiftCookiePath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

// Persist the session jar to a mode-600 file (ISC-130) so the next sync reuses
// it instead of logging in again.
function saveCookies(serialized: string): void {
  const dir = zwiftCookieDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = zwiftCookiePath();
  writeFileSync(path, serialized, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort tightening; writeFileSync's mode already applied on create.
  }
}

export function createRealZwiftPowerClient(): ZwiftPowerClient {
  return {
    async listRiderResults(): Promise<ZwiftPowerResult[]> {
      const config = getZwiftPowerConfig();
      const api = new ZwiftPowerAPI(config.username, config.password);

      try {
        // Reuse a saved session when possible; otherwise a full SSO login.
        const serialized = await api.authenticate(loadCookies());
        if (typeof serialized === "string" && serialized.length > 0) {
          saveCookies(serialized);
        }

        const response = await api.getActivityResults(config.profileId);
        if (response.error !== undefined || response.body === undefined) {
          throw new ZwiftPowerSyncError(
            `ZwiftPower results request failed (status ${response.statusCode}${response.error !== undefined ? `: ${response.error}` : ""}).`,
          );
        }

        const data = (response.body as { data?: RawResult[] }).data;
        if (!Array.isArray(data)) return [];
        return data
          .map(toResult)
          .filter((r) => r.eventId.length > 0);
      } catch (err) {
        if (err instanceof ZwiftPowerSyncError) throw err;
        // Wrap every other failure (auth redirect mismatch, network, rate
        // limit) as a ZwiftPowerSyncError with a NON-secret message.
        throw new ZwiftPowerSyncError(
          `ZwiftPower request failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },

    async getZwiftFtp(): Promise<number | null> {
      const config = getZwiftPowerConfig();
      const api = new ZwiftAPI(config.username, config.password);
      try {
        await api.authenticate();
        const response = await api.getProfile("me");
        if (response.error !== undefined || response.body === undefined) return null;
        const raw = (response.body as { ftp?: unknown }).ftp;
        const ftp = Number(raw);
        return Number.isFinite(ftp) && ftp > 0 ? Math.round(ftp) : null;
      } catch {
        // Best-effort by contract: a profile hiccup must never break the sync.
        return null;
      }
    },

    async getPowerCurve(): Promise<ZwiftPowerCurvePoint[]> {
      const config = getZwiftPowerConfig();
      const api = new ZwiftPowerAPI(config.username, config.password);
      try {
        // Reuse the persisted session (ISC-344: no new session dance).
        const serialized = await api.authenticate(loadCookies());
        if (typeof serialized === "string" && serialized.length > 0) {
          saveCookies(serialized);
        }
        const response = await api.getCriticalPowerProfile(config.profileId);
        if (response.error !== undefined || response.body === undefined) {
          throw new ZwiftPowerSyncError(
            `ZwiftPower critical-power request failed (status ${response.statusCode}${response.error !== undefined ? `: ${response.error}` : ""}).`,
          );
        }
        return toPowerCurve(response.body);
      } catch (err) {
        if (err instanceof ZwiftPowerSyncError) throw err;
        throw new ZwiftPowerSyncError(
          `ZwiftPower critical-power request failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    },
  };
}
