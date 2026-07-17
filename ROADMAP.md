# Cadence Roadmap: 10 Proposed Features

Generated 2026-07-17 via BeCreative ideation. Status: proposed, nothing committed. Each item respects the standing exclusions (single user only, no native apps, no public health data) and the app's zero-dependency, low-maintenance ethos. Effort tags: S (a session), M (a day-ish), L (multi-day).

## 1. Threshold history (S)
Versioned FTP and LTHR values with effective dates instead of a single settings number. Training-load math picks the value in force on the activity date, so old sessions stay accurate when fitness changes. Flags a threshold as stale after 8 weeks and suggests a retest. Directly sharpens the new load engine.

## 2. Personal records board (S)
Auto-computed PRs from data already in the DB: longest ride, fastest average speed, longest swim, biggest week, longest G1 streak. Zero new data collection, pure query work, and a strong motivator on days when starting is the hard part.

## 3. Consistency heatmap (S)
GitHub-style year calendar where each day's cell shades by training minutes, with G1-met weeks outlined. Consistency is the actual TELOS G1 game, and a visible chain is the cheapest known motivation mechanic. Inline SVG, no libraries.

## 4. Recovery context from Garmin (M)
The Garmin sync already authenticates; extend it to pull sleep duration, resting HR, and HRV summaries into a small daily table shown next to Form. Answers "should I push today" with data instead of guesswork. Read-only, additive migration, dormant if Garmin stops providing the fields.

## 5. Gear odometer (S/M)
Track kilometers per bike (and wetsuit/shoes) by attributing activities to gear, with service thresholds: chain wax at 300 km, tires at 4000 km, pool wetsuit rinse reminders. Maintenance you forget is the expensive kind. Simple tables, no external calls.

## 6. One-tap quick log and home-screen install (S)
A web app manifest so fit.austinfiala.com installs to the phone home screen, plus preset buttons ("30 min trainer", "45 min swim", "ATG stretch") that log in one tap. Built for the newborn reality: the whole interaction fits inside a nap-window minute. Not a native app, just a manifest and a few buttons.

## 7. Outdoor window finder (M)
Keyless Open-Meteo forecast for New Jersey rendered as a "best 2 hour bike window in the next 3 days" strip on the dashboard. No API key, no account, one fetch per view with caching. Turns "is it worth riding outside Saturday" into a glance.

## 8. Monday digest tool for the DA (S)
A new MCP tool (get_week_digest) returning last week's summary, G1 verdict, load trend, and any PRs, wired into WeeklyReview so every Monday review opens with the training week already summarized. The infrastructure exists; this is one tool plus one workflow line.

## 9. Data insurance: nightly backup and export (S)
Nightly encrypted SQLite backup shipped off the box (S3 bucket pattern already proven on Suretas) plus a one-click JSON/CSV export in the UI. Health data with no second copy is a standing risk; this closes it for pennies.

## 10. Nutrition v2 (L)
The deliberately deferred one, listed so the gate is explicit: daily calories and protein either via MyFitnessPal import or 10-second manual entry, shown against training load. Worth building only when Austin says the training side feels solved. Biggest effort, biggest new habit cost, highest ceiling.

## Suggested order

Quick wins first: 6 (quick log), 3 (heatmap), 2 (PRs), 8 (digest), then 1 (thresholds) to sharpen the load engine, then 9 (backup). 4, 5, 7 as appetite allows. 10 waits for an explicit go.
