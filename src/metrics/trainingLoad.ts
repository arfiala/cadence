// Per-activity training load, a native, dependency-free (ISC-146)
// implementation of the tiered model the ISA specifies (ISC-136). This is the
// TrainingPeaks-equivalent load computation Cadence uses instead of the closed
// TrainingPeaks partner API. Every function here is pure arithmetic over the
// fields already stored on an activity plus the user's FTP / LTHR thresholds.
//
// Four tiers, best-available first (ISC-136, ISC-301), and the tier used is
// reported per activity so the UI and tests can see which path produced a
// number. The precedence is power > hr > srpe > duration:
//   1. "power"   , Coggan TSS, when a power number and FTP are both present.
//   2. "hr"      , hrTSS from average heart rate and LTHR.
//   3. "srpe"    , session-RPE load, when an RPE is set and neither power nor
//                  HR tiers apply (ISC-299).
//   4. "duration", a flat moderate-intensity estimate from duration alone.
//
// Because power and hr are tried first, setting an RPE on an activity that
// already scores from power or HR changes NOTHING (ISC-302, advisor pin): the
// srpe tier is only ever reached when no objective-intensity data exists, so a
// Zwift/power ride's load can never shift because a human typed an RPE.
//
// sRPE (ISC-300): a session-RPE load on the same TSS point scale as the other
// tiers, using RPE/10 as an intensity-factor proxy:
//   load = (rpe / 10)^2 * 100 * hours
// This is NOT raw Foster session-RPE units (RPE * minutes); it is deliberately
// mapped onto the 100-points-per-hour-at-threshold scale so a mixed history of
// power, HR, and RPE activities sums into one coherent daily series. Worked
// vector: rpe 7 for 60 min = (0.7)^2 * 100 * 1.0 = 49.0.
//
// The metric names in the public API and UI are deliberately generic ("load",
// "fitness", "fatigue", "form") to avoid the TrainingPeaks trademark strings
// (ISC-142). The identifiers below (TSS, IF) are code-internal only.

export type LoadTier = "power" | "hr" | "srpe" | "duration";

export type ActivityLoadInput = {
  durationSeconds: number;
  avgHr: number | null;
  avgPower: number | null;
  normPower: number | null;
  // Rate of Perceived Exertion, 1..10, or null. Drives the srpe tier only when
  // no power/HR load applies (ISC-299). Optional so existing callers that do
  // not pass it behave exactly as before (rpe undefined === null, no srpe tier,
  // series byte-identical, ISC-302).
  rpe?: number | null;
};

export type Thresholds = {
  ftpWatts: number | null;
  lthrBpm: number | null;
};

export type ActivityLoad = {
  load: number; // rounded to 1 decimal
  tier: LoadTier;
  // Intensity Factor (NP/FTP) for the power tier, else the HR intensity ratio
  // for the hr tier, else the assumed moderate IF for the duration tier.
  intensityFactor: number;
  // True when the power tier used average power as a stand-in for normalized
  // power (ISC-138: the IF/TSS is then an estimate, not a true NP-based value).
  estimated: boolean;
};

// Moderate-intensity assumption for the duration-only fallback tier. An IF of
// 0.70 is a common "endurance / steady" placeholder; a duration-tier hour
// therefore scores 0.70^2 * 100 = 49 load units. Documented so the number is
// explainable rather than magic.
export const DURATION_TIER_IF = 0.7;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// Coggan Training Stress Score:
//   TSS = (duration_s * NP * IF) / (FTP * 3600) * 100,  with IF = NP / FTP.
// Anchored by the published definition that one hour at exactly FTP (IF = 1.0)
// scores 100 (ISC-137).
function powerTss(durationSeconds: number, np: number, ftp: number): { tss: number; intensityFactor: number } {
  const intensityFactor = np / ftp;
  const tss = ((durationSeconds * np * intensityFactor) / (ftp * 3600)) * 100;
  return { tss, intensityFactor };
}

// hrTSS: the HR-based analogue, using the average-HR to LTHR ratio as the
// intensity term. hrTSS = duration_h * (avgHr / LTHR)^2 * 100.
function hrTss(durationSeconds: number, avgHr: number, lthr: number): { tss: number; intensityFactor: number } {
  const intensityFactor = avgHr / lthr;
  const tss = (durationSeconds / 3600) * intensityFactor * intensityFactor * 100;
  return { tss, intensityFactor };
}

// Compute a single activity's load using the best tier the available data
// supports (ISC-136). Never throws; a zero/absent duration yields zero load.
export function activityLoad(input: ActivityLoadInput, thresholds: Thresholds): ActivityLoad {
  const duration = input.durationSeconds > 0 ? input.durationSeconds : 0;

  // Tier 1: power TSS. Needs FTP and at least one power number.
  if (thresholds.ftpWatts !== null && thresholds.ftpWatts > 0) {
    const ftp = thresholds.ftpWatts;
    const np = input.normPower !== null && input.normPower > 0 ? input.normPower : null;
    const ap = input.avgPower !== null && input.avgPower > 0 ? input.avgPower : null;
    const effectiveNp = np ?? ap;
    if (effectiveNp !== null) {
      const { tss, intensityFactor } = powerTss(duration, effectiveNp, ftp);
      return {
        load: round1(tss),
        tier: "power",
        intensityFactor: round1(intensityFactor * 100) / 100,
        estimated: np === null, // avg power stood in for normalized power
      };
    }
  }

  // Tier 2: hrTSS. Needs LTHR and average HR.
  if (
    thresholds.lthrBpm !== null &&
    thresholds.lthrBpm > 0 &&
    input.avgHr !== null &&
    input.avgHr > 0
  ) {
    const { tss, intensityFactor } = hrTss(duration, input.avgHr, thresholds.lthrBpm);
    return {
      load: round1(tss),
      tier: "hr",
      intensityFactor: round1(intensityFactor * 100) / 100,
      estimated: false,
    };
  }

  // Tier 3: session-RPE. Only reached when neither power nor HR applied, so it
  // can never override an objective-intensity load (ISC-301, ISC-302). Needs a
  // valid RPE in 1..10.
  const rpe = input.rpe ?? null;
  if (rpe !== null && Number.isFinite(rpe) && rpe >= 1 && rpe <= 10) {
    const intensityFactor = rpe / 10;
    const load = (duration / 3600) * intensityFactor * intensityFactor * 100;
    return {
      load: round1(load),
      tier: "srpe",
      intensityFactor: round1(intensityFactor * 100) / 100,
      estimated: true,
    };
  }

  // Tier 4: duration estimate. Always available.
  const load = (duration / 3600) * DURATION_TIER_IF * DURATION_TIER_IF * 100;
  return {
    load: round1(load),
    tier: "duration",
    intensityFactor: DURATION_TIER_IF,
    estimated: true,
  };
}
