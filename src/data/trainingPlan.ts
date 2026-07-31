// Base 1 training plan: cycling, lifting, stretching, running. No swim (starts 2027).
// Designed 2026-07-29 from Austin's interview answers, measured data (FTP 169 W, LTHR 185),
// and cited sources. Point-in-time plan content; edits happen here, then reseed with --force.
//
// Sources (fetched 2026-07-29):
// - Friel, Base periodization: https://joefrieltraining.com/training-in-base-2-and-3/
// - Friel, Build timing: https://joefrieltraining.com/build-period-overview/
// - 80/20 Ironman Level 0 volume band (5-12 h/wk): https://www.trainingpeaks.com/training-plans/triathlon/ironman/tp-112747/80-20-triathlon-2021-edition-ironman-level-0-pace-and-bike-hr-5-to-12-hours-per-week
// - RUNSAFE single-session spike risk (Nielsen et al., BJSM): https://health.au.dk/en/display/artikel/everything-we-thought-about-running-injury-development-was-wrong-study-shows
// - Long-run share and ceiling (Daniels via Trail Runner): https://www.trailrunnermag.com/training/mastering-the-long-run/
// - Cutback weeks: https://lauranorrisrunning.com/how-to-effectively-use-cutback-weeks-in-your-training/
// - Zwift race as intensity, structured work guidance: https://www.roadbikerider.com/zwift-races-vs-intervals/
// - Indoor base week shape: https://roadmancycling.com/blog/indoor-cycling-for-triathletes-winter-plan
// - Brick dose in base: https://roadmancycling.com/blog/brick-workouts-for-ironman
// - Strength for endurance (heavy or explosive improves running economy; heavy improves cycling economy):
//   Ronnestad and Mujika 2014: https://onlinelibrary.wiley.com/doi/abs/10.1111/sms.12104
// - Light-load-to-failure strength evidence (13.6 kg cap workaround):
//   Fisher 2017: https://onlinelibrary.wiley.com/doi/abs/10.1002/mus.25537
//   Synthesis: https://www.strongerbyscience.com/high-versus-low-load/

export const PLAN_PHASE = "Base 1";
export const PLAN_START = "2026-08-03"; // Monday of week 1
export const PLAN_WEEKS = 12;

// Macro roadmap toward a fall 2027 full-distance race (informational, rendered in plan header)
export const MACRO_ROADMAP = [
  { phase: "Base 1", span: "2026-08-03 to 2026-10-25", focus: "Run durability, bike hours, new strength habit. This block." },
  { phase: "Base 2", span: "2026-11-02 to 2027-01-24", focus: "Toward 10 h weeks, sweet spot bike work (149 to 160 W), long run toward 16 km, FTP and LTHR retest first week." },
  { phase: "Swim on-ramp", span: "January 2027", focus: "Swimming enters here per your call. Technique first, 2 short pool sessions a week." },
  { phase: "Race-specific", span: "final 24 weeks before the fall 2027 race", focus: "Pick the race by spring. Long rides toward race duration, bricks grow, taper at the end." },
];

export const PRIORITY_NOTE =
  "If a week gets tight, the order that protects the goal: Sunday long ride, then the long run, then strength A, then everything else. Informational only, the plan assumes full weeks.";

// Zones from measured numbers. FTP_W is the SEED-TIME default; the live value
// lives in settings.ftp_watts and auto-syncs from Zwift. All watt strings
// derive from these functions so recalibration regenerates from one source.
export const FTP_W = 169;
export const LTHR_BPM = 185;

const w = (f: number, pct: number) => Math.round(f * pct);
export const z2Range = (ftp: number) => `${w(ftp, 0.56)} to ${w(ftp, 0.75)} W`;
export const z5Range = (ftp: number) => `${w(ftp, 1.06)} to ${w(ftp, 1.2)} W`;
export function zonesPowerFor(ftp: number) {
  return [
    { zone: "Z1 Recovery", range: `below ${w(ftp, 0.55)} W` },
    { zone: "Z2 Endurance", range: z2Range(ftp) },
    { zone: "Z3 Tempo", range: `${w(ftp, 0.76)} to ${w(ftp, 0.9)} W` },
    { zone: "Sweet spot", range: `${w(ftp, 0.88)} to ${w(ftp, 0.947)} W (Base 2 preview)` },
    { zone: "Z4 Threshold", range: `${w(ftp, 0.91)} to ${w(ftp, 1.05)} W` },
    { zone: "Z5 VO2max", range: z5Range(ftp) },
  ];
}
export const ZONES_POWER = zonesPowerFor(FTP_W);

// Per-kind watt-bearing strings, shared by the seed generator and the FTP
// recalibration service (future planned rows regenerate from these).
export const raceTarget = (ftp: number) => `Race effort after a ${z2Range(ftp)} warmup`;
export const raceDetail = (ftp: number) =>
  `Warm up 15 min in Z2 (${z2Range(ftp)}), then race. This is the week's intensity. Spin down 5 to 10 min easy after. No race that fits the evening? Ride 30 min with 4 x 4 min at ${z5Range(ftp)}, 3 min easy between. Same session, same box ticked.`;
export const rideTarget = (ftp: number) => `${z2Range(ftp)} (Z2)`;
export const spinTarget = (ftp: number) => `${z2Range(ftp)} (Z2)`;
export const ZONES_HR = [
  { zone: "Z1", range: "below 157 bpm" },
  { zone: "Z2", range: "157 to 165 bpm" },
  { zone: "Z3", range: "166 to 174 bpm" },
  { zone: "Z4", range: "176 to 183 bpm" },
  { zone: "Z5", range: "185 bpm and up" },
];

// Per-week progression tables. Cutbacks at weeks 4, 8; week 12 consolidates before Base 2.
// Long run obeys the RUNSAFE spike rule (never over 110 percent of trailing-30-day longest).
type WeekRow = {
  week: number; label?: string;
  longRideMin: number; longRunKm: number; thuSpinMin: number; friRunMin: number; brick: boolean;
};
export const WEEK_TABLE: WeekRow[] = [
  { week: 1, longRideMin: 105, longRunKm: 8.0, thuSpinMin: 0, friRunMin: 40, brick: false },
  { week: 2, longRideMin: 115, longRunKm: 8.5, thuSpinMin: 0, friRunMin: 40, brick: false },
  { week: 3, longRideMin: 120, longRunKm: 9.0, thuSpinMin: 0, friRunMin: 40, brick: true },
  { week: 4, label: "cutback", longRideMin: 90, longRunKm: 6.5, thuSpinMin: 0, friRunMin: 40, brick: false },
  { week: 5, longRideMin: 125, longRunKm: 9.5, thuSpinMin: 30, friRunMin: 45, brick: true },
  { week: 6, longRideMin: 135, longRunKm: 10.0, thuSpinMin: 35, friRunMin: 45, brick: true },
  { week: 7, longRideMin: 145, longRunKm: 10.5, thuSpinMin: 40, friRunMin: 45, brick: true },
  { week: 8, label: "cutback", longRideMin: 105, longRunKm: 7.5, thuSpinMin: 0, friRunMin: 45, brick: false },
  { week: 9, longRideMin: 150, longRunKm: 11.0, thuSpinMin: 40, friRunMin: 45, brick: true },
  { week: 10, longRideMin: 160, longRunKm: 12.0, thuSpinMin: 45, friRunMin: 45, brick: true },
  { week: 11, longRideMin: 170, longRunKm: 13.0, thuSpinMin: 45, friRunMin: 45, brick: true },
  { week: 12, label: "consolidation", longRideMin: 120, longRunKm: 9.0, thuSpinMin: 30, friRunMin: 45, brick: true },
];

// New strength program, distinct from the Train tab library. Dumbbells only, 13.6 kg per hand max.
// Load-cap strategy per the cited evidence: unilateral loading raises relative intensity,
// tempo and pauses extend time under tension, sets finish 1 to 2 reps from failure,
// one explosive element supports running economy (Ronnestad and Mujika 2014).
export const STRENGTH_A = {
  title: "Strength A: Single-Leg Foundation",
  durationMin: 40,
  detail: [
    "Rear-foot elevated split squat, 3s down 1s pause: 3 x 8 per side",
    "Single-leg Romanian deadlift: 3 x 8 to 10 per side",
    "Dumbbell floor press: 3 x 10 to 12",
    "Single-leg calf raise from a step deficit: 3 x 12 per side",
    "Side plank: 2 x 40s per side",
    "Keep 2 reps in reserve on every set, Monday legs still have to race Tuesday. Rest 90s between sets.",
    "Only 20 minutes? Do the first three exercises and call it done.",
  ].join("\n"),
};
export const STRENGTH_B = {
  title: "Strength B: Hinge, Pull and Power",
  durationMin: 40,
  detail: [
    "Goblet squat, 3s pause at the bottom: 3 x 12",
    "Single-arm row: 3 x 10 per side",
    "Dumbbell push press, fast up: 3 x 8",
    "Single-leg hip bridge, foot elevated: 3 x 12 per side",
    "Pogo hops, stiff ankles: 3 x 20s (skip these any week the calves or achilles feel tender)",
    "Dead bug: 2 x 10 per side",
    "Finish 1 to 2 reps in reserve. The push press and pogos move fast, everything else controlled.",
    "Only 20 minutes? Do the first three exercises and call it done.",
  ].join("\n"),
};

export const ATG_NOTE =
  "Daily ATG mobility (your existing 8-item routine on the Stretch tab) continues every day. Saturday is rest plus mobility only.";

export type PlannedSeed = {
  planDay: string; sport: "bike" | "run" | "strength" | "mobility" | "rest";
  title: string; detail: string; durationMin: number; distanceM: number | null;
  target: string | null; tssPlanned: number | null; weekNo: number; phase: string; sort: number;
  kind: string;
};

const RUN_MIN_PER_KM = 7; // easy-pace planning estimate
const z2TSS = (min: number) => Math.round((min / 60) * 42); // IF ~0.65 planning estimate

function addDays(iso: string, n: number): string {
  const parts = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(parts[0] as number, (parts[1] as number) - 1, (parts[2] as number) + n));
  return dt.toISOString().slice(0, 10);
}

export function buildPlan(): PlannedSeed[] {
  const out: PlannedSeed[] = [];
  for (const w of WEEK_TABLE) {
    const monday = addDays(PLAN_START, (w.week - 1) * 7);
    const day = (offset: number) => addDays(monday, offset);
    const wkLabel = w.label ? ` (${w.label} week)` : "";
    // Monday: Strength A
    out.push({ planDay: day(0), sport: "strength", title: STRENGTH_A.title, detail: STRENGTH_A.detail, durationMin: STRENGTH_A.durationMin, distanceM: null, target: "1 to 2 reps in reserve", tssPlanned: null, weekNo: w.week, phase: PLAN_PHASE, sort: 1, kind: "strength_a" });
    // Tuesday: Zwift race
    out.push({ planDay: day(1), sport: "bike", title: "Zwift race" + wkLabel, detail: raceDetail(FTP_W), durationMin: 75, distanceM: null, target: raceTarget(FTP_W), tssPlanned: 85, weekNo: w.week, phase: PLAN_PHASE, sort: 1, kind: "race" });
    // Wednesday: long run
    const runMin = Math.round(w.longRunKm * RUN_MIN_PER_KM);
    out.push({ planDay: day(2), sport: "run", title: `Long run ${w.longRunKm.toFixed(1)} km` + wkLabel, detail: "Conversational pace the whole way. Walk breaks are fine. Keep heart rate in Z2, drift into Z3 only on the final 10 minutes if feeling good.", durationMin: runMin, distanceM: Math.round(w.longRunKm * 1000), target: "HR 157 to 165 bpm (Z2)", tssPlanned: null, weekNo: w.week, phase: PLAN_PHASE, sort: 1, kind: "long_run" });
    // Thursday: Strength B (+ optional spin from week 5)
    out.push({ planDay: day(3), sport: "strength", title: STRENGTH_B.title, detail: STRENGTH_B.detail, durationMin: STRENGTH_B.durationMin, distanceM: null, target: "1 to 2 reps in reserve", tssPlanned: null, weekNo: w.week, phase: PLAN_PHASE, sort: 1, kind: "strength_b" });
    if (w.thuSpinMin > 0) {
      out.push({ planDay: day(3), sport: "bike", title: `Easy spin ${w.thuSpinMin} min`, detail: "Legs-only recovery style spin after lifting. Nothing above Z2.", durationMin: w.thuSpinMin, distanceM: null, target: spinTarget(FTP_W), tssPlanned: z2TSS(w.thuSpinMin), weekNo: w.week, phase: PLAN_PHASE, sort: 2, kind: "spin" });
    }
    // Friday: easy run + strides
    out.push({ planDay: day(4), sport: "run", title: "Easy run + strides", detail: "Easy Z1 to Z2 running, then 6 x 20s relaxed-fast strides with full recovery. Strides are quick but never straining.", durationMin: w.friRunMin, distanceM: null, target: "HR below 165 bpm, strides by feel", tssPlanned: null, weekNo: w.week, phase: PLAN_PHASE, sort: 1, kind: "easy_run" });
    // Saturday: rest + ATG
    out.push({ planDay: day(5), sport: "rest", title: "Rest + daily ATG mobility", detail: ATG_NOTE, durationMin: 0, distanceM: null, target: null, tssPlanned: null, weekNo: w.week, phase: PLAN_PHASE, sort: 1, kind: "rest" });
    // Sunday: long ride (+ brick from week 3)
    const rideH = Math.floor(w.longRideMin / 60), rideM = w.longRideMin % 60;
    out.push({ planDay: day(6), sport: "bike", title: `Long ride ${rideH}:${String(rideM).padStart(2, "0")}` + wkLabel, detail: "Steady Z2 on Zwift, flat-ish route, stay seated and aero when you can. Eat every 45 min once rides pass 90 min.", durationMin: w.longRideMin, distanceM: null, target: rideTarget(FTP_W), tssPlanned: z2TSS(w.longRideMin), weekNo: w.week, phase: PLAN_PHASE, sort: 1, kind: "long_ride" });
    if (w.brick) {
      out.push({ planDay: day(6), sport: "run", title: "Brick run 15 min", detail: "Straight off the bike, shoes ready by the trainer. Easy jog, let the legs come around. This is about the transition feeling, not fitness.", durationMin: 15, distanceM: 2000, target: "Easy, RPE 3 to 4", tssPlanned: null, weekNo: w.week, phase: PLAN_PHASE, sort: 2, kind: "brick" });
    }
  }
  return out;
}
