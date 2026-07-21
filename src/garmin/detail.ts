// Defensive parsing of Garmin per-activity splits/details into the small,
// validated shape Cadence caches (ISC-321..324). The Garmin splits/details
// endpoints return `unknown`, undeclared, sport/firmware-dependent payloads,
// so every field is read behind an explicit type guard, anything missing or
// oddly-shaped degrades to null, and NOTHING here ever throws (a parse failure
// must surface as an empty/degraded detail, never as a 500 to the route).
//
// A GPS polyline is decimated to at most 200 evenly-sampled points before
// storage (ISC-324) so a 5000-point outdoor ride does not bloat the cache.
//
// Observability (ISC-322, the sleep lesson): if a NON-empty payload parses to
// an all-null detail, that most likely means the field-name assumptions are
// wrong for this payload shape (unknown-typed endpoints), which would look
// identical to "this activity genuinely has no laps or GPS". We log the top
// level key set ONCE (keys only, never values) so the first real fetch surfaces
// a shape mismatch loudly instead of silently.

export type DetailLap = {
  lap_index: number;
  duration_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_power: number | null;
};

export type NormalizedDetail = {
  laps: DetailLap[];
  polyline: [number, number][]; // [lat, lng] pairs, decimated to <= 200
  summary: {
    max_hr: number | null;
    max_power: number | null;
    elevation_gain_m: number | null;
  };
};

const MAX_POLYLINE_POINTS = 200;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Garmin splits arrive under a few container shapes across endpoints; probe the
// common ones and fall back to an empty list.
function extractLapArray(splits: unknown): unknown[] {
  const rec = asRecord(splits);
  if (rec === null) return asArray(splits);
  // Common Garmin shapes: { lapDTOs: [...] } or { splits: [...] } or a bare array.
  for (const key of ["lapDTOs", "splits", "laps"]) {
    const arr = asArray(rec[key]);
    if (arr.length > 0) return arr;
  }
  return [];
}

function parseLap(raw: unknown, index: number): DetailLap {
  const rec = asRecord(raw) ?? {};
  return {
    lap_index: index + 1,
    duration_s:
      num(rec.duration) ?? num(rec.movingDuration) ?? num(rec.elapsedDuration),
    distance_m: num(rec.distance),
    avg_hr: num(rec.averageHR) ?? num(rec.avgHr),
    max_hr: num(rec.maxHR) ?? num(rec.maxHr),
    avg_power: num(rec.averagePower) ?? num(rec.avgPower),
  };
}

// Pull a GPS polyline out of the details payload. Garmin exposes track points
// under geoPolylineDTO.polyline (an array of {lat,lon}) among other shapes;
// probe defensively and return [lat,lng] pairs.
function extractPolyline(details: unknown): [number, number][] {
  const rec = asRecord(details);
  if (rec === null) return [];
  const candidates: unknown[] = [];
  const geo = asRecord(rec.geoPolylineDTO);
  if (geo !== null) candidates.push(geo.polyline);
  candidates.push(rec.polyline, rec.geoPolyline);
  for (const c of candidates) {
    const arr = asArray(c);
    if (arr.length === 0) continue;
    const points: [number, number][] = [];
    for (const p of arr) {
      const pr = asRecord(p);
      if (pr === null) continue;
      const lat = num(pr.lat) ?? num(pr.latitude);
      const lng = num(pr.lon) ?? num(pr.lng) ?? num(pr.longitude);
      if (lat !== null && lng !== null) points.push([lat, lng]);
    }
    if (points.length > 0) return decimate(points, MAX_POLYLINE_POINTS);
  }
  return [];
}

// Evenly sample down to at most `max` points, always keeping the first and
// last (ISC-324). A run of <= max points is returned unchanged.
export function decimate(points: [number, number][], max: number): [number, number][] {
  if (points.length <= max) return points;
  const out: [number, number][] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * step);
    out.push(points[Math.min(idx, points.length - 1)] as [number, number]);
  }
  return out;
}

function extractSummary(details: unknown): NormalizedDetail["summary"] {
  const rec = asRecord(details);
  const summaryDto = asRecord(rec?.summaryDTO) ?? rec ?? {};
  return {
    max_hr: num(summaryDto.maxHR) ?? num(summaryDto.maxHr),
    max_power: num(summaryDto.maxPower),
    elevation_gain_m: num(summaryDto.elevationGain) ?? num(summaryDto.totalElevationGain),
  };
}

let loggedAllNullOnce = false;

// Reset hook for tests that assert the one-time log fires (ISC-322).
export function _resetDetailLogState(): void {
  loggedAllNullOnce = false;
}

function isAllNull(detail: NormalizedDetail): boolean {
  return (
    detail.laps.length === 0 &&
    detail.polyline.length === 0 &&
    detail.summary.max_hr === null &&
    detail.summary.max_power === null &&
    detail.summary.elevation_gain_m === null
  );
}

// Parse raw splits + details into the normalized, cacheable shape. Never
// throws. `splits`/`details` are whatever the Garmin client returned (or null
// when a call was skipped/failed).
export function parseGarminDetail(splits: unknown, details: unknown): NormalizedDetail {
  const laps = extractLapArray(splits).map((raw, i) => parseLap(raw, i));
  const polyline = extractPolyline(details);
  const summary = extractSummary(details);
  const detail: NormalizedDetail = { laps, polyline, summary };

  // Sleep-lesson observability (ISC-322): a non-empty payload that maps to
  // all-null is the signal that the field mapping needs updating. Log the key
  // set once.
  const payloadNonEmpty =
    asRecord(splits) !== null || asArray(splits).length > 0 || asRecord(details) !== null;
  if (payloadNonEmpty && isAllNull(detail) && !loggedAllNullOnce) {
    loggedAllNullOnce = true;
    const splitKeys = Object.keys(asRecord(splits) ?? {});
    const detailKeys = Object.keys(asRecord(details) ?? {});
    console.warn(
      `[cadence] Garmin activity detail parsed to all-null from a non-empty payload. ` +
        `The splits/details field mapping likely needs updating for this payload shape. ` +
        `splits keys: [${splitKeys.join(", ")}]; details keys: [${detailKeys.join(", ")}]`,
    );
  }

  return detail;
}
