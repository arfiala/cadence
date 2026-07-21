# Cadence Roadmap

Round 1 generated 2026-07-17, Round 2 generated 2026-07-21, both via BeCreative ideation. Each item respects the standing exclusions (single user only, no native apps, no public health data) and the app's zero-dependency, low-maintenance ethos. Effort tags: S (a session), M (a day-ish), L (multi-day). Shipped items are marked so this file stays truthful.

# Round 1 (2026-07-17)

## 1. Threshold history (S)
Versioned FTP and LTHR values with effective dates instead of a single settings number. Training-load math picks the value in force on the activity date, so old sessions stay accurate when fitness changes. Flags a threshold as stale after 8 weeks and suggests a retest. Directly sharpens the new load engine.

## 2. Personal records board (S) [SHIPPED]
Shipped: PR board and streaks live on the dashboard. Auto-computed PRs from data already in the DB: longest ride, fastest average speed, longest swim, biggest week, longest G1 streak. Zero new data collection, pure query work, and a strong motivator on days when starting is the hard part.

## 3. Consistency heatmap (S) [SHIPPED]
Shipped: 52-week heatmap lives on the Trends tab. GitHub-style year calendar where each day's cell shades by training minutes, with G1-met weeks outlined. Consistency is the actual TELOS G1 game, and a visible chain is the cheapest known motivation mechanic. Inline SVG, no libraries.

## 4. Recovery context from Garmin (M) [PARTIALLY SHIPPED]
Shipped: sleep sync and the Sleep tab (2026-07-20). Still open: resting HR and HRV summaries. The Garmin sync already authenticates; extend it to pull sleep duration, resting HR, and HRV summaries into a small daily table shown next to Form. Answers "should I push today" with data instead of guesswork. Read-only, additive migration, dormant if Garmin stops providing the fields.

## 5. Gear odometer (S/M)
Track kilometers per bike (and wetsuit/shoes) by attributing activities to gear, with service thresholds: chain wax at 300 km, tires at 4000 km, pool wetsuit rinse reminders. Maintenance you forget is the expensive kind. Simple tables, no external calls.

## 6. One-tap quick log and home-screen install (S) [SHIPPED]
Shipped: PWA manifest, icons, and dashboard preset buttons are live. A web app manifest so fit.austinfiala.com installs to the phone home screen, plus preset buttons ("30 min trainer", "45 min swim", "ATG stretch") that log in one tap. Built for the newborn reality: the whole interaction fits inside a nap-window minute. Not a native app, just a manifest and a few buttons.

## 7. Outdoor window finder (M)
Keyless Open-Meteo forecast for New Jersey rendered as a "best 2 hour bike window in the next 3 days" strip on the dashboard. No API key, no account, one fetch per view with caching. Turns "is it worth riding outside Saturday" into a glance.

## 8. Monday digest tool for the DA (S) [SHIPPED]
Shipped: get_week_digest is live in the MCP server. A new MCP tool (get_week_digest) returning last week's summary, G1 verdict, load trend, and any PRs, wired into WeeklyReview so every Monday review opens with the training week already summarized. The infrastructure exists; this is one tool plus one workflow line.

## 9. Data insurance: nightly backup and export (S)
Nightly encrypted SQLite backup shipped off the box (S3 bucket pattern already proven on Suretas) plus a one-click JSON/CSV export in the UI. Health data with no second copy is a standing risk; this closes it for pennies.

## 10. Nutrition v2 (L) [SHIPPED AS LLM MVP]
Shipped: LLM-estimated calorie and macro logging with itemized editable entries went live 2026-07-19. Still out: MyFitnessPal import, barcode lookup, external nutrition databases. The original note stands for those: daily calories and protein shown against training load, worth extending only when the training side feels solved.

## Round 1 suggested order (historical)

Quick wins first: 6 (quick log), 3 (heatmap), 2 (PRs), 8 (digest), then 1 (thresholds) to sharpen the load engine, then 9 (backup). 4, 5, 7 as appetite allows. 10 waits for an explicit go. As of 2026-07-21 the still-open round 1 items are 1 (thresholds), 5 (gear odometer), 7 (weather window), 9 (backup and export), and the RHR/HRV half of 4.

# Round 2 (2026-07-21)

Ten new features, zero overlap with round 1 or anything built. Tiered by effort and value, with data prerequisites named where they exist.

## Quick wins

## 11. Swim sets library (S)
Swimming is half of G1 and completely featureless in the app today. Hand-authored swim workout cards following the proven Stretch tab pattern: 30 and 45 minute sets with drills and pacing notes, one tap logs the session. No new data collection, pure content plus an existing mechanic.

## 12. Duplicate activity detector (S/M)
A real correctness risk hiding as a feature: a Zwift ride auto-uploads to Garmin Connect while a watch also records it, and both land as activities, double-counting G1 sessions and hours. The detector flags pairs that overlap in time with matching duration and distance tolerance; Austin confirms merge or keep per pair. Match criteria defined up front, never auto-merges.

## 13. RPE logging and honest swim/strength load (S)
A one-tap "how hard was that" chip (1 to 10) on any activity. The load engine gains an sRPE tier for sessions with no power or heart rate, mapped onto the existing TSS-point scale rather than raw Foster units so the Fitness/Fatigue/Form series stays continuous. Fixes the blind spot where swims barely register training load.

## 14. Week pacing forecast (S)
Arithmetic on the G1 metric itself, deliberately not the load model: "at your usual Tue/Thu/Sat rhythm you land at 4 sessions and 7.1 hours; one more swim closes the week." Uses historical session start times to suggest which days realistically have windows. Prerequisite: a few weeks of history, which already exists.

## 15. Year-over-year comparison chips (S)
"This week vs the same week last year" deltas on the Trends tab. The Garmin backfill already pulled a full year of history. Shows an honest "not enough history" state per metric until 12 months exist.

## Bigger builds

## 16. Activity detail view with laps (M)
Tap an activity to see a per-lap and per-split breakdown with average and max heart rate and power per lap. Garmin provides lap data; the sync would start storing it. Turns the activity list from a log into a review tool.

## 17. Critical power curve, cycling only (M)
Best 5 second, 1 minute, 5 minute, and 20 minute power from ZwiftPower data over a rolling 90 days, drawn as an inline SVG curve. Explicitly scoped to cycling. Shows a sparse-data state when few max efforts exist, since the curve is only as honest as the efforts behind it.

## 18. GPS trace mini-maps (M)
Outdoor rides and runs render their GPS track as a small inline SVG path. No map tiles, no external calls, fully private by construction. Indoor activities show a clean empty state; long tracks get point decimation so the SVG stays small.

## 19. Race countdown card (M)
Set a target event date and the dashboard shows days-out with a static, deliberately generic taper checklist for the final week. Manual date entry, no ZwiftPower event-calendar dependency, and no adaptive coaching logic (which stays excluded).

## Automation

## 20. G1 risk alert through the DA (S, opt-in)
An opt-in scheduled check: if by Thursday evening the week projects short on plain sessions-and-hours arithmetic, Ardee pings once, snoozeable. The MCP plumbing already exists; this is one cron job and one threshold check. Off by default.

## Round 2 suggested order

11 (swim sets), 13 (RPE load), 12 (duplicates), 14 (pacing), then the M items by appetite. 20 whenever the nudge sounds useful rather than annoying.
