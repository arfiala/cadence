---
task: Cadence — Austin's personal fitness app (Garmin-synced, MCP-editable)
project: cadence
effort: E4
phase: build
progress: 167/210
mode: standard
started: 2026-07-16T19:50:29Z
updated: 2026-07-17T18:45:00Z
---

## Problem

Austin trains toward TELOS G1 (5 swim/bike sessions per week, ≥8 hours) but his training data is scattered: Zwift rides in Zwift, watch activities in Garmin Connect, and a hand-maintained `TRAINING_LOG.md` that is empty because manual logging never survives contact with a newborn's schedule. There is no single place that answers "how is my training week going," and no way for his DA to read or fix that data conversationally. MyFitnessPal nutrition is explicitly OUT of v1 (Austin's call, 2026-07-16); the model leaves room for it.

## Vision

Austin asks "how's my week" in any conversation and gets an answer from his real training data — sessions, hours, the G1 gap — without opening anything. When something is wrong ("that was a swim, not a ride"), he says so and it's fixed. Opening fit.austinfiala.com on his phone shows the week at a glance in the same visual language as his personal site. Euphoric surprise: the app disappears into conversation; the dashboard is just the proof.

## Out of Scope

Nutrition/MyFitnessPal integration ~~(deferred by Austin, v2 candidate)~~ — AMENDED 2026-07-18: Austin brought nutrition into scope as an LLM-estimated calorie/macro counter (ISC-189..220, see Decisions); what stays out is any external nutrition-database dependency (USDA/Nutritionix/MyFitnessPal API) and any branded/barcode lookup, both deferred behind the LLM-estimation MVP. Multi-user anything: registration, roles, sharing. Training PLANS and coaching logic (v1 is truth about what happened, not prescriptions) — AMENDED 2026-07-16: Austin explicitly requested a static ATG daily stretching plan (ISC-104+); the exclusion now covers dynamic/adaptive coaching logic only, not this fixed reference plan. Native mobile apps. Strava. Direct Zwift API integration — Zwift reaches the app through Zwift's own auto-upload to Garmin Connect. AMENDED 2026-07-17: ZwiftPower race results and rider category are separate data that never flow through Garmin, so a direct ZwiftPower connection (ISC-118+) is now in scope; the Zwift game API itself stays excluded. TrainingPeaks partner API is out of scope by external constraint: it is closed to individuals and paused for new partners as of July 2026 (verified via trainingpeaks.com help center and api.trainingpeaks.com/request-access), so TP-equivalent training-load metrics are computed natively instead. Public visibility of any health data. Charts libraries and frontend frameworks — inline SVG and vanilla JS only, matching austinfiala.com's zero-dependency ethos.

## Principles

- One integration, one hub: Garmin Connect is the single ingestion point; anything that syncs to Garmin flows in free.
- The MCP surface and the web UI are peers over one API — anything the UI can do, the DA can do.
- Truth over decoration: the dashboard states the G1 gap plainly ("2 sessions, 3.2 h — need 3 more sessions, 4.8 h by Sunday").
- Health data is private by construction: every data route behind auth, secrets never in git, DB file mode 600.
- Simple over clever: SQLite, server-rendered-ish single HTML app, no build step beyond Bun.

## Constraints

- TypeScript + Bun only (Austin re-confirmed 2026-07-16: no Python fallback; a broken TS path comes back to him instead).
- Runs on the existing Lightsail box (`suretas-prod`) as a third service; MUST NOT disturb suretas.com or austinfiala.com — Caddyfile edits are backup-then-reload, never restart.
- Single user: exactly one account (Austin's), no registration endpoint, password set/reset via an on-box CLI script (SSH access = reset ability).
- Garmin access is via an unofficial library with MFA-capable token persistence; Garmin credentials live only in the box's `.env` (mode 600) — the repo carries no secrets.
- MCP server runs on Austin's local machine and reaches the app over HTTPS with a bearer token; the token grants the same single-user scope as the web login.
- SQLite via `bun:sqlite`, WAL mode; zero runtime npm dependencies beyond the Garmin client and `@modelcontextprotocol/sdk`.

## Goal

Cadence is live at `https://fit.austinfiala.com` behind Austin's single-user login, holds his activities synced from Garmin Connect (Zwift rides included via Zwift→Garmin linking), shows his week against the G1 target, accepts manual entries, and exposes a registered MCP server through which the DA can read, log, edit, and delete activities — all verified end to end.

## Criteria

### Data model & spine
- [x] ISC-1: SQLite schema has `activities` (id, source ['garmin'|'manual'], garmin_id UNIQUE nullable, sport, start_time, duration_s, distance_m nullable, calories nullable, avg_hr nullable, title, notes, created_at, updated_at) — probe: schema read
- [x] ISC-2: `sport` is normalized to a controlled vocabulary (cycling, virtual_cycling, swimming, running, strength, other) with the raw Garmin type preserved in `raw_type` — probe: bun test
- [x] ISC-3: `settings` table stores weekly targets (sessions=5, hours=8) editable without redeploy — probe: SELECT + API
- [x] ISC-4: `sync_runs` table records every Garmin sync (started, finished, status, activities_seen, activities_new, error) — probe: SELECT after sync
- [x] ISC-5: DB file created mode 600, WAL enabled — probe: stat + PRAGMA
- [x] ISC-6: Anti: no table or column stores Garmin password or MFA codes; only session tokens — probe: schema grep
- [x] ISC-7: A `nutrition_days` placeholder is NOT created — v2 room means design headroom, not dead tables — probe: schema grep
- [x] ISC-8: All timestamps stored UTC ISO-8601; display timezone America/New_York applied at render — probe: bun test
- [x] ISC-9: Week boundaries are Monday 00:00 local (America/New_York) everywhere weeks are computed — probe: bun test with DST edge
- [x] ISC-10: Idempotent migrations via the pragma_table_info-guarded pattern — probe: run twice, no error

### Auth (single-user)
- [x] ISC-11: Login page at `/` when unauthenticated; email+password form, no registration link — probe: curl + Interceptor
- [x] ISC-12: Passwords hashed argon2id via Bun.password — probe: code + DB read
- [x] ISC-13: 5-failed-attempts lockout with atomic SQL counter increment (Suretas lesson: read-modify-write is racy) — probe: bun test parallel failures
- [x] ISC-14: Every login failure mode returns a byte-identical response (no enumeration oracle) — probe: bun test compares bodies
- [x] ISC-15: Session cookie HttpOnly, Secure, SameSite=Lax, 30-day expiry — probe: curl -i header check
- [x] ISC-16: Logout destroys the server-side session row — probe: bun test reuse after logout → 401
- [x] ISC-17: `bin/set-password.ts` CLI sets/resets the single user's password on-box; refuses to create a second user — probe: run twice with different emails
- [x] ISC-18: Anti: no /register endpoint exists — probe: curl → 404
- [x] ISC-19: Every /api/* route except /health and /auth/login requires a valid session OR valid API bearer token — probe: bun test unauthenticated sweep across all routes
- [x] ISC-20: API bearer token is a 32-byte random hex generated by `bin/issue-token.ts`, stored hashed (SHA-256) in DB — probe: DB shows hash, not token
- [x] ISC-21: Token can be revoked via `bin/issue-token.ts --revoke` — probe: revoked token → 401
- [x] ISC-22: Anti: bearer token never appears in any URL, only Authorization header (constitutional rule) — probe: grep client+server code
- [x] ISC-23: Rate limit on /auth/login (per-IP, modest) — probe: bun test hammering → 429

### Garmin sync
- [x] ISC-24: Garmin client library chosen by live probe at build time (MFA-capable, token persistence); choice + probe evidence in Decisions — probe: Decisions entry
- [x] ISC-25: `sync.ts` pulls recent activities (paged) and upserts by garmin_id — probe: bun test with mocked client
- [x] ISC-26: Upsert is idempotent: same activity twice → one row, updated_at bumped only on change — probe: bun test
- [x] ISC-27: Manual edits to a Garmin-sourced activity's `sport`/`notes`/`title` survive re-sync (edit wins; duration/distance from Garmin win) — field-level merge policy tested — probe: bun test
- [x] ISC-28: Sync failure (bad creds, network, rate limit) records an errored sync_run and never crashes the server — probe: bun test with failing mock
- [x] ISC-29: Garmin session tokens persisted to disk (mode 600) so MFA is not re-prompted every sync — probe: stat + re-sync without re-auth in mock (closed live 2026-07-17: /opt/cadence/garmin-tokens drwx------, post-restart sync succeeded with no MFA code in env)
- [x] ISC-30: Scheduled sync every 6h in-process; "Sync now" button and MCP tool trigger the same code path — probe: bun test single implementation
- [x] ISC-31: Concurrent sync attempts collapse (second request returns 'already running') — probe: bun test parallel trigger
- [x] ISC-32: Sync maps Garmin activity types → sport vocabulary incl. virtual_ride→virtual_cycling, lap_swimming/open_water→swimming — probe: bun test mapping table
- [x] ISC-33: live pull of Austin's real Garmin activities once he sets credentials — probe: sync_runs row with real counts (closed 2026-07-17: 50 seen / 50 new, then 50 seen / 0 new on token-reuse re-sync; FOLLOWUP-cadence-live-garmin resolved)
- [x] ISC-34: Anti: sync never deletes rows; Garmin-deleted activities remain (source of truth for history is Cadence once ingested) — probe: bun test
- [x] ISC-35: A setup doc section explains linking Zwift→Garmin (Settings→Connections) so Zwift rides flow in — probe: README grep

### API
- [x] ISC-36: GET /api/activities?from=&to=&sport=&limit= returns filtered, newest-first — probe: bun test
- [x] ISC-37: POST /api/activities creates a manual activity (validation: sport in vocab, duration>0, start_time valid) — probe: bun test
- [x] ISC-38: PATCH /api/activities/:id edits (partial, validated); Garmin-sourced rows editable per ISC-27 policy — probe: bun test
- [x] ISC-39: DELETE /api/activities/:id works for manual rows; Garmin rows require ?confirm=true — probe: bun test both paths
- [x] ISC-40: GET /api/week?date= returns Monday-anchored week summary: sessions count (swim/bike only per G1), total hours (all sports + G1-qualifying split), per-day breakdown, gap-to-target — probe: bun test fixture week
- [x] ISC-41: GET /api/trends?weeks=N returns weekly aggregates for charting — probe: bun test
- [x] ISC-42: GET /api/settings + PATCH /api/settings (targets) — probe: bun test
- [x] ISC-43: POST /api/sync triggers sync; GET /api/sync/status reports last runs — probe: bun test
- [x] ISC-44: GET /health returns 200 {status:'ok', service:'cadence'} unauthenticated — probe: curl
- [x] ISC-45: Validation errors return 400 with a message; unknown routes 404; all errors JSON — probe: bun test sweep
- [x] ISC-46: Anti: no route echoes back credentials, tokens, or Garmin session material — probe: response body grep in tests
- [x] ISC-47: G1 qualification rule (sessions = cycling+virtual_cycling+swimming) is one named function used by week, trends, and MCP — probe: grep single definition

### Web UI
- [x] ISC-48: Dashboard shows current week: big sessions count vs 5, hours vs 8, per-day dots, plain-language gap line — probe: Interceptor
- [x] ISC-49: Activity list, newest first, sport icon, duration, date, source badge (Garmin/manual/Zwift-via-Garmin shown as virtual ride) — probe: Interceptor
- [x] ISC-50: Add-activity form (sport, date, duration, optional distance/notes) with double-submit guard (Suretas lesson) — probe: Interceptor double-click
- [DEFERRED-VERIFY] ISC-51: Edit and delete from the list (delete confirms; Garmin rows say re-sync-safe note per ISC-27) — probe: Interceptor
- [DEFERRED-VERIFY] ISC-52: Trends view: last 8 weeks, inline-SVG bars for hours and sessions with target lines — probe: Interceptor
- [DEFERRED-VERIFY] ISC-53: "Sync now" button with running state and last-sync line — probe: Interceptor
- [x] ISC-54: All user text escaped (escapeHtml everywhere user content renders) — probe: code grep + XSS attempt test
- [x] ISC-55: Visual language matches austinfiala.com: evergreen #0B3D2E, emerald accents, Space Grotesk/Inter self-hosted, thin-line motif — probe: Interceptor screenshot
- [DEFERRED-VERIFY] ISC-56: Usable at 375px width (his phone is a stated target) — probe: CSS structure + phone check follow-up
- [x] ISC-57: Zero external requests: fonts self-hosted, no CDN, no analytics — probe: served bytes grep + network log
- [x] ISC-58: Anti: no health data renders on any unauthenticated page — probe: curl sweep of / while logged out
- [DEFERRED-VERIFY] ISC-59: Session-expired API responses redirect the UI to login cleanly — probe: Interceptor with killed session

### MCP server
- [x] ISC-60: `mcp/server.ts` speaks MCP over stdio using @modelcontextprotocol/sdk — probe: bun run + initialize handshake
- [x] ISC-61: Tool get_week_summary(date?) → the /api/week payload, formatted for conversation — probe: MCP client test
- [x] ISC-62: Tool list_activities(from?, to?, sport?, limit?) — probe: MCP client test
- [x] ISC-63: Tool log_activity(sport, date, duration_minutes, distance_km?, notes?) — probe: MCP client test + DB row
- [x] ISC-64: Tool edit_activity(id, fields) — probe: MCP client test + DB row
- [x] ISC-65: Tool delete_activity(id, confirm) requires confirm=true — probe: MCP client test refusal + success
- [x] ISC-66: Tool trigger_sync() and get_sync_status() — probe: MCP client test
- [x] ISC-67: Tool get_goal_progress() → sessions/hours vs targets + plain-language gap (G1 language) — probe: MCP client test
- [x] ISC-68: MCP server reads CADENCE_URL + CADENCE_TOKEN from env; missing env → clear startup error, no crash loop — probe: run without env
- [x] ISC-69: MCP errors surface API failures as tool errors with human-readable messages, never stack traces — probe: MCP test with dead server
- [x] ISC-70: Registered in ~/.claude/.mcp.json as "cadence" with env wired — probe: file read + `claude mcp list`-equivalent handshake
- [x] ISC-71: Anti: MCP server contains zero business logic — every tool is a thin authenticated API call (UI/MCP parity by construction) — probe: code review grep for SQL in mcp/
- [x] ISC-72: A destructive-tool description explicitly says it edits Austin's real training log (informed model consent) — probe: tool description read

### Deploy
- [x] ISC-73: Repo at ~/Projects/cadence, committed; deploy = clean git-archive rsync to /opt/cadence (established pattern) — probe: git log + box ls
- [x] ISC-74: systemd unit `cadence.service` (like suretas.service), auto-restart, EnvironmentFile=/opt/cadence/.env — probe: systemctl status
- [x] ISC-75: DNS A record fit.austinfiala.com → 44.200.119.114 created (records BEFORE any dig — documented gotcha) — probe: dig after creation
- [x] ISC-76: Caddy site block for fit.austinfiala.com reverse_proxy to the cadence port; Caddyfile backed up first; RELOAD not restart — probe: Caddyfile diff + backup file exists
- [x] ISC-77: Valid Let's Encrypt cert on fit.austinfiala.com — probe: curl -v TLS check
- [x] ISC-78: suretas.com/health AND austinfiala.com both 200 after the Caddy reload — probe: curl both
- [x] ISC-79: austinfiala.com nav gains a "Fitness" link to fit.austinfiala.com (content edit + rebuild + rsync per that site's pattern) — probe: curl austinfiala.com grep
- [x] ISC-80: .env on box mode 600 with SESSION_SECRET, PORT, DB_PATH; Garmin creds slots documented but empty until Austin fills them — probe: ssh stat + grep keys
- [x] ISC-81: /health 200 on https://fit.austinfiala.com — probe: curl
- [x] ISC-82: Austin's user seeded on the box via set-password CLI with a temp password he must change... NO — Austin sets his own password via the CLI over SSH, or I set a strong one and hand it to him out-of-band; either way login verified live — probe: live login
- [x] ISC-83: Anti: cadence deploy does not touch /opt/suretas or /opt/austinfiala files — probe: rsync target path + mtime spot-check
- [x] ISC-84: Anti: no secret (session secret, token, Garmin creds) in git history — probe: git log -p grep sweep
- [x] ISC-85: Box disk/memory sanity after third service: free -m shows headroom, all three services active — probe: ssh checks

### Tests & quality
- [x] ISC-86: bun test suite green; every API route has at least one test — probe: bun test + route/test cross-grep
- [x] ISC-87: bunx tsc --noEmit clean (zero errors — new repo has no legacy debt) — probe: tsc
- [x] ISC-88: Auth tests: lockout race (parallel), enumeration byte-equality, token revocation, unauthenticated sweep — probe: bun test
- [x] ISC-89: Sync tests: idempotent upsert, edit-survives-resync merge, failure recording, type mapping — probe: bun test
- [x] ISC-90: Week-math tests: Monday boundary, DST transition week, empty week, G1 qualification — probe: bun test
- [x] ISC-91: MCP tests: every tool exercised against a running test instance — probe: bun test
- [x] ISC-92: Anti: no new runtime dependency beyond the Garmin client + @modelcontextprotocol/sdk — probe: package.json read
- [x] ISC-93: README covers: setup, password CLI, token CLI, Garmin creds, Zwift→Garmin linking, deploy runbook — probe: README read

### Verification (live, end of build)
- [DEFERRED-VERIFY] ISC-94: Full local Interceptor walkthrough: login → dashboard → add activity → edit → delete → trends → sync-now (mocked) → logout — probe: Interceptor
- [x] ISC-95: Live production login walkthrough on fit.austinfiala.com — probe: Interceptor on prod
- [x] ISC-96: MCP round-trip from THIS machine against production: get_goal_progress + log_activity + edit + delete, then cleanup — probe: MCP tool calls
- [x] ISC-97: TRAINING_LOG.md gets a pointer note that Cadence supersedes it (WeeklyReview keeps working — it reads the file, which now names the API) — probe: file read
- [x] ISC-98: Anti: after all verification, no synthetic/test activities remain in the prod DB — probe: SELECT count

### Advisor-driven hardening (added pre-build, 2026-07-16)
- [x] ISC-99: CSV import (upload: date,sport,duration_minutes,distance_km?,notes?) as the documented Garmin-outage survival path — endpoint + UI + parse validation — probe: bun test + Interceptor upload
- [x] ISC-100: The Garmin client library is touched ONLY inside src/garmin/ — a library swap changes one directory, never API/UI/MCP — probe: import grep outside src/garmin/ → 0
- [x] ISC-101: Garmin library version pinned exact in package.json (no ^ or ~) — probe: package.json read
- [x] ISC-102: Lockout auto-expires after 15 minutes AND bin/set-password.ts clears lockout + sessions — the single-user self-DoS escape hatch — probe: bun test + CLI run
- [x] ISC-103: Anti: exactly ONE resident process on the box (cadence.service); sync is in-process scheduled, MCP is spawned on demand on Austin's machine, no cron/worker daemons — probe: systemctl list + ps on box

### Stretching plan — ATG daily routine (added 2026-07-16, Austin's request)
- [x] ISC-104: "Stretch" tab appears in the nav and switches to the stretch view — probe: Interceptor click
- [x] ISC-105: Plan data contains exactly 8 items in ATG order (backward-walk warm-up, ATG split squat, couch stretch, elephant walk, pancake good morning, butterfly, pigeon, calf stretch), each with name, dose, target area, coaching cue — probe: data read + count
- [x] ISC-106: All 8 stretch SVGs served 200 from /img/stretch/ — probe: curl ×8
- [x] ISC-107: Anti: SVGs make zero external requests (no http refs inside) — probe: grep
- [x] ISC-108: "Log stretch session" button creates a manual activity (sport=strength, 15 min, title "ATG Daily Stretch") via the existing activities API — probe: click + API read-back
- [x] ISC-109: Anti: a logged stretch session never counts toward G1 qualification — probe: bun test
- [x] ISC-110: Log button disables during the request (double-submit guard, Suretas lesson) — probe: code grep + double-click test
- [x] ISC-111: After logging, the view shows a "done today" state that survives reload (derived from today's activities) — probe: Interceptor reload
- [x] ISC-112: Anti: zero new runtime dependencies — probe: package.json/bun.lock diff
- [x] ISC-113: Anti: zero schema changes — probe: db.ts diff
- [x] ISC-114: bun test green (incl. new tests) and bunx tsc --noEmit clean — probe: Bash
- [x] ISC-115: Stretch view single-column readable at 375px via existing responsive CSS — probe: CSS structural check (phone screenshot rides FOLLOWUP-cadence-ui-pass)
- [x] ISC-116: Anti: dashboard, activities, trends, sync views render unchanged — probe: Interceptor spot-check
- [x] ISC-117: Deployed to production and the stretch tab live-verified — probe: Interceptor on fit.austinfiala.com (gated on Austin's deploy approval)

### ZwiftPower connection (added 2026-07-17, Austin: "Build connections to zwiftpower")
- [x] ISC-118: `@codingwithspike/zwift-api-wrapper@0.0.9` exact-pinned in package.json, all usage isolated to `src/zwiftpower/` (same swap-friendly pattern as src/garmin/), probe: package.json read + rg imports outside the dir
- [x] ISC-119: Anti: zero native `.node` modules in the tree after install (Garmin-swap hard lesson), probe: `find node_modules -name '*.node'` empty
- [x] ISC-120: Zwift credentials only via env (`ZWIFT_USERNAME`/`ZWIFT_PASSWORD`); never in git, DB, or logs, probe: rg across repo + test asserting log redaction
- [x] ISC-121: `zwiftpower_results` table (event id, date, title, category, position, power metrics nullable) created via guarded idempotent migration, probe: schema read + double-run
- [x] ISC-122: Sync fetches Austin's rider results through the wrapper's authenticated ZwiftPower access and upserts idempotently (same result twice = one row), probe: bun test with fixture
- [x] ISC-123: Rider category (A/B/C/D/E) captured and stored when ZwiftPower provides it, probe: bun test fixture
- [x] ISC-124: Auth failure, rate limit, or missing ZwiftPower profile records an errored sync run and never crashes the server, probe: bun test with failing mock
- [x] ISC-125: Manual "sync ZwiftPower" endpoint exists and is auth-gated (401 unauthenticated), probe: curl
- [x] ISC-126: Race results render in the web UI (date, event, category, position), reusing existing view conventions, probe: Interceptor on throwaway instance
- [x] ISC-127: MCP tool `get_race_results` returns stored results (UI and MCP stay peers), probe: stdio round-trip
- [x] ISC-128: Anti: ZwiftPower sync never writes to the `activities` table; results are not activities, probe: bun test
- [x] ISC-129: Anti: no test performs a live Zwift/ZwiftPower login; fixtures and mocks only (rate-limit lesson from Garmin), probe: rg test files for network calls
- [x] ISC-130: ZwiftPower session cookies persisted to disk mode 600 so re-auth is not per-sync, probe: implementation read + stat in test
- [x] ISC-131: With `ZWIFT_*` env absent the feature is dormant: no scheduler entry, no errors, UI panel says not configured, probe: bun test with env unset
- [x] ISC-132: `.env.example` and README document the Zwift vars and the one-time ZwiftPower profile-activation requirement, probe: Read
- [x] ISC-133: Live ZwiftPower fetch with Austin's real credentials succeeds in production, probe: prod sync run (closed 2026-07-17, FOLLOWUP-cadence-zwiftpower-live resolved)

### Training-load engine, TrainingPeaks-equivalent (added 2026-07-17, Austin: "training peaks")
- [x] ISC-134: Settings gain nullable `ftp_watts` and `lthr_bpm`, readable/writable via the settings API, probe: SELECT + curl
- [x] ISC-135: `activities` gains nullable `avg_power`/`norm_power` via guarded ALTER; Garmin sync maps them when the SDK summary carries power, probe: schema read + bun test
- [x] ISC-136: Per-activity training load uses a tiered model: power TSS when power + FTP present, else hrTSS from avg_hr + LTHR, else duration estimate; the tier used is recorded per activity, probe: bun test covering all three tiers
- [x] ISC-137: Power TSS matches the Coggan formula ((dur_s × NP × IF)/(FTP × 3600) × 100) against a published worked example, probe: unit test vector
- [x] ISC-138: Intensity Factor = NP/FTP (falls back to avg power when norm absent, flagged as estimate), probe: bun test
- [x] ISC-139: Fitness (CTL) = 42-day and Fatigue (ATL) = 7-day exponentially weighted averages of daily load, computed over a continuous daily series that includes zero-load days, probe: bun test against hand-computed series
- [x] ISC-140: Form (TSB) = yesterday's Fitness minus yesterday's Fatigue, probe: bun test
- [x] ISC-141: `/api/metrics/training-load` returns the daily series (date, load, fitness, fatigue, form) and is auth-gated, probe: curl 401 + authed shape check
- [x] ISC-142: Dashboard/trends renders a Fitness/Fatigue/Form chart in inline SVG with generic labels (Load, Fitness, Fatigue, Form); Anti: no TrainingPeaks trademark strings (TSS, CTL, ATL, TSB) in user-facing UI text, probe: rg app.html + Interceptor render
- [x] ISC-143: Editing or deleting an activity changes the computed series on next read (no stale cache), probe: bun test edit-then-read
- [x] ISC-144: Missing FTP and LTHR degrades gracefully: duration-tier loads still compute and the UI prompts to set thresholds, probe: bun test + render check
- [x] ISC-145: MCP tool `get_training_load` returns current fitness/fatigue/form and week load, probe: stdio round-trip
- [x] ISC-146: Anti: the metrics engine adds zero runtime dependencies (pure TypeScript); the only new dependency this whole feature block adds is the pinned zwift wrapper, probe: package.json diff
- [x] ISC-147: Daily bucketing is America/New_York DST-safe, consistent with week.ts conventions, probe: bun test DST edge
- [x] ISC-148: Full suite green (`bun test`) and `bunx tsc --noEmit` clean after both modules land, probe: Bash
- [x] ISC-149: Anti: existing dashboard, G1 logic, Garmin sync, stretch tab, and MCP tools behave unchanged (regression suite + spot render), probe: bun test + Interceptor

### Feature roadmap (added 2026-07-17, Austin: "think of 10 more features")
- [x] ISC-150: `ROADMAP.md` at repo root proposes exactly 10 features, each with a rationale and rough effort tag, probe: Read + count
- [x] ISC-151: No roadmap item duplicates shipped work or violates standing exclusions (multi-user, native apps, public health data), probe: cross-read against ISA
- [x] ISC-152: Anti: roadmap contains zero em dashes (writing rule, 2026-07-17), probe: grep

### Quick win 1: one-tap quick log + home-screen install (added 2026-07-17, roadmap item 6)
- [ ] ISC-153: /manifest.webmanifest served 200 with name, short_name, standalone display, start_url /, theme/background colors, icons, probe: curl + JSON shape
- [ ] ISC-154: HTML links manifest, theme-color meta, and apple-touch-icon (iOS ignores manifest icons), probe: grep served HTML
- [ ] ISC-155: Icon PNGs (192, 512, 512-maskable with safe-zone padding, apple-touch 180) generated deterministically by a repo script using Bun with node:zlib deflate (zero deps, no image-gen), each validated to decode (magic bytes + IHDR + inflatable data), served 200, probe: script run + decode test + curl
- [ ] ISC-156: Quick log presets render at the TOP of Dashboard (nap-window rule: install tap to logged in under 10 seconds), probe: Interceptor + DOM order
- [ ] ISC-157: Each preset one-tap creates the right manual activity via the existing activities API (30 min trainer ride, 45 min swim, 15 min ATG stretch), probe: click + API read-back
- [ ] ISC-158: Preset buttons disable during the request (double-submit guard, standing lesson), probe: code + double-click test
- [ ] ISC-159: After logging, a toast with Undo appears; Undo deletes the just-created activity (fat-thumb recovery), probe: Interceptor click undo + API read-back shows row gone
- [ ] ISC-160: Week numbers on the dashboard refresh immediately after a quick log without full reload, probe: Interceptor
- [ ] ISC-161: Installed standalone app with an expired session lands on the login page cleanly (no crash loop, no blank screen), probe: cleared-cookie load of / with manifest display context
- [ ] ISC-162: A minimal no-op passthrough service worker exists SOLELY for Chromium installability (Advisor, 2026-07-17); Anti: zero caching, zero offline logic, zero push, under 15 lines, probe: file read + line count + grep for caches API absence
- [ ] ISC-163: Quick log section single-column usable at 375px, probe: CSS structural check
- [ ] ISC-164: Anti: quick log never counts a stretch preset toward G1 (sport=strength path preserved), probe: bun test

### Quick win 2: consistency heatmap (roadmap item 3)
- [ ] ISC-165: GET /api/metrics/consistency returns per-day training minutes for the trailing 52 weeks plus per-week G1-met flags, auth-gated, single aggregate query, probe: curl 401 + authed shape + code read
- [ ] ISC-166: Heatmap renders on Trends as an inline SVG 52x7 grid, Monday-anchored columns, America/New_York day bucketing consistent with week.ts, probe: Interceptor + bun test DST edge
- [ ] ISC-167: Cell shading scales with minutes; zero-minute days visibly distinct from shaded days, probe: render + code
- [ ] ISC-168: G1-met weeks outlined visually, probe: render with seeded met week
- [ ] ISC-169: Each cell carries a title tooltip with date and minutes, probe: DOM read
- [ ] ISC-170: Renders correctly with Austin's real sparse year (no crash, no visual garbage), probe: Interceptor with real-shape seed
- [ ] ISC-171: Anti: no schema changes for heatmap (pure query), probe: db.ts diff

### Quick win 3: personal records board (roadmap item 2)
- [ ] ISC-172: GET /api/metrics/records returns longest ride, longest-distance ride, fastest avg speed ride (distance floor 10 km), biggest week hours, longest swim, current and longest G1 streak, auth-gated, probe: curl + shape
- [ ] ISC-173: Every record carries its date (motivation needs context), probe: response shape + render
- [ ] ISC-174: Records with no qualifying data return honest empty (his zero swims render as "none yet", never fabricated), probe: live response + render
- [ ] ISC-175: G1 streak counts completed weeks only; the in-progress week never breaks the streak and is shown separately, probe: bun test with mid-week fixture
- [ ] ISC-176: Streak and week logic reuse the existing G1/week helpers, not reimplementations, probe: code read
- [ ] ISC-177: Fastest-speed record excludes zero/absent distance and sub-floor rides, probe: bun test
- [ ] ISC-178: PR board renders on Dashboard below quick log, compact, probe: Interceptor
- [ ] ISC-179: Records update after a new qualifying activity, probe: bun test log-then-read
- [ ] ISC-180: Anti: no schema changes for records (pure query), probe: db.ts diff

### Quick win 4: Monday digest MCP tool (roadmap item 8)
- [ ] ISC-181: MCP tool get_week_digest returns the last COMPLETED Monday-anchored week: sessions/hours vs target, G1 verdict, fitness/fatigue/form now, new PRs that week, races that week, probe: stdio round-trip
- [ ] ISC-182: Digest with a zero-data week returns honest empty, never invents, probe: stdio synthetic
- [ ] ISC-183: Tool appears in MCP tools/list alongside the existing tools, probe: stdio list
- [ ] ISC-184: Anti: digest is read-only, zero writes anywhere, probe: code read
- [ ] ISC-185: WeeklyReview PAI workflow references querying cadence get_week_digest, probe: grep the workflow file
- [ ] ISC-186: Full suite green and bunx tsc --noEmit clean after all four features, probe: Bash
- [ ] ISC-187: Anti: zero new runtime dependencies across all four features, probe: package.json diff
- [ ] ISC-188: Anti: existing views, G1 logic, syncs, and MCP tools behave unchanged, probe: regression suite + spot renders

### Nutrition / Calorie MVP — 2026-07-18 (ISC-189..) — v2 nutrition feature, LLM estimation

**Data model**
- [x] ISC-189: `nutrition_entries` table exists (id, logged_date YYYY-MM-DD, logged_at, description, source CHECK IN ('estimated','manual','edited'), kcal, protein_g, carbs_g, fat_g, notes, created_at, updated_at), probe: PRAGMA table_info
- [x] ISC-190: `nutrition_items` table exists (id, entry_id FK, food, quantity, kcal, protein_g, carbs_g, fat_g), probe: PRAGMA table_info
- [x] ISC-191: `nutrition_target_kcal` (and optional protein target) stored in the existing settings table, seeded with a sane default, editable via PATCH /api/settings, probe: settings read-back
- [x] ISC-192: Migration is idempotent (runMigrations twice on a throwaway DB does not throw or duplicate), probe: bun test
- [x] ISC-193: idx on nutrition_entries(logged_date) and nutrition_items(entry_id) exist, probe: PRAGMA index_list

**Estimation service (server-side LLM)**
- [x] ISC-194: `src/services/nutritionEstimate.ts` turns a free-text meal into itemized {food, quantity, kcal, protein_g, carbs_g, fat_g} via a single fetch to the Anthropic API, key from ANTHROPIC_API_KEY in the box .env, probe: unit test with mocked fetch
- [x] ISC-195: response is hard-parsed and validated (all numeric fields finite and in sane ranges; malformed model output rejected, never partially trusted), probe: unit test feeding malformed JSON
- [x] ISC-196: no key OR estimation failure returns a typed "estimate unavailable" result so the caller falls back to manual entry, NEVER fabricated numbers, probe: unit test with key unset
- [x] ISC-197: Anti: the estimation call uses ANTHROPIC_API_KEY via direct HTTPS fetch, never spawns the `claude` CLI and never uses OAuth billing, probe: grep service for `claude`/spawn/exec
- [x] ISC-198: Anti: zero new runtime npm dependency (fetch only, no @anthropic-ai/sdk), probe: package.json/bun.lock diff empty

**API routes (`src/routes/nutrition.ts`, all behind the existing auth, mirrors activities.ts)**
- [x] ISC-199: POST /api/nutrition/estimate — free text in, itemized estimate out, NOT persisted, probe: curl 200 + DB unchanged
- [x] ISC-200: POST /api/nutrition — save an entry (from an estimate or fully manual) with its items, source set correctly, probe: curl 201 + DB rows
- [x] ISC-201: GET /api/nutrition?date=YYYY-MM-DD — that day's entries + day totals vs target, probe: curl 200 + math
- [x] ISC-202: PATCH /api/nutrition/:id — edit any entry field/number, sets source='edited', updated_at bumped, probe: curl + read-back
- [x] ISC-203: DELETE /api/nutrition/:id — removes entry and its items, probe: curl + DB absence
- [x] ISC-204: all /api/nutrition* routes 401 without a session/bearer, probe: curl -i noauth
- [x] ISC-205: input validation mirrors activities.ts (bad date/negative kcal/oversized text rejected 400), probe: unit tests

**MCP tools (mcp/tools.ts + client.ts, matching log_/get_/edit_/delete_ convention)**
- [x] ISC-206: `log_nutrition` (description text → estimate → save), `get_nutrition_day`, `edit_nutrition`, `delete_nutrition` (confirm=true) tools registered, probe: MCP tool list
- [x] ISC-207: MCP client methods hit the same HTTP API the UI uses (peers over one API), probe: round-trip test log→get→edit→delete
- [x] ISC-208: delete_nutrition requires confirm=true, mirroring delete_activity, probe: MCP call without confirm refused

**Web UI (new Nutrition tab, inline SVG + vanilla JS, no framework)**
- [x] ISC-209: index.html has a `data-view="nutrition"` nav tab and a `view-nutrition` section, probe: grep + Interceptor
- [DEFERRED-VERIFY] ISC-210: the section has a "what did you eat?" text box → estimate → editable itemized rows → save flow, probe: Interceptor
- [DEFERRED-VERIFY] ISC-211: day view shows entries, a calories-vs-target ring (inline SVG) and macro totals, probe: Interceptor
- [DEFERRED-VERIFY] ISC-212: estimated entries carry an "estimated" badge; manual add is always available, probe: Interceptor
- [DEFERRED-VERIFY] ISC-213: matches the existing dashboard visual language (styles.css classes, dark theme), probe: Interceptor

**Separation + safety**
- [x] ISC-214: Anti: nutrition data is structurally separate from `activities` and NEVER feeds the G1 training metric (5 sessions / 8h), probe: grep weekSummary/metrics for nutrition — zero hits
- [x] ISC-215: Anti: nutrition routes inherit the same auth + private-by-construction discipline; no nutrition on any public/unauthenticated surface, probe: route audit
- [x] ISC-216: estimates are always editable and flagged as estimates, so a wrong LLM number is correctable not authoritative, probe: PATCH test + UI badge

**Quality gates**
- [x] ISC-217: new tests cover estimate parse/validation (mocked LLM), the five routes, MCP round-trip, migration idempotency, and day-rollup math, probe: bun test count
- [x] ISC-218: full suite green, bunx tsc --noEmit clean, probe: bun test && bunx tsc --noEmit
- [x] ISC-219: Anti: existing views, G1 logic, syncs, and existing MCP tools behave unchanged, probe: regression suite + spot renders
- [DEFERRED-VERIFY] ISC-220: live LLM estimation against the real Anthropic API confirmed once ANTHROPIC_API_KEY is set on the box (build/tests use a mock) — FOLLOWUP-cadence-nutrition-live-estimate

### Whimsical rebrand, Mikkeller x Erstwhile (added 2026-07-19, Austin: "more whimsical and take inspiration from mikkeller beer and erstwhile brand")
- [x] ISC-221: styles.css defines a warm cream canvas variable and body background uses it, probe: grep cream var in styles.css
- [x] ISC-222: at least 4 flat accent color variables (coral, mustard, teal, cobalt) defined in :root, probe: grep :root block
- [x] ISC-223: old corporate evergreen palette fully gone from styles.css (#0B3D2E, #2BB673, #1E7A50 all zero hits), probe: grep count 0
- [x] ISC-224: cards and buttons carry the flat-label look, 2px ink borders plus hard offset shadow, probe: grep box-shadow offset pattern
- [x] ISC-225: nav tabs take per-view flat accent colors when active, probe: grep nav-tab data-view rules
- [x] ISC-226: hand-authored flat-style mascot SVG (long-nosed character in motion) present in index.html topbar, probe: grep mascot svg
- [x] ISC-227: login card carries the mascot and playful sub-copy, probe: grep index.html login block
- [x] ISC-228: chart, heatmap, and ring colors in app.js moved to the new palette with zero old-palette hexes, probe: grep count 0 in app.js
- [x] ISC-229: legend swatches in index.html match the new chart colors, probe: grep legend swatch hexes
- [x] ISC-230: manifest background_color and theme_color updated to the new palette, probe: Read manifest
- [x] ISC-231: meta theme-color in index.html matches manifest theme_color, probe: grep meta theme-color
- [ ] ISC-232: [DROPPED, see Decisions 2026-07-19: sw.js is a deliberate no-op passthrough with zero Cache storage, so no cache version exists to bump and no staleness risk exists]
- [x] ISC-233: 375px media query preserved and still covers the restyled elements, probe: grep @media in styles.css
- [x] ISC-234: full test suite green after restyle, probe: bun test
- [x] ISC-235: bunx tsc --noEmit clean, probe: Bash
- [x] ISC-236: local throwaway-instance browser render shows the new theme on login and dashboard, probe: Interceptor screenshots
- [x] ISC-237: Anti: app.js diff touches only color and style string values, zero behavioral changes, probe: git diff inspection
- [x] ISC-238: Anti: no new dependencies, no new font files, no external asset requests introduced, probe: git diff package.json plus grep for external URLs
- [x] ISC-239: Anti: chart and data legibility preserved, dark ink text on light grounds throughout, probe: screenshot inspection
- [x] ISC-240: Antecedent: whimsy carried by at least three concrete devices (mascot character, flat label-style cards with offset shadows, per-view color coding), probe: grep each device
- [x] ISC-241: all text-on-fill color pairs meet WCAG AA 4.5:1 (advisor-prompted), probe: computed luminance script, failing teal and sage tab fills darkened to 5.86 and 5.79
- [x] ISC-242: PWA PNG icons regenerated in the new brand via bin/generate-icons.ts (advisor-prompted), probe: md5 change plus visual read of icon-192

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| 1-10 | schema/unit | bun test on migrations + helpers | green | Bash |
| 11-23 | auth | bun test sweep + curl headers | green, byte-equal bodies | Bash |
| 24-35 | integration | mocked Garmin client tests; live probe deferred (ISC-33) | green | Bash |
| 36-47 | api | bun test per route | green | Bash |
| 48-59 | ui | Interceptor walkthrough + screenshots | flows complete | Interceptor |
| 60-72 | mcp | stdio handshake + tool calls in tests | green | Bash |
| 73-85 | deploy | ssh probes, curl, dig, systemctl | all live | Bash |
| 86-93 | quality | bun test, tsc, greps | 0 fail / 0 errors | Bash |
| 94-98 | live | prod walkthrough + MCP round-trip + cleanup | complete | Interceptor/MCP |
| 104-117 | feature | data/SVG probes, bun test, Interceptor walkthrough, deploy check | green + flows complete | Bash/Interceptor |
| 221-240 | design/ui | palette greps, bun test, tsc, Interceptor screenshots | 0 old-palette hexes, suite green, renders legible | Bash/Interceptor |

## Features

| name | description | satisfies | depends_on | parallelizable |
|------|-------------|-----------|------------|----------------|
| data-spine | schema, migrations, settings, sync_runs | ISC-1..10 | — | false |
| auth | single-user login, sessions, lockout, bearer tokens, CLIs | ISC-11..23 | data-spine | false |
| garmin-sync | client probe, sync engine, merge policy, scheduler | ISC-24..35 | data-spine | false |
| api | activities CRUD, week, trends, settings, sync routes | ISC-36..47 | auth, data-spine | false |
| web-ui | dashboard, list, forms, trends, brand skin | ISC-48..59 | api | false |
| mcp-server | stdio server, 8 tools, registration | ISC-60..72 | api | false |
| deploy | DNS, Caddy, systemd, env, nav link, live checks | ISC-73..85 | web-ui, mcp-server | false |
| verification | suites, walkthroughs, prod round-trip, cleanup | ISC-86..98 | all | false |
| stretch-plan | ATG daily stretching tab: plan data, 8 SVG illustrations, log-session button | ISC-104..117 | web-ui, api | true (SVGs and code build in parallel) |
| zwiftpower-sync | ZwiftPower race results + category sync via pinned wrapper, isolated module, dormant without creds | ISC-118..133 | api, web-ui | true |
| training-load | Native TSS-tier load engine + Fitness/Fatigue/Form series, endpoint, chart, MCP tool | ISC-134..149 | garmin-sync, web-ui | true |
| roadmap | 10-feature ROADMAP.md from BeCreative ideation | ISC-150..152 | none | true |
| quick-log-install | Web manifest + generated PNG icons + one-tap presets with undo | ISC-153..164 | web-ui, api | true |
| consistency-heatmap | 52-week Monday-anchored SVG heatmap with G1 outlines | ISC-165..171 | api, web-ui | true |
| pr-board | Records endpoint + dashboard board with dates and streaks | ISC-172..180 | api, web-ui | true |
| week-digest | get_week_digest MCP tool + WeeklyReview wiring | ISC-181..188 | mcp | true |
| whimsy-rebrand | Mikkeller x Erstwhile visual identity: cream canvas, flat accents, mascot SVG, label-style cards | ISC-221..240 | web-ui | false |

## Decisions

- 2026-07-19 — **Whimsical rebrand (ISC-221..240), brand interpretation.** Austin asked for "more whimsical... inspiration from mikkeller beer and erstwhile brand." Mikkeller grounding is source-verified this session: Keith Shore's flat, bold, retina-tingling label art with long-nosed characters (mikkeller.com/art, itsnicethat.com). "Erstwhile" is ambiguous; the best craft-beverage match is Erstwhile Mezcal, whose site (fetched this session) shows warm cream grounds, earthy charcoal, and understated artisanal type. Synthesis chosen: Erstwhile supplies the warm cream canvas and restraint, Mikkeller supplies flat punchy accents, a hand-drawn mascot, and label-poster card styling. The Erstwhile assumption is flagged to Austin in the summary; if he meant a different Erstwhile, the accent layer stays valid and only the ground tone would shift. Styling only: zero behavioral JS changes, zero new deps, PWA cache version bumped so installed clients pick up the restyle.
- 2026-07-19 — **Advisor round outcomes (whimsy rebrand).** Advisor raised five points: (1) Erstwhile could also read as Erstwhile Jewelry (vintage/handmade), not just Erstwhile Mezcal; work proceeds on the beverage reading with the question surfaced to Austin, and the cream/artisanal ground is compatible with both. (2) PWA icons still evergreen: FIXED, generate-icons.ts constants rebranded and all four PNGs regenerated (ISC-242). (3) Verification depth: three tabs plus one live interaction were exercised; full per-view sweep and phone-width check remain in the standing FOLLOWUP-cadence-ui-pass. (4) Contrast: FIXED via measured WCAG script, two tab fills darkened (ISC-241). (5) Advisor's "wrong ISA" warning was its own --auto-state reading a stale work.json from another session; this run's edits target the Cadence project ISA directly.
- 2026-07-19 — **ISC-232 dropped (sw.js cache bump).** Conjectured during OBSERVE that the service worker would serve stale CSS after deploy. Reading sw.js refuted it: the worker is a deliberate no-op passthrough (ISC-162 design) with zero Cache storage, so there is no cache to version and no staleness risk. Tombstoned per ID-stability.
- 2026-07-19 — **Delegation floor relaxed at E2 (show-your-math).** The un-selected delegation (an Engineer agent restyling the same three files) would have required a taste-level brief longer than the diff itself, and taste iteration through an agent doubles latency. Single-author pass by primary; verification still runs the full suite plus Interceptor render.
- 2026-07-18 — **Nutrition / calorie MVP (ISC-189..220) — moves nutrition from Out-of-Scope v2 candidate into scope, on Austin's request "add a calorie counter... I give food I ate and the app finds estimated nutrients and calories and inputs them in."** After a plan presented three estimation mechanisms (server-side LLM / nutrition database API / DA-only-via-MCP), Austin chose **LLM estimation**. Rationale for the recommendation he took: LLM estimation is the exact "give free text, get nutrients" UX and it survives how people actually describe food (compound, homemade, restaurant) far better than USDA/Nutritionix food-name matching, which is where DB-lookup nutrition trackers get frustrating; Cadence is single-user (Austin's own use) so an ANTHROPIC_API_KEY on the box is appropriate and per-entry cost is negligible. Load-bearing calls: (1) estimation is a direct HTTPS `fetch` to the Anthropic API keyed by `ANTHROPIC_API_KEY` in the box .env — NEVER the `claude` CLI and never OAuth billing (single-user app-side API call, ISC-197), and NO new npm dep (fetch, not @anthropic-ai/sdk, preserving Cadence's zero-dep-beyond-Garmin/MCP constraint, ISC-198). (2) Every estimate is itemized (`nutrition_items`) and fully editable, flagged `estimated`, so a wrong LLM number is correctable not authoritative (ISC-216) — the "truth over decoration" principle applied to estimates. (3) No key or a bad model response falls back to manual entry and NEVER fabricates numbers (ISC-196), mirroring the Garmin-outage CSV survival path. (4) Nutrition is structurally separate from `activities` and never feeds the G1 5-sessions/8h training metric (ISC-214), the same isolation discipline that kept comments out of scoring in Suretas. Web UI and MCP are peers over one API (log_nutrition/get_nutrition_day/edit/delete). Builder: Sonnet Engineer agent (codex absent → Forge-slot fallback), then primary independent verification. Live LLM estimation is DEFERRED-VERIFY (ISC-220) until the key is on the box; build + tests use a mocked fetch. NOT deployed — gated on Austin's go AND setting ANTHROPIC_API_KEY on the box.
- 2026-07-16T19:50Z — Scope set by Austin via AskUserQuestion: hosted "in my personal website... with a login" → fit.austinfiala.com subdomain on the existing box, linked from the site nav (a path under the static site would force base-path handling and a mixed Caddy block; a subdomain keeps both sites clean — flagged to Austin in the summary). Nutrition/MFP: skipped for v1, his call. Garmin auth: "decide for me" → MFA-capable library with token persistence, credentials in box .env only. Python: not approved; TypeScript only, blockers come back to him.
- 2026-07-16T19:50Z — Zwift integration is DELIBERATELY indirect: Zwift auto-uploads completed rides to Garmin Connect when linked (verified via Zwift/Garmin support + community docs 2026-07-16), so one Garmin integration covers Zwift + outdoor rides + swims. Direct Zwift API is unofficial, unstable, and adds nothing once linking is on.
- 2026-07-16T19:50Z — ISC floor math (E4 soft ≥128): natural granularity yielded 103 atomic ISCs (98 + 5 advisor-driven). Shown math rather than padded: v1 has ONE integration (nutrition deferred by Austin's answer), one user (no RBAC surface), and no payment/email subsystems — the domains that inflate counts in comparable apps are structurally absent. Every ISC above is one tool probe; splitting further would manufacture rows, not tests.
- 2026-07-16T20:05Z — Advisor pre-build review (Rule 2): confirmed the one-resident-service topology (MCP spawned on demand on Austin's machine, sync in-process — the box gains exactly one daemon); added ISC-99 (CSV import survival path for when the unofficial Garmin lib breaks — and they do break), ISC-100 (lib isolated to src/garmin/), ISC-101 (exact version pin), ISC-102 (lockout self-DoS escape: auto-expiry + CLI clear), ISC-103 (anti: no extra daemons). Token-scoping suggestion partially adopted: the bearer token is already separately issued, hashed, and revocable (ISC-20/21) which covers rotate-without-password; per-tool scoping rejected as over-engineering for a single-user personal app. Advisor's state-mismatch warning was an --auto-state artifact (it read the previous task's ISA); the builder receives this file's absolute path pinned verbatim.
- 2026-07-16T19:50Z — Delegation: Engineer agent builds from this ISA (session-standard; codex absent → `SOURCE: codex-unavailable`, Forge slot falls back to Engineer). Primary (me) does independent verification, deploy, DNS/Caddy surgery on the shared box, and the MCP registration on this machine.
- 2026-07-17T19:55Z: Quick wins build (Austin: "build the quick wins from the roadmap", items 6/3/2/8). IterativeDepth 2-lens pass added undo-toast, programmatic PNG icons, standalone-expired-session, streak in-progress-week, presets-on-top, and PR-date criteria. Advisor (Rule 2) reversed the no-service-worker call: Chromium installability wants one, so a sub-15-line no-op passthrough SW ships with caching/offline still banned (ISC-162 amended); also forced maskable 512 icon, one shared timezone/week bucketing helper across all four features, undo by returned activity id never most-recent, and node:zlib for the PNG deflate with decode validation. Streak rule pinned: consecutive COMPLETED Monday-anchored weeks meeting both G1 targets; zero-activity completed weeks break it; in-progress week displayed separately, never counted either way. codex re-probed absent, Engineer covers the Forge slot; single write-agent (shared Dashboard/server surfaces).
- 2026-07-17T18:10Z: ZwiftPower + TrainingPeaks connections (Austin: "Build connections to zwiftpower, training peaks, and think of 10 more features"). TrainingPeaks pivot: their API is partner-only, not for personal use, AND paused for all new partners as of July 2026 (verified this session via WebSearch of help.trainingpeaks.com and api.trainingpeaks.com/request-access). A direct TP connection is structurally impossible, so the TP deliverable is a native training-load engine (tiered TSS, Fitness/Fatigue/Form EWMAs) computed from data already in the app. Anyone wanting data inside TP itself uses TP's own consumer Garmin auto-sync. ZwiftPower path: `@codingwithspike/zwift-api-wrapper@0.0.9` chosen by registry probe this session, sole runtime dep is tough-cookie (pure JS), passing the zero-native-modules gate from the Garmin swap lesson; its ZwiftPowerAPI class does Zwift SSO auth and exposes authenticated ZwiftPower fetches. Advisor (Rule 2) confirmed the TP pivot and forced two design changes adopted as ISCs: FTP/LTHR must be user settings (ISC-134) since no power stream exists in our schema (confirmed: activities has only avg_hr, no power columns), and EWMAs must include zero-load days (ISC-139); also fixture-only tests (ISC-129) and generic metric labels over TP trademarks (ISC-142). `SOURCE: codex-unavailable` re-probed this session, Forge slot falls back to Engineer. Delegation floor math (soft, 1 of 2): both modules share server.ts/app.html/db.ts, so a second parallel write-agent means worktree merge overhead exceeding its value; one Engineer builds sequentially while the primary runs ideation.
- 2026-07-16T23:28Z — Stretch plan (Austin: "build a daily stretching plan based off of the kneesovertoes guy, create images for it, add it to the fitness app"). Content grounded in fetched sources this session (a1athlete.com ATG stretch guide; Ben Patrick's own TikTok note that couch stretch belongs AFTER ATG split squat; search-corroborated doses: pancake pulses ×20, couch 45-60s/side, elephant walk ×20). Out of Scope amended (fixed plan in, adaptive coaching still out). Images: hand-authored SVG — probed this session: no image-gen keys on this box (KNOWLEDGE/Research/linux-machine-image-gen-gap.md still accurate). Log-as-activity uses sport=strength (isG1Qualifying filters to cycling/swim family, so G1 stays clean — ISC-109 tests it). Deploy gated on Austin's explicit approval per Permission Boundaries; everything staged ready. `SOURCE: codex-unavailable` re-probed this session — Forge slot again falls back to Engineer.
- 2026-07-17 (build): garmin-connect-sdk power fields for ISC-135. The SDK's `activitySummarySchema` is a zod object in `passthrough` mode and declares NO power fields (grep of dist/index.d.ts: only `type: 'power'` on an unrelated union and a `powerSamples` count elsewhere, neither an activity-summary average/normalized power). So the SDK exposes nothing typed, but passthrough preserves any raw Garmin summary keys that ARE returned. Decision: `src/garmin/client.ts` reads `avgPower`/`averagePower` and `normPower`/`normalizedPower`/`normPowerBike` defensively off the raw object, mapping to the new nullable `avg_power`/`norm_power` columns, and leaves them null when absent. This cannot be confirmed against a real power-meter activity until Austin's Garmin creds are live (rides in his account so far are HR-only anyway), so the mapping is best-effort by documented field name and the load engine's HR/duration tiers carry the common case. If a live sync later shows power under a different key, it is a one-line change in that adapter.
- 2026-07-17 (build): training-load formula choices (native, zero-dep, ISC-146). Power load is the Coggan TSS identity `TSS = dur_s * NP^2 / (FTP^2 * 3600) * 100` (equivalently `(dur_s * NP * IF)/(FTP*3600)*100` with `IF = NP/FTP`), anchored by the published definition that one hour at exactly FTP scores 100 (unit vector). HR load is the standard hrTSS analogue `dur_h * (avgHR/LTHR)^2 * 100`. The duration-only fallback assumes a moderate `IF = 0.70` (documented constant `DURATION_TIER_IF`), so a duration-tier hour scores 49; chosen so a rest-day-free steady session still produces an honest, explainable number rather than zero. Fitness/Fatigue/Form use the classic impulse-response recurrence `today = yesterday + (load - yesterday)/tc` with tc 42 (Fitness) and 7 (Fatigue) over a continuous daily series that includes zero-load days, seeded at 0; Form is yesterday's Fitness minus yesterday's Fatigue. Series are recomputed from the DB on every read (no cache), so edits/deletes are reflected immediately (ISC-143). Trademark strings (TSS/CTL/ATL/TSB) live only in code identifiers and comments, never in user-facing UI text (ISC-142, grep-verified on served bytes).
- 2026-07-17 (build): ZwiftPower access shape probed from the wrapper's compiled surface. `ZwiftPowerAPI(username, password).authenticate(cookies?)` drives the Zwift SSO login and returns a serialized tough-cookie jar (JSON string); passing that string back reuses a still-valid session. Rider results come from `getActivityResults(profileId)` which hits `https://zwiftpower.com/cache3/profile/{profileId}_all.json` (the "rider's own results" community endpoint), returning DataTables-style rows where numeric fields are `[value, sortKey]` tuples (np, avg_power, time read from element 0; category/pos/event_title/event_date scalar). A `ZWIFT_PROFILE_ID` env var supplies the numeric profile id (documented in .env.example). Session jar persisted to a mode-600 file (ISC-130) via the client, not the wrapper. All wrapper usage isolated to `src/zwiftpower/client.ts` (ISC-118), so a swap is one file. Zero-native-modules gate re-verified after install: `find node_modules -name '*.node'` empty (ISC-119).

## Verification

### Whimsy rebrand verification round (2026-07-19, ISC-221..242)

- ISC-221..225, 228..231, 233: grep probes all green in one sweep: zero old-palette hexes across styles.css/app.js/index.html/manifest (CLEAN), 45 new-palette var references, 23 offset-shadow rules, 7 per-view tab rules, F6EEDC in manifest and meta theme-color, @media 480px intact.
- ISC-226/227: `cadence-mascot` appears 3x in index.html (defs + topbar use + login use); mascot visually confirmed in login and topbar screenshots.
- ISC-232: DROPPED. Read of sw.js refuted the caching premise (no-op passthrough, no Cache API); C/R/L entry in Changelog.
- ISC-234/235: 194 pass / 0 fail (three runs during the session), tsc --noEmit exit 0.
- ISC-236/239/240: Interceptor screenshots on a throwaway instance (port 4199, scratch DB): login (coral field, cream card, mascot), dashboard (label cards, mustard day dot after live preset click, ink toast with mustard Undo, PR recorded), Stretch (blush shadows, dash-free copy, single-line buttons), Trends (new chart legend palette, cobalt active tab), Activities (deep-teal active tab, form, mustard MANUAL badge). One real interaction exercised end to end (preset log 202 + UI update). Screenshots deleted after review; evidence recorded here.
- ISC-237/238: git diff shows app.js changed only in 16 color/copy string pairs plus one dose string; package.json/bun.lock diff empty; fonts dir unchanged at 6 files; no external URLs beyond xmlns.
- ISC-241: WCAG luminance script (scratchpad) measured every text-on-fill pair; failures teal 4.16 and sage 3.61 fixed to #15705A (5.86) and #556B33 (5.79); all others 4.63..13.70.
- ISC-242: icons regenerated (all four PNGs, md5 mismatch vs before), icon-192 visually read: coral rounded square, cream C.
- Dash rule sweep: index.html + styles.css dash-free; generated gap_message and stretch dose de-dashed (weekSummary.ts, app.js); pre-existing code comments left as is.

### Nutrition MVP (ISC-189..220) — 2026-07-18

- Full suite **194 pass / 0 fail**, `bunx tsc --noEmit` clean, `git diff package.json bun.lock` empty (no new dep). Nutrition-specific tests: 34 pass (estimate parse/validation with mocked fetch incl. no-key/malformed/out-of-range, the five routes incl. 401-noauth and estimate-not-persisted, MCP round-trip, migration idempotency, day-rollup math, edit recomputes-totals-sets-source=edited).
- Live boot probe (throwaway DB, port 4199): server boots clean with nutrition mounted; `GET /api/nutrition` and `POST /api/nutrition/estimate` → 401 without auth (ISC-204); existing `GET /api/week` still 401 (no regression); `data-view="nutrition"` present in served index.html (ISC-209); both nutrition tables created and `nutrition_target_kcal`=2200 / `nutrition_target_protein_g`=150 seeded.
- ISC-197/198 (billing/dep isolation): estimation service imports nothing, uses `fetch` only, no `claude` CLI / spawn / exec / OAuth / `@anthropic-ai/sdk`; key strictly from `ANTHROPIC_API_KEY`. ISC-214 (G1 separation): grep confirms zero nutrition references in weekSummary.ts / metrics.ts / week.ts.
- ISC-216/totals: entry totals recomputed from items inside a single `db.transaction` on save and edit; edit sets source='edited'; test asserts it. logged_date uses `nyDateString` (America/New_York), matching the app's DST-safe week spine, so a late-evening entry lands on the correct local day.
- Advisor pass (Rule 2) run before completion. Its three catches: (a) day-boundary TZ — already correct (`nyDateString`); (c) totals-drift — already recomputed-in-transaction with a test; (b) the one real gap, no fetch timeout — **fixed**: added `AbortSignal.timeout(15000)` on the estimation fetch (single attempt, no retry storm; a hung call fails to `llm_error` → manual fallback). Input already capped at 2000 chars (`DESCRIPTION_MAX`).
- ISC-210/211/212/213 UI-render and ISC-220 live-LLM are DEFERRED-VERIFY: FOLLOWUP-cadence-nutrition-browser-walkthrough (authed Interceptor pass) and FOLLOWUP-cadence-nutrition-live-estimate (real Anthropic call once ANTHROPIC_API_KEY is on the box).

**NOT committed (deliberate).** The nutrition work is complete and verified in the working tree, but the Cadence tree already held a pile of UNCOMMITTED prior-session work (modified `src/routes/metrics.ts` + `src/week.ts`, and untracked `src/metrics/consistency.ts`/`digest.ts`/`records.ts`, a PWA: `public/sw.js`/`manifest.webmanifest`/icons + `bin/generate-icons.ts` + `src/lib/png.ts`, and their tests) intermixed with nutrition in shared files (`server.ts`, `db.ts`, test fixtures). A clean nutrition-only commit is not possible without either bundling that unverified prior work under a nutrition message or fragilely splitting hunks, so the commit decision is deferred to Austin. Deploy is separately gated on his go AND setting `ANTHROPIC_API_KEY` on the box.

### Primary-agent verification round (2026-07-16, post-build)
- ISC-73..85: pushed nothing (local repo, no remote yet); /opt/cadence created, clean git-archive rsync, `bun install --production` (237 pkgs), .env mode 600 with generated SESSION_SECRET, systemd unit enabled+active, DNS A record live on authoritative NS, Caddy block appended after timestamped backup + validate + RELOAD, all three sites healthy after (suretas /health 200, austinfiala 200, fit /health 200 over valid TLS), Fitness footer link live on austinfiala.com, no secrets in git history (new repo, .env gitignored from first commit), box has 125MB available with all services active.
- ISC-95: real prod login as arfiala@gmail.com via Interceptor — dashboard rendered, logged out after.
- ISC-96/98: MCP stdio round-trip against prod — 8 tools listed, get_goal_progress returned the G1 gap line, log_activity created row id 1, delete refused without confirm=true then deleted with it, list confirmed clean after.
- ISC-70: ~/.claude/.mcp.json registers `cadence` (stdio, env-wired); handshake + tool calls proven by the round-trip driver.
- ISC-48/49/50/54/55/58: local walkthrough — dashboard gap line ("1 sessions, 0.8 h — need 4 more..."), list with MANUAL badge, add-form round-trip (45min/1.8km swim persisted as 2700s/1800m), unauthenticated / serves only the login form, brand fonts/palette rendered; escapeHtml verified by grep.
- ISC-97: TRAINING_LOG.md carries the supersession pointer to Cadence + MCP.
- DEFERRED (FOLLOWUP-cadence-ui-pass): ISC-51/52/53/56/59/94 — edit/delete via UI, trends view, sync button, 375px, session-expiry redirect, full click-through in one pass. DEFERRED (FOLLOWUP-cadence-live-garmin): ISC-29/33 — need Austin's Garmin credentials in /opt/cadence/.env, then one manual sync verifies both.

### Stretch-plan verification round (2026-07-17, commit b980e5b)
- ISC-104/105: Interceptor walkthrough on throwaway instance (port 4199, temp DB) — Stretch tab in nav, all 8 cards rendered in ATG order with name/dose/target/cue; full-page screenshot reviewed.
- ISC-106: all 8 SVGs → `200 image/svg+xml` over HTTP; encoded (`..%2f`) and `--path-as-is` traversal probes fall through to the HTML app shell, never a composed file path; charset-reject tested in suite.
- ISC-107: refined grep — zero fetchable external refs (only xmlns namespace URIs; first grep false-positived on xmlns).
- ISC-108: button click → API read-back showed exact row (sport=strength, duration_s=900, title "ATG Daily Stretch").
- ISC-109: bun test (isG1Qualifying + weekSummary) AND live dashboard after logging: "0 sessions, 0 h — need 5 more" — G1 unpolluted.
- ISC-110: `stretchLogInFlight` + `btn.disabled` with `finally` re-enable (code read); pre-click guard confirmed.
- ISC-111: fresh page load → Stretch tab shows "✓ Logged today" (API-derived, reload-proof).
- ISC-112/113: git diff on package.json/bun.lock empty; no schema changes (db.ts untouched).
- ISC-114: 97 pass / 0 fail (233 expects), tsc clean — run independently by primary, not just builder-reported.
- ISC-115: structural — .stretch-list flex column, img max-width 100%, 480px breakpoint rules; phone screenshot rides FOLLOWUP-cadence-ui-pass.
- ISC-116: Dashboard/Activities/Trends/Sync all rendered post-change in the same walkthrough.
- Cleanup: throwaway DB + WAL + log deleted, verify server killed by port-matched PID, session screenshots removed, Interceptor tab closed.
- ISC-117: DEPLOYED 2026-07-17 on Austin's "deploy" — pre-deploy DB backup (`~/db-backups/cadence-pre-stretch-20260717T122315.db`), clean git-archive rsync (no --delete, .env untouched), `sudo systemctl restart cadence` → active. Live-verified: /health 200, all 8 SVGs 200 over HTTPS, "data-view=stretch" + disclaimer in served bytes, Interceptor render of the full 8-card tab on fit.austinfiala.com through Austin's real session (log button deliberately NOT clicked — no synthetic data in prod), suretas.com + austinfiala.com both 200 after restart.

### Primary-agent independent verification round (2026-07-17, ZwiftPower + training-load)
- Suite and types re-run by primary, not builder-reported: 126 pass / 0 fail (298 expects), bunx tsc --noEmit clean.
- ISC-119: find node_modules -name '*.node' returned zero results.
- ISC-142 anti: grep of all public/ bytes for TSS, CTL, ATL, TSB word-bounded returned zero matches.
- ISC-126/131/144 UI: Interceptor walkthrough on a throwaway instance (port 4199, temp DB, real Chrome, real clicks): Races tab rendered the not-connected panel naming the three env vars; Trends rendered the Fitness/Fatigue/Form stat row, chart with Load/Fitness/Fatigue/Form legend, honest empty state, and the set-thresholds prompt. Screenshots reviewed by primary.
- ISC-134 end to end: typed 250/165 into the threshold form, clicked Save, DB read-back showed ftp_watts=250 and lthr_bpm=165.
- Advisor final audit cross-checked in code: Coggan golden vector test (1h at FTP scores exactly 100, plus IF 0.7 case scoring 49), hand-computed 3-day EWMA series including a zero-load rest day, and a sync-same-result-twice idempotency test all confirmed present in test files by grep.
- Builder stall recovered: the Engineer stopped after the backend; resumed via message with a precise gap list (UI layer, docs, ISA marks, commits, and a missing dedicated metrics test file caught by primary grep before resume). All gaps closed in the resumed pass.
- Throwaway instance, temp DB, and screenshots deleted after verification; both leftover local test servers killed; production untouched.
- 2026-07-17T18:45Z Decisions addendum: ZwiftPower access is an unofficial community endpoint via the wrapper with Austin's own Zwift credentials, the same accepted-risk class as the unofficial Garmin library already in production. Surfaced to Austin explicitly in the session report; his creds-in-.env step is also his acceptance gate, since the feature stays dormant without them.

### Deploy verification round (2026-07-17, commit dcb31bd live)
- DEPLOYED on Austin's "deploy": WAL-safe backup cadence-pre-zwiftpower-20260717T185530.db (VACUUM INTO via bun on box), clean git-archive rsync without --delete, first-ever on-box bun install for the new wrapper (12 packages, 0 native modules confirmed on the instance), systemctl restart, service active.
- Live-verified: fit.austinfiala.com/health 200, suretas.com/health 200, austinfiala.com 200, new app.js bytes carry Races/training-load markers, /api/metrics/training-load and /api/zwiftpower/results both 401 unauthenticated, zwiftpower_results table + avg_power/norm_power columns present in prod DB, activities count unchanged (1) so no data was touched.
- Live Interceptor render through Austin's real session: Races tab not-connected panel with env guidance, Trends computing real values from his data (Fitness 0.3, Fatigue 1.7, week load 12.2). Render-only, no data-creating clicks. Cosmetic follow-up noted in deploy/NOTES.md: sparse-data load chart draws a wide block.
- deploy/NOTES.md bootstrapped this session (Deploy skill Invariant 6: notes were missing; method, secrets names, smoke set, and gotchas now documented in-repo).

### Garmin live sync round (2026-07-17, ISC-29 + ISC-33 closed, FOLLOWUP-cadence-live-garmin resolved)
- MFA dance per the documented two-login procedure: trigger login sent a fresh code (prior 17:21Z scheduler attempt's code was stale; rate-limit window confirmed clear after ~1h53m quiet), Austin supplied the code in-session, GARMIN_MFA_CODE set, restart, session-establishing sync: 50 activities seen / 50 new. Code then scrubbed from .env (grep 0), restart, and a no-code re-sync succeeded: 50 seen / 0 new, proving token reuse AND live idempotency in one probe.
- Token persistence: /opt/cadence/garmin-tokens exists drwx------ ubuntu (ISC-29).
- Data audit: 51 activities total (50 Garmin + 1 manual), spanning a full year; 23 virtual_cycling (Zwift→Garmin link already active, nothing for Austin to do), 10 running, 3 cycling, 1 strength, 14 other. The 14 "other" are all raw_type walking, correctly mapped; zero swims exist in his Garmin year, so no G1 mapping bug. 35 activities carry real power data.
- Live render: dashboard week now shows 4 sessions / 3.9 h with the honest G1 gap line; Trends draws real daily load bars with Fitness 16.5 / Fatigue 25.8 / Form -5.7 / week 213.8. The sparse-data wide-block chart cosmetic from the deploy round is resolved by real data; no code change was needed.

### ZwiftPower live verification round (2026-07-17, ISC-133 closed)
- Austin provided Zwift credentials in-session; appended to /opt/cadence/.env via ssh stdin (never written locally, never in git), perms re-confirmed 600 ubuntu.
- Profile ID discovered for him: one-shot on-box script via the wrapper's ZwiftAPI.getProfile("me") returned status 200, id 8342103, name Austin Fiala. Single login only (Garmin rate-limit lesson respected); ZWIFT_PROFILE_ID=8342103 set, service restarted, health 200.
- ISC-133: POST /api/zwiftpower/sync (bearer token) returned success with results_seen 7, results_new 7 in 2.9s; GET /results returned all 7 real races (Tour Fever stages, Level Up Racing series, categories A/D/E with positions and power); sync_runs row recorded. His ZwiftPower profile was already activated, so no manual activation step was needed.
- Live Interceptor render: Races tab shows the sync status line (success, 7 new / 7 seen) and all 7 result rows with category badges. Screenshot reviewed, then deleted.

### Roadmap verification round (2026-07-17)
- ISC-150: Read + rg count, exactly 10 `## N` feature sections in ROADMAP.md, each with rationale and S/M/L effort tag.
- ISC-151: cross-read against ISA exclusions, no multi-user, no native app (item 6 is a web manifest, explicitly not native), no public health exposure; item 10 restates the nutrition deferral rather than violating it.
- ISC-152: `rg -c "—|–" ROADMAP.md` returned zero matches.

### ZwiftPower + training-load verification round (2026-07-17)
- ISC-118: `package.json` pins `@codingwithspike/zwift-api-wrapper: "0.0.9"` exact (no caret); `rg -l zwift-api-wrapper` over src/ and mcp/ matches only `src/zwiftpower/client.ts`, so all wrapper usage is isolated to that one file.
- ISC-119: `find node_modules -name '*.node'` returned empty after install (sole transitive dep is tough-cookie, pure JS). Hard gate PASS.
- ISC-120: Zwift creds read only from env in `src/zwiftpower/config.ts`; `rg` shows no credential values in git or DB writes; bun test asserts `getZwiftPowerConfig` errors and `ZwiftPowerSyncError` messages contain no secret, and a console-capture test proves `runZpSyncOnce` logs nothing on failure.
- ISC-121: `zwiftpower_results` table created via CREATE TABLE IF NOT EXISTS (guarded, double-run safe alongside the schema idempotent-migration test); columns event_id UNIQUE, event_date, title, category, position, avg_power, norm_power, time_s.
- ISC-122: bun test, syncing the same result twice yields one row and results_new 0.
- ISC-123: bun test, a category "B" result stores category=B; a null-category result stores NULL not "".
- ISC-124: bun test, a failing mock client records an errored `zwiftpower_sync_runs` row (status=error, finished_at set) and never throws.
- ISC-125: live curl on a throwaway instance, `POST /api/zwiftpower/sync` unauthenticated returned 401.
- ISC-126: served `index.html` carries `data-view="races"` and the Races view; `app.js` renders each result (date, event, category, position) reusing the activity-item conventions; verified in the served bytes on the throwaway instance.
- ISC-127: MCP tool set is now exactly 10 (bun test updated), `get_race_results` registered and wired to `GET /api/zwiftpower/results` via the thin CadenceClient (no SQL in mcp/).
- ISC-128: bun test, a ZwiftPower sync leaves the activities table at count 0.
- ISC-129: no test performs a live login, all use mock `ZwiftPowerClient`; a test asserts `isZwiftPowerConfigured({})` is false, proving the test env carries no creds.
- ISC-130: `src/zwiftpower/client.ts` persists the serialized cookie jar to a mode-600 file (writeFileSync mode 0o600 + chmodSync) and reuses it via `authenticate(cookies)`.
- ISC-131: `server.ts` only calls `startZpScheduler` when `isZwiftPowerConfigured()`; live curl showed `GET /api/zwiftpower/results` = `{"configured":false,"results":[]}` and `POST /api/zwiftpower/sync` returned a clean `{"triggered":false,"configured":false}` with no error; the Races tab shows the not-connected panel.
- ISC-132: `.env.example` documents ZWIFT_USERNAME/PASSWORD/PROFILE_ID/COOKIE_PATH plus the one-time profile-activation note; README gained a "ZwiftPower race results" section covering the same and the activation requirement.
- ISC-133: DEFERRED-VERIFY, needs Austin's real Zwift credentials in `/opt/cadence/.env` + deploy, then one live sync verifies. FOLLOWUP-cadence-zwiftpower-live.
- ISC-134: settings gained nullable `ftp_watts`/`lthr_bpm`; live `GET /api/settings` returns them (null by default); PATCH validates positive integers and supports null-to-clear; bun test.
- ISC-135: `activities` gained nullable `avg_power`/`norm_power` via guarded ALTER (schema test); Garmin sync maps them defensively off the SDK's passthrough summary (see Decisions: SDK declares no typed power fields).
- ISC-136: bun test covers all three tiers, power (FTP + power number), hr (avg HR + LTHR), duration (neither), and asserts the tier used is recorded.
- ISC-137: bun test vectors, one hour at NP=FTP=250 scores exactly 100; two hours at NP 150 / FTP 200 scores 112.5 (Coggan identity).
- ISC-138: bun test, IF = NP/FTP with NP present (estimated=false); falls back to avg power with estimated=true.
- ISC-139: bun test against a hand-computed 3-day series [98, 0, 49] including a zero-load rest day, Fitness (tc 42) and Fatigue (tc 7) values matched to 1 decimal.
- ISC-140: bun test, Form equals yesterday's Fitness minus yesterday's Fatigue; day-one Form is 0.
- ISC-141: `GET /api/metrics/training-load` lives under /api/ (auth-gated); live curl with a bearer token returned the daily series shape (thresholds_set, current fitness/fatigue/form, week_load, series).
- ISC-142: user-facing labels are Load / Fitness / Fatigue / Form; `rg "TSS|CTL|ATL|TSB" public/` is clean and the served `app.js` grep for those tokens returned none.
- ISC-143: bun test, changing an activity duration changes the recomputed load on the next read (no cache); deleting the only activity yields an empty series.
- ISC-144: bun test, duration-tier load still computes with FTP/LTHR unset; the Trends UI shows `#load-prompt` prompting to set thresholds (served bytes carry "Set your power").
- ISC-145: MCP `get_training_load` returns current fitness/fatigue/form + week_load via `GET /api/metrics/training-load`; `currentWeekLoad` unit-tested (Monday-anchored sum).
- ISC-146: `git diff package.json` adds exactly one runtime dependency (the zwift wrapper); the metrics engine imports nothing outside the repo.
- ISC-147: bun test, `eachNyDay` crosses the 2026-03-08 spring-forward with no dropped/duplicated day; an instant at 2026-03-08T04:30Z buckets to the 2026-03-07 New York day.
- ISC-148: `bunx tsc --noEmit` clean; `bun test` 126 pass / 0 fail across 10 files.
- ISC-149: the pre-existing 97 tests still pass unchanged (only the settings-shape and MCP tool-count assertions were updated to match the additive changes); dashboard, G1 logic, Garmin sync, stretch tab, and existing MCP tools untouched and green.

## Changelog

- conjectured: the PWA service worker would serve stale CSS after the whimsy restyle deployed, so ISC-232 required a cache version bump (OBSERVE premortem, 2026-07-19). refuted by: reading sw.js — it is a deliberate no-op passthrough registered solely to satisfy Chromium installability (ISC-162), with no Cache storage and every request falling through to network. learned: premortems built on how a mechanism usually works must be probed against how this project actually built it before they become criteria; Cadence's sw.js is intentionally cache-free, so asset staleness is a browser-HTTP-cache concern, not a service-worker one. criterion now: ISC-232 tombstoned; no cache-bump step exists in the deploy path.

- conjectured: inline SVG data URIs in CSS url() with raw angle brackets would render decorative patterns, since the pattern is common in shipped sites (whimsy build, 2026-07-19). refuted by: live render in real Chrome — computed style carried the background-image but the image failed to load (Image onerror), with or without %3C encoding, while the same visual intent expressed as radial-gradient and text-decoration wavy rendered instantly. learned: for decorative CSS effects prefer primitives the CSS engine draws natively (gradients, text-decoration) over embedded-document parsing (SVG data URIs), which fail silently and cost debugging rounds; also, synthetic Ctrl+Shift+R does not hard-reload Chrome, so CSS verification needs an explicit cache-bust of the stylesheet link. criterion now: ISC-240's whimsy devices are implemented as wavy text-decoration underlines and radial-gradient dot fields, both confirmed in screenshots.

- conjectured: garmin-connect-client was the right library because it alone documented an MFA resume flow (ISC-24 decision at build time). refuted by: first real sync in production — its native dependency node-libcurl-ja3 binds raw V8 C++ APIs (undefined symbol v8::Object::DefineOwnProperty) that Bun does not implement; the module can never load under Bun, and every sync crashed the service (systemd auto-restart absorbed it). learned: for a Bun deployment, "zero native modules" is a HARD library-selection criterion that outranks feature checklists — a dependency's install scripts being blocked by default (bun pm untrusted) is the early warning, and MFA-capability claims must be probed on the deploy runtime, not on paper. criterion now: ISC-92 effectively extends to "no native .node modules in the production tree" (verified: find -name '*.node' → 0 after the swap), and ISC-24's choice is superseded by garmin-connect-sdk@1.0.0-alpha.4 (pure TS, typed MFA errors, FileTokenStorage restore) — exact-pinned per ISC-101, isolated per ISC-100, which made the swap a one-file change exactly as designed.

- conjectured: the static handler would serve /img/stretch/ subdirectory files because fonts/ appeared to be a served subdirectory (stretch-plan brief, 2026-07-16). refuted by: reading src/server.ts — STATIC_ROUTES is a flat allowlist where every fonts file is its own explicit key; no wildcard or directory serving exists, so subdirectory files 404'd into the app-shell fallthrough. learned: Cadence's static surface is a deliberate explicit allowlist (part of the health-data-private-by-construction posture); any new static asset class needs its own route, and that route must constrain the path to a server-composed string. criterion now: ISC-106 passes through a regex-gated route (`^/img/stretch/([a-z0-9-]+)\.svg$`) with traversal probes verified live and a charset-reject test in the suite.

