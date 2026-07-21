---
task: Cadence — Austin's personal fitness app (Garmin-synced, MCP-editable)
project: cadence
effort: E4
phase: build
progress: 53/103
mode: standard
started: 2026-07-16T19:50:29Z
updated: 2026-07-21T00:00:00Z
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

### Sleep (Garmin nightly sleep, ISC-243..252)
- [x] ISC-243: `sleep` table (calendar_date UNIQUE natural key) plus `sleep_seen`/`sleep_new` tallies added to sync_runs via guarded idempotent migration, probe: PRAGMA table_info in bun test
- [x] ISC-244: Garmin adapter exposes `listRecentSleep` via the SDK's `sleep.getSleepRange`, mapping total/deep/light/REM/awake seconds, bedtime/wake instants, and overall score, defensively off the passthrough payload, probe: unit map test + code read
- [x] ISC-245: re-syncing the same night is idempotent (one row on calendar_date), `updated_at` bumped only when a stored value changed, probe: bun test double-sync + change-detection
- [x] ISC-246: sleep pulls inside the existing `runSyncOnce` using the same Garmin session, after activities are committed, and its tally is recorded on the sync run, probe: bun test asserts sleep_seen/new on the run
- [x] ISC-247: Anti: a sleep fetch failure OR hang never fails an otherwise-successful activity sync (best-effort try/catch + 30s timeout race), probe: bun test with a throwing sleep client asserts status=success, activities recorded, sleep_seen=0
- [x] ISC-248: `GET /api/sleep` returns serialized nights newest-first and is auth-gated (401 unauthenticated, clamps absurd limits), probe: bun test route + live curl with session cookie
- [x] ISC-249: Anti: sleep is structurally separate from `activities` and never feeds the G1 5-session/8h metric, probe: separate table + grep, sleep never read by week/metrics
- [x] ISC-250: `get_sleep` MCP tool returns recent nights over one authenticated API call (read-only), probe: bun test tool registry (16 tools) + handler
- [x] ISC-251: Sleep tab renders the last-night card (total, stages, bedtime→wake, score), a 7-night stacked-stage trend, and a recent-nights list, probe: Interceptor screenshot of a real login on a throwaway instance
### Weight detail + nutrition surface (ISC-259..263, 2026-07-21, DEPLOYED commit b1e4d74)
- Deploy: no migration (weight_kg already live), precautionary backup cadence-pre-weightdetail-20260721T140608Z.db, clean git-archive rsync + restart. Live-verified: box series current 85 / min 83 / max 85 / count 7; both the dashboard readings list and the Nutrition weight card browser-rendered through Austin's session with real data (dates + kg + per-reading change). Full record in deploy/NOTES.md.
- [x] ISC-259: computeWeightSeries also returns all-time `min`, `max`, and `count` (distinct-day readings), probe: bun test empty + 3-reading cases
- [x] ISC-260: the dashboard weight card shows a dated readings list (each reading's date, kg, and change from the previous reading) plus a "N readings · range min–max" stats line, probe: Interceptor screenshot
- [x] ISC-261: the same weight card (via a shared renderer) appears in the Nutrition tab, carrying the "From your Zwift ride data" source label so it never implies nutrition-logged weight (advisor-raised), probe: Interceptor screenshot of the Nutrition tab
- [x] ISC-262: the readings list is capped at the newest 12 rows and the stats line says "newest 12 shown" when count exceeds the cap, so all-time count/min/max stay coherent with a truncated list (advisor-raised), probe: code read + count>cap branch
- [x] ISC-263: per-reading change is computed over the full oldest-first series (correct at the cap boundary and absent for the first-ever reading), probe: code read + Interceptor (oldest visible row still shows a true delta)

### Weight progress from Zwift ride data (ISC-253..258)
- [x] ISC-253: ZwiftPower result carries `weightKg` parsed from the raw `["84.5", 0]` string tuple; `weight_kg REAL` added to zwiftpower_results via guarded idempotent migration, probe: unit test `toResult` + PRAGMA table_info
- [x] ISC-254: the ZwiftPower sync stores and updates `weight_kg` (idempotent on event_id, change-detected), probe: bun test insert then changed-weight re-sync, one row
- [x] ISC-255: `computeWeightSeries` builds an oldest-first, one-point-per-day series with current/first/delta from rides that carry weight, probe: bun test ordering + per-day collapse + delta
- [x] ISC-256: `GET /api/metrics/weight` returns the series and is auth-gated (401 unauthenticated), probe: bun test route + live curl
- [x] ISC-257: the dashboard shows a Weight-progress card (current weight, delta chip, sparkline) and hides the whole widget when no Zwift weight data exists, probe: Interceptor screenshot on a seeded throwaway instance
- [x] ISC-258: Anti: weight is derived only from Zwift ride data, never fabricated (null on missing/zero/non-numeric weight) and never feeds the G1 5-session/8h metric, probe: unit test null cases + grep (week/metrics never read weight_kg for G1)
- [x] ISC-252: the live Garmin sleep payload shape is confirmed against Austin's real prod account (2026-07-20 sync) — which surfaced a real alpha-SDK bug (sleepStart/EndTimestampLocal typed string but returned as epoch-ms numbers, zod-rejecting every night); fixed with a transport-layer fetch coercion in client.ts, then a real prod sync pulled 13 nights of genuine sleep, browser-verified live. Follow-up FOLLOWUP-cadence-sleep-live-shape RESOLVED.

### Layout enhancement + 10-feature roadmap refresh (ISC-264..295, 2026-07-21)
- [DEFERRED-VERIFY] ISC-264: nav fits in at most one row at 375px viewport (horizontally scrollable pill rail, no 3-row wrap), probe: this Interceptor build has no viewport emulation; structural CSS verified (640px query: nowrap + overflow-x:auto + hidden scrollbar + mask fade). Follow-up: FOLLOWUP-cadence-layout-phone-check (Austin loads fit.austinfiala.com on his phone once)
- [x] ISC-265: sleep tab has an active-state background color rule like every other tab, probe: grep found rule, Interceptor screenshot shows purple pill, Engineer computed 5.44:1 AA contrast with paper text
- [x] ISC-266: all 8 tabs have explicit active colors, probe: grep count of active data-view rules returned 8
- [x] ISC-267: desktop ≥860px renders dashboard sections in a 2-column grid, probe: Interceptor screenshot shows Quick log/This week left, Personal records right
- [x] ISC-268: dashboard opens with a compact "today" summary strip (week gap, form, last-night sleep) above the fold, probe: screenshot shows 3-chip strip as first content; strip is first element in source so above-fold holds at any height
- [DEFERRED-VERIFY] ISC-269: quick-log presets remain reachable within one viewport at 375px, probe: structural (strip then Quick log first in source, 480px query tightens chips); phone-visual pending FOLLOWUP-cadence-layout-phone-check
- [x] ISC-270: section visual rhythm normalized, probe: shared .section-title margin rule + :first-child reset in styles.css
- [x] ISC-271: topbar is sticky on scroll, probe: position:sticky present AND behavioral eval after scrollTo(0,800): topbar rect.top === 0
- [x] ISC-272: activities view shows recent activities before the add-form, probe: Interceptor screenshot shows list first, closed "Add an activity manually" details below, logged ride visible
- [x] ISC-273: trends chart cards carry min-height, probe: grep found 180px/130px/64px min-heights on chart classes
- [x] ISC-274: nav pills and preset buttons keep ≥44px touch targets at phone width, probe: adjusted to structural (computed-style eval impossible at desktop viewport): min-height:44px on .nav-tab and .preset-btn inside the 640px query
- [x] ISC-275: layout changes are CSS/HTML-structure only; app.js confined to render/fetch wiring (+47 lines, today-strip fetch/render only), probe: git diff review
- [x] ISC-276: Anti: whimsical brand tokens survive unchanged, probe: git diff grep on token definitions returned 0
- [x] ISC-277: Anti: zero new dependencies, probe: git diff package.json/bun.lock empty
- [x] ISC-278: Anti: no em/en dashes in any new copy, probe: grep on all added diff lines returned 0
- [x] ISC-279: Anti: no regression in the test suite, probe: bun test 216 pass 0 fail (independent re-run by primary)
- [x] ISC-280: tsc reports zero new errors, probe: bunx tsc --noEmit exit 0 (independent re-run)
- [x] ISC-281: full browser walkthrough on throwaway instance passes, probe: Interceptor session: real login, all 8 tabs walked, preset tap logged a ride and live-updated the week chip, console clean
- [x] ISC-282: ROADMAP.md gains a "Round 2" section with exactly 10 new features, probe: grep count of round-2 headings returned 10
- [x] ISC-283: zero overlap between the new 10 and the original 10 or built features, probe: read-compare done, features 11-20 vs round 1 items 1-10 and shipped inventory, disjoint
- [x] ISC-284: each new feature carries an effort tag (S/M/L) and a one-paragraph rationale, probe: read round-2 section, all 10 tagged with rationale paragraphs
- [x] ISC-285: each new feature respects standing exclusions (single user, no native apps, no frontend frameworks, no public health data), probe: read-check passed, GPS minimaps explicitly tile-free/private, race card excludes adaptive coaching, alert is opt-in single-user
- [x] ISC-286: a suggested build order for the new 10 is included, probe: grep "Round 2 suggested order" returned 1
- [x] ISC-287: shipped round-1 items are marked as built in ROADMAP.md so the file stays truthful, probe: grep SHIPPED returned 6 markers (items 2, 3, 4-partial, 6, 8, 10-as-MVP)
- [x] ISC-288: plan presented to Austin and approved before any build begins, probe: ExitPlanMode returned "User has approved your plan"
- [x] ISC-289: Advisor consulted at the commitment boundary before plan presentation, probe: Inference.ts advisor call returned 7 catches, recorded in Decisions
- [x] ISC-290: work committed with a descriptive message on approval, probe: git log shows cea8d22
- [x] ISC-291: Anti: no deploy without Austin's explicit go, probe: Austin said "deploy" mid-build; deploy executed only after full verification, live-verified (three sites 200, new bytes, real-session render)
- [x] ISC-292: Anti: mascot and login screen untouched, probe: git diff grep login-shell/cadence-mascot returned 0
- [x] ISC-293: PWA manifest and icons untouched by layout work, probe: git diff on manifest/icons empty
- [x] ISC-294: ISA Decisions and Changelog updated with this run's outcomes, probe: Decisions entry 2026-07-21 + Changelog entry this run
- [x] ISC-295: PROJECTS.md updated with the session record, probe: cadence section gains 2026-07-21 layout + roadmap entry

### Round-2 build: all ten features + workout detail view (ISC-296..415, 2026-07-21)

#### Wave 1 — backend/engine (RPE, duplicates, detail data, race target, G1 risk, forecast, YoY, power curve)
- [x] ISC-296: activities gain a nullable `rpe INTEGER` column (1..10) via guarded additive migration, probe: PRAGMA table_info
- [x] ISC-297: PATCH edit route accepts/validates rpe (1..10 or null), rejects out-of-range, probe: bun test
- [x] ISC-298: rpe survives Garmin re-sync (added to the user-edit preservation set), probe: bun test edit-then-resync
- [x] ISC-299: load engine gains an sRPE tier used when rpe present AND no power-TSS/hrTSS available, probe: unit test tier selection
- [x] ISC-300: sRPE maps onto the TSS-point scale via documented formula (IF proxy = rpe/10, TSS = (rpe/10)^2 x 100 x hours), never raw Foster units, probe: golden vector test
- [x] ISC-301: tier precedence is power > hr > srpe > duration, recorded per-activity in the existing tier field, probe: unit test
- [x] ISC-302: activities without rpe keep their current tier and value (series regression-identical without rpe), probe: regression test on existing fixture
- [x] ISC-303: Anti: rpe never affects the G1 sessions/hours metric, probe: grep week.ts + test
- [x] ISC-304: setting rpe recomputes the load series on next read (no stale cache), probe: test edit-then-read
- [x] ISC-305: MCP edit_activity accepts rpe, probe: tool schema + round-trip test
- [x] ISC-306: pure `findDuplicateCandidates` flags pairs with start-time overlap and duration within 20% or 5 min AND same-day, distinct sources preferred, criteria documented in the module header, probe: unit tests incl. legit back-to-back non-flag
- [x] ISC-307: back-to-back same-sport sessions (no time overlap) are NOT flagged, probe: unit test
- [x] ISC-308: `duplicate_dismissals` table persists dismissed pairs on a stable key (min/max activity id), probe: PRAGMA + test
- [x] ISC-309: dismissed pairs never re-flag after re-sync, probe: test dismiss-then-rescan
- [x] ISC-310: GET /api/duplicates returns current candidate pairs with both activities' summaries, auth-gated, probe: bun test + 401 test
- [x] ISC-311: POST /api/duplicates/dismiss marks a pair kept, probe: bun test
- [x] ISC-312: POST /api/duplicates/merge deletes the chosen loser and keeps the richer record, requires explicit loser id, probe: bun test
- [x] ISC-313: merge preserves user edits (notes/title/sport/rpe) from the kept row, never blends, probe: unit test
- [x] ISC-314: Anti: merge never runs automatically anywhere (no scheduler/sync call path reaches it), probe: grep call sites
- [x] ISC-315: merge of a Garmin-sourced loser records its garmin id in a tombstone so re-sync does not resurrect it, probe: test merge-then-resync
- [x] ISC-316: Anti: cross-week merge cannot corrupt week summaries (recompute path covered), probe: test week totals before/after merge
- [x] ISC-317: duplicate scan is on-demand (API call), never blocks or runs inside Garmin sync, probe: grep sync path
- [x] ISC-318: `activity_details` table stores per-activity laps JSON, GPS polyline JSON (decimated), detail summary fields, fetched_at, via guarded migration, probe: PRAGMA
- [x] ISC-319: GET /api/activities/:id/detail returns local row + cached detail; on first request for a Garmin activity it lazily fetches getSplits + getDetails once and caches, probe: bun test with fake client
- [x] ISC-320: detail fetch is NEVER bulk: sync path performs zero detail calls, probe: grep sync code + test
- [x] ISC-321: Garmin detail/splits parse defensively (unknown-typed): missing/odd fields degrade to null, never throw to the route, probe: malformed-payload tests
- [x] ISC-322: a non-empty payload parsing to all-null logs its key set once (sleep-lesson observability), probe: unit test log hook
- [x] ISC-323: lap rows expose per-lap duration, distance, avg/max HR, avg power when present, probe: fixture test
- [x] ISC-324: GPS polyline decimated to <=200 points before storage, probe: unit test with 5000-point fixture
- [x] ISC-325: manual activities (no garmin id) return local fields with detail:null and NO fetch attempt, probe: test fake-client call count 0
- [x] ISC-326: detail refresh param forces a re-fetch and updates fetched_at, probe: bun test
- [x] ISC-327: deleting an activity deletes its cached detail row, probe: test cascade
- [x] ISC-328: detail fetch failure (network/rate-limit) returns the local summary with detail_error flag, HTTP 200, probe: throwing-fake test
- [x] ISC-329: detail fetch has a timeout guard so a hung Garmin call cannot hang the route, probe: timeout race test
- [x] ISC-330: Anti: detail fetch never triggers a Garmin LOGIN (session-restore only; unauthenticated client = detail_error, no credential dance), probe: fake asserting no login call
- [x] ISC-331: GET /api/activities list gains has_detail/garmin-sourced hints so the UI knows what is clickable-rich, probe: shape test
- [x] ISC-332: settings gain race_name + race_date (nullable), PATCH-editable, probe: bun test round-trip
- [x] ISC-333: race_date validates ISO date, clearable to null, probe: validation test
- [x] ISC-334: GET /api/metrics/g1-risk returns week-to-date sessions/hours, remaining need, days left (NY Monday-anchored via existing week logic), and projection from trailing 4-week per-weekday rhythm, probe: bun test fixed clock
- [x] ISC-335: g1-risk verdict field: on_track | at_risk | met, thresholds documented in module, probe: unit tests all three states
- [x] ISC-336: Anti: g1-risk math reads sessions/hours only, never the load/form series, probe: grep imports
- [x] ISC-337: GET /api/metrics/pacing returns per-weekday historical session frequency + typical hours from trailing 8 weeks (the "usual rhythm" data), probe: bun test with seeded history
- [x] ISC-338: pacing handles <2 weeks history with insufficient_history:true, probe: empty-DB test
- [x] ISC-339: GET /api/metrics/yoy returns this-week vs same-ISO-week-last-year sessions/hours/distance deltas, probe: bun test seeded two years
- [x] ISC-340: yoy returns insufficient_history per metric when the prior-year week has no data, probe: test
- [x] ISC-341: ISO week-53 edge handled (falls back to week 52 comparison when prior year lacks 53), probe: unit test
- [x] ISC-342: ZwiftPower critical-power fetch stores best-effort watts for 15s/1m/5m/20m with a rolling-90-day window computed at read, probe: fake-payload test
- [x] ISC-343: GET /api/metrics/power-curve returns curve points + per-point source event, auth-gated, probe: bun test + 401
- [x] ISC-344: power-curve fetch is part of the existing ZP sync (no new session dance) and degrades to stored data on ZP failure, probe: throwing-fake test
- [x] ISC-345: Anti: power curve scoped to cycling only, no swim/run contamination, probe: shape test
- [x] ISC-346: all new routes auth-gated (401 unauthenticated), probe: loop test over new endpoints
- [x] ISC-347: all new tables/columns via guarded idempotent migrations (double-boot safe), probe: double-migrate test
- [x] ISC-348: MCP gains get_activity_detail and get_g1_risk tools over the new APIs, probe: tool round-trip tests

#### Wave 2 — detail view UI + swim library + race countdown + duplicates UI
- [ ] ISC-349: every activity row (Activities list + dashboard surfaces that list activities) is clickable and opens a detail view, probe: Interceptor click
- [ ] ISC-350: detail view shows title, sport, date/time, duration, distance, avg/max HR, avg/max power, source, notes, RPE, probe: Interceptor on seeded instance
- [ ] ISC-351: detail view lap table renders when laps exist (lap #, time, distance, HR, power), probe: Interceptor seeded laps
- [ ] ISC-352: detail view GPS mini-map renders as inline SVG path for outdoor tracks, probe: Interceptor seeded polyline
- [ ] ISC-353: indoor/no-GPS activities show a clean empty state (no broken map), probe: Interceptor
- [ ] ISC-354: manual activities render local fields without any fetch spinner hang, probe: Interceptor
- [ ] ISC-355: detail view has a back affordance returning to the prior list scroll state, probe: Interceptor click-back
- [ ] ISC-356: detail view is deep-linkable via location hash (#activity/ID) and survives reload, probe: Interceptor navigate
- [ ] ISC-357: RPE is editable from the detail view (1..10 chips + clear), saving via existing PATCH, probe: Interceptor + DB read-back
- [ ] ISC-358: notes editable from detail view, probe: Interceptor + DB read-back
- [ ] ISC-359: detail_error state renders a quiet "Garmin detail unavailable" line, not a broken panel, probe: forced-error render
- [ ] ISC-360: a refresh control on Garmin-sourced details triggers the re-fetch param, probe: Interceptor + fetched_at change
- [ ] ISC-361: Swim tab (or section) presents hand-authored swim sets: at least 6 cards across 30/45/60-min lengths with warmup/main/cooldown text and total distance, probe: Interceptor render + content read
- [ ] ISC-362: each swim card has a one-tap "Log this set" posting a swimming activity with the card duration, probe: Interceptor click + DB read-back
- [ ] ISC-363: swim log respects the quick-log undo-toast pattern, probe: Interceptor
- [ ] ISC-364: Anti: swim set content carries no coaching-adaptive logic, static reference only (matches stretch-tab precedent), probe: code read
- [ ] ISC-365: swim sets content has zero em/en dashes, probe: grep
- [ ] ISC-366: race countdown card on dashboard when race_date set: name, days-out, static final-week taper checklist appearing within 7 days, probe: Interceptor with seeded date
- [ ] ISC-367: race in past shows a graceful "raced N days ago" state with a clear affordance, probe: Interceptor seeded past date
- [ ] ISC-368: no race set = card absent entirely (not an empty shell), probe: Interceptor default render
- [ ] ISC-369: race editable/clearable from the UI (settings area or card), probe: Interceptor + DB read-back
- [ ] ISC-370: duplicates review UI lists candidate pairs side-by-side with keep-both and merge actions, probe: Interceptor seeded pair
- [ ] ISC-371: merge in UI requires choosing which record to keep (no default destructive action), probe: Interceptor
- [ ] ISC-372: zero candidates renders an all-clear line, probe: Interceptor
- [ ] ISC-373: duplicates surface shows a badge/count on the Activities view when candidates exist, probe: Interceptor seeded

#### Wave 3 — dashboard/trends analytics UI + MCP + process
- [ ] ISC-374: dashboard gains a pacing line under the gap line: projected end-of-week vs target using the usual-rhythm data, probe: Interceptor seeded history
- [ ] ISC-375: pacing line suggests the concrete close ("one more swim closes it") derived from the sport mix deficit, probe: render test
- [ ] ISC-376: insufficient history hides the pacing line entirely, probe: Interceptor empty instance
- [ ] ISC-377: Trends gains YoY chips (sessions/hours/distance delta vs same week last year) with per-metric not-enough-history states, probe: Interceptor
- [ ] ISC-378: Trends gains the cycling power curve card (15s/1m/5m/20m inline SVG) with sparse-data state, probe: Interceptor seeded + empty
- [ ] ISC-379: power curve labels carry watts and the source event date on hover/tap title, probe: DOM attr check
- [ ] ISC-380: G1 risk surfaces in the today strip week chip sub-line when at_risk (quiet, no nagging when on_track), probe: render test both states
- [ ] ISC-381: get_g1_risk MCP tool returns the same verdict the UI shows, probe: MCP round-trip
- [ ] ISC-382: get_activity_detail MCP tool returns detail incl. laps for a given id, probe: MCP round-trip
- [ ] ISC-383: Anti: no cron/scheduler for the risk alert is created in this build (opt-in remains unbuilt until Austin enables; endpoint+tool only), probe: grep scheduler code unchanged
- [ ] ISC-384: full test suite green after all waves, probe: bun test
- [ ] ISC-385: tsc clean after all waves, probe: bunx tsc --noEmit
- [ ] ISC-386: zero new npm dependencies, probe: git diff package.json
- [ ] ISC-387: Anti: no em/en dashes in any new user-facing copy across all waves, probe: grep added lines
- [ ] ISC-388: Anti: brand tokens and mascot untouched, probe: git diff
- [ ] ISC-389: Anti: G1 sessions/hours metric computation byte-identical for existing data (no new feature feeds it), probe: regression test + grep
- [ ] ISC-390: Anti: nutrition, sleep, weight, stretch features unregressed (their tests still pass, tabs still render), probe: suite + Interceptor walkthrough
- [ ] ISC-391: full Interceptor walkthrough on throwaway instance: all tabs, detail click-in, swim log, duplicate review, race card, probe: Interceptor session
- [ ] ISC-392: live Garmin detail shape confirmation is DEFERRED until first real prod fetch (unknown-typed endpoints), follow-up: FOLLOWUP-cadence-detail-live-shape, probe: deferred
- [ ] ISC-393: Advisor consulted before build commitment and before phase complete, probe: transcript
- [ ] ISC-394: Cato cross-vendor audit fires at VERIFY if codex present, else recorded codex-unavailable, probe: which codex + Decisions entry
- [ ] ISC-395: work committed with descriptive messages per wave, probe: git log
- [ ] ISC-396: Anti: no deploy without Austin's explicit go, probe: transcript
- [ ] ISC-397: ISA Decisions/Changelog/Verification updated, PROJECTS.md session record added, probe: read files
- [ ] ISC-398: ROADMAP round-2 items marked shipped once verified, probe: grep markers

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

- 2026-07-21 — **Round-2 full build (ISC-296..398), Austin: "build out the 10 features I also want to be able to click into workouts to see more information".** Tier E4 by context-override (classifier said E3; ten cross-cutting features with migrations and three sequential Engineer waves is E4 scale). ISC floor show-my-math: granularity produced 103 atomic criteria, splitting further to hit 128 would break one-probe atomicity. Delegation: codex absent (SOURCE: codex-unavailable, Forge slot and Cato Rule 2a both fall back honestly); three sequential Engineer waves because every feature touches app.js/index.html/styles.css and parallel writes would collide. Plan-mode skipped deliberately: Austin approved the round-2 list in the prior run's plan and issued an explicit build command; re-presenting would repeat the "didn't comply the first time" failure pattern. Science probes before commitment: garmin-connect-sdk exposes get/getDetails/getSplits (both detail calls return unknown, so parse-at-boundary + degrade-to-null + one-time key-set log, the sleep lesson), ZP wrapper exposes getCriticalPower/getPowerProfile with cpBestEfforts. Advisor pre-build pass: (Flag 0) advisor was shown a stale auto-state ISA pointer, not a real gap, the Cadence project ISA holds the criteria (ISASync project-ISA discovery is the known v6.2.x gap); (Flag 1) cache ONLY post-validation detail payloads, never raw unknown, adopted into the brief; (Flag 2, real catch) pin the sRPE PRESENT case: tier precedence (power>hr>srpe>duration) already shields every power/HR activity so Zwift history cannot shift, and setting RPE on a duration-tier activity is itself the consent (FTP-threshold recompute precedent, 2026-07-17); explicit test added that rpe on a power-tiered activity changes nothing. Also adopted: dismissed duplicate pairs viewable + undismissable in UI, YoY week alignment through the existing NY Monday-anchored week logic, commit per wave so a late-wave failure strands nothing. RPE lives on the activities row, structurally separate from the activity_details cache, so detail re-fetch can never clobber an edit.
- 2026-07-21 — **Layout enhancement + 10-feature roadmap refresh (ISC-264..295), Austin: "enhance the cadence app - improve the overall layout and find 10 new features to add".** Read as two deliverables: (D1) layout restructure preserving the 2-day-old whimsical brand, (D2) ten NEW feature proposals beyond ROADMAP round 1 and the since-built inventory (PR board, heatmap, quick log/PWA, digest, sleep, nutrition, weight are shipped; threshold history, recovery context, gear odometer, weather window, backup/export remain proposed). Plan-first enforced: recent learning signals show design asks failing when jumped to implementation, so the full plan goes through plan-mode approval before any build. Delegation: codex absent (`SOURCE: codex-unavailable`, Forge slot falls back to Engineer); delegation floor met at 1-of-2 with show-my-math — recon was directed lookups (delegation-gate forbids agents for those) and ideation is primary-side BeCreative work, leaving Engineer as the single delegated builder post-approval. Advisor pass (Rule 2, pre-presentation) caught: (1) sRPE loads must be mapped onto the existing TSS-point tier scale, never raw Foster units, or the load series gets discontinuities; (2) critical power curve must be scoped to cycling explicitly; (3) GPS minimaps need an indoor empty state + point decimation; (4) YoY comparisons need an insufficient-history state; (5) duplicate detector needs match criteria defined up front (time overlap + duration/distance tolerance); (6) the G1 risk alert is the only unsupervised server-side item — opt-in, thresholds, snooze; (7) present features tiered by effort x value with data prerequisites. Advisor's load-model blocker on G1 forecast/alert dissolved on inspection: both compute on sessions/hours arithmetic (the G1 metric itself), not the CTL/ATL series — noted per Rule 3, no conflict re-call needed since this is scoping, not empirical contradiction. Austin: "build out more data on the weight section, dates, how many kgs, and I add it to the nutrition section too".** Read as: expand the weight widget with per-reading detail (dates + kg values + change), and surface the same widget in the Nutrition tab. All frontend over the existing `/api/metrics/weight` (enriched with all-time min/max/count); a shared `renderWeightWidget(els, data)` drives both the dashboard card and a new Nutrition-tab card so the two can never drift. Tier: classifier said E3; de-escalated to E2 with context-override — this is a light frontend extension of the weight feature shipped the same day, reusing its API, and E3's ≥4 thinking-capability hard floor would be pure ceremony against Austin's time. Advisor pass (Rule 2) raised three: (1) the Nutrition card could imply nutrition-logged/editable weight — mitigated by the existing "From your Zwift ride data" source label carried on both cards; (2) the all-time count/min/max must stay coherent with a capped list — added a "newest 12 shown" indicator when count exceeds the 12-row cap; (3) verify the per-reading delta at the cap boundary — confirmed correct: the change is computed over the FULL oldest-first series, so even the oldest visible row compares to its true previous reading, and the first-ever reading correctly shows no chip. 216 tests pass (min/max/count added to the weight tests), tsc clean, Interceptor-verified on both surfaces. NOT yet deployed — gated on Austin's go (static-heavy: HTML/JS/CSS + a metrics.ts read; guarded by the already-live weight_kg column, no new migration).
- 2026-07-21 — **Weight progress from Zwift ride data (ISC-253..258), Austin: "Add weight progress to the dashboard - make it based of ride data from zwift".** Feasibility confirmed by probing the live ZwiftPower `_all.json` feed on the box before building: each result row carries a `weight` field as a `["84.5", 0]` string tuple (Austin's Zwift weight, 84.5 kg). Honest caveat recorded and surfaced to Austin: this is the rider's Zwift PROFILE weight at ride time (a manually-entered value used for w/kg), not a per-ride scale measurement, so "progress" is a step function that only moves when he updates his Zwift weight. Built to the ask anyway since he was explicit about the source. Design: `weightKg` added to the ZwiftPowerResult mapping via a new `tupleFloat` parser (the existing `tupleNumber` only handled a number first-element; weight's is a string), stored as a nullable `weight_kg` column (guarded ALTER, historical prod rows null until the next sync repopulates them via change-detection), a pure `computeWeightSeries` reducer (one point per NY day, latest wins; current/first/delta), a `GET /api/metrics/weight` route, and a dashboard card (big current number + delta chip + SVG sparkline) that hides itself when no weight data exists. Metric is kg (Austin is metric). Never fabricates: missing/zero/non-numeric weight is null, and weight never feeds the G1 metric (ISC-258). Tier E2 (classifier), patterned single-domain add. Delegation floor relaxed (show-my-math): codex absent, patterned build by primary. 216 tests pass (10 new), tsc clean, Interceptor-verified on a seeded throwaway instance. NOT yet deployed — gated on Austin's go (standard clean git-archive rsync + restart, guarded additive migration; a real prod ZwiftPower sync after deploy repopulates weight_kg on the 7 existing result rows).
- 2026-07-20 — **Sleep tracking (ISC-243..252), Austin: "add sleep details from garmin".** Full Sleep tab chosen via AskUserQuestion (over a minimal dashboard stat or a richer hypnogram/recovery build). Tier: classifier said E2; investigation confirmed a patterned single-domain add mirroring the zwiftpower/nutrition modules, so E2 was honored rather than inflated to E3 ceremony. Delegation floor relaxed (show-my-math): codex absent (`SOURCE: codex-unavailable`, Forge slot falls back), and the Cadence Engineer agent has stalled mid-build repeatedly on this repo, so a mechanical pattern-match build by primary is faster and lower-risk than delegating. Load-bearing calls: (1) `listRecentSleep` is OPTIONAL on the GarminClient interface so existing activity-only fakes and callers are unbroken; sync guards the call. (2) Sleep rides inside `runSyncOnce` (one Garmin session) but is best-effort — a thrown error OR a hung promise (30s timeout race) can never fail the activity sync, since activities commit first (ISC-247). (3) `sleep` is its own table keyed on Garmin's own `calendarDate` verbatim (never derived, so no timezone-off-by-one idempotency corruption — advisor blind-spot 1, already satisfied), entirely separate from `activities`, never feeding G1 (ISC-249). (4) The exact Garmin sleep field names/units can't be confirmed without a live prod sync, so the adapter reads defensively (GMT-preferred, epoch-ms-or-string tolerant, degrade to null) and — per the advisor's insisted-on fix — logs the raw payload key set once when a non-empty payload parses to all-null, converting a silent empty tab into a loud DEFERRED-VERIFY trigger (ISC-252). Advisor pass (Rule 2) raised silent-all-null degradation and the fetch-timeout gap; both fixed before declaring done. 206 tests pass (18 new), tsc clean, Interceptor browser-verified on a throwaway seeded instance. NOT deployed — gated on Austin's go; deploy is the standard clean git-archive rsync + restart with a pre-migration DB backup (guarded additive migration, safe on the live table).
- 2026-07-19 — **Whimsical rebrand (ISC-221..240), brand interpretation.** Austin asked for "more whimsical... inspiration from mikkeller beer and erstwhile brand." Mikkeller grounding is source-verified this session: Keith Shore's flat, bold, retina-tingling label art with long-nosed characters (mikkeller.com/art, itsnicethat.com). "Erstwhile" is ambiguous; the best craft-beverage match is Erstwhile Mezcal, whose site (fetched this session) shows warm cream grounds, earthy charcoal, and understated artisanal type. Synthesis chosen: Erstwhile supplies the warm cream canvas and restraint, Mikkeller supplies flat punchy accents, a hand-drawn mascot, and label-poster card styling. The Erstwhile assumption is flagged to Austin in the summary; if he meant a different Erstwhile, the accent layer stays valid and only the ground tone would shift. Styling only: zero behavioral JS changes, zero new deps, PWA cache version bumped so installed clients pick up the restyle.
- 2026-07-19 — **refined: wavy title underlines removed on Austin's feedback ("remove the squiggly lines under the titles").** ISC-240's three whimsy devices (mascot, offset-shadow label cards, per-view color coding) are unaffected; the Changelog note that named wavy underlines as an ISC-240 device is superseded by this entry. Plain bold titles stay.
- 2026-07-19 — **Deploy run (E3 per classifier): soft floors relaxed with show-your-math.** ISC floor (32) and delegation floor (2 agents) relaxed: a runbook deploy's verifiable surface equals the runbook's checkpoint list (14 checks, all executed and recorded in the deploy Verification round), and the genuine delegations were the Deploy and Interceptor skills; spawning coding agents for a deploy would add risk, not value. Also: Austin's "deploy" shipped HEAD, which necessarily included the already-committed nutrition MVP; disclosed in the deploy record and summary rather than cherry-picking a divergent artifact.
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

### Weight progress from Zwift (2026-07-21, ISC-253..258, DEPLOYED, commit 678ec5a)

- Deploy: backup cadence-pre-weight-20260721T134806Z.db (verified), clean git-archive rsync, restart, migration landed (weight_kg column), activities intact (53). Post-deploy real ZwiftPower sync repopulated weight_kg on all 7 result rows (83.2–85 kg); live Interceptor render through Austin's session confirmed the dashboard card with real data (85 kg, ↑0.5 kg since first ride). /api/metrics/weight 401 unauth. Full deploy record in deploy/NOTES.md.

- ISC-253: bun test — `toResult({weight:["84.5",0]})` → weightKg 84.5; bare number and missing/zero/empty → null; `PRAGMA table_info(zwiftpower_results)` includes weight_kg. Feasibility grounded by a live probe of the box's ZwiftPower feed (weight present as a string tuple).
- ISC-254: bun test — sync stores weight_kg=84.5, a changed-weight re-sync updates to 83.1 with one row (idempotent on event_id).
- ISC-255: bun test — 3 rides across 3 dates yield an oldest-first 3-point series, first 86.0 / current 84.5 / delta -1.5; two rides same day collapse to the latest weight; rides without weight or date are excluded.
- ISC-256: bun test — `GET /api/metrics/weight` returns 401 unauthenticated and `{unit:"kg",current,points[]}` for an authed request; live curl on a seeded throwaway instance returned current 84.2 / first 86.2 / delta -2 / 6 points.
- ISC-257: Interceptor screenshot on a seeded throwaway instance (real login) shows the dashboard Weight-progress card: "84.2 kg", "↓ 2 kg since first ride" chip, a descending 6-point sparkline, "From your Zwift ride data." caption; widget hides when current is null.
- ISC-258: unit tests prove null on missing/zero/non-numeric weight (no fabrication); grep confirms week.ts / weekSummary / G1 logic never read weight_kg.
- Suite: `bunx tsc --noEmit` clean; `bun test` 216 pass / 0 fail across 19 files (10 new weight tests + RESULT_B fixture gains weightKg).

### Sleep tracking (2026-07-20, ISC-243..252, built, NOT yet deployed)

- ISC-243: bun test reads `PRAGMA table_info(sleep)` (all 9 data columns present) and `PRAGMA table_info(sync_runs)` (sleep_seen/sleep_new present); migration is guarded CREATE TABLE IF NOT EXISTS + addColumnIfMissing, re-run safe.
- ISC-244: unit map test drives fixtures through the sync engine and reads back total/deep/light/rem/awake/score; `firstNonNegative` allows a legitimate 0 (awake), timestamps normalized via `parseGarminInstant`.
- ISC-245: bun test — same night twice → `SELECT COUNT(*)` = 1 and second run `sleep_new` = 0; identical re-sync leaves `updated_at` unchanged, a changed total/score bumps it.
- ISC-246: bun test — `runSyncOnce` with activities + sleep records the run with sleep_seen=2, sleep_new=2; sleep runs after the activity upsert loop.
- ISC-247: bun test — a client whose `listRecentSleep` throws still returns status=success, activities_new=1, sleep_seen=0, zero sleep rows; a 30s `Promise.race` timeout guards a hung fetch (advisor-added).
- ISC-248: bun test — `GET /api/sleep` returns 401 unauthenticated, 200 newest-first for an authed request, clamps `?limit=9999`; live curl on a throwaway instance with a real session cookie returned the nights array.
- ISC-249: `sleep` is its own table; grep confirms week.ts / metrics / weekSummary never read it — G1 metric untouched.
- ISC-250: bun test — TOOLS registry is exactly 16 including `get_sleep`; the MCP handshake test lists 16 tools; handler makes one `GET /api/sleep` call.
- ISC-251: Interceptor screenshot on a throwaway instance (real login) shows the Sleep tab: last-night card 7h 05m / Mon Jul 20 / 11:00 PM→6:48 AM / Score 78 / stage bar + Deep 1h10m·Light 4h05m·REM 1h35m·Awake 0h15m, the 7-night stacked-stage trend with day labels, and the recent-nights list with per-night stage bars.
- ISC-252: DEFERRED-VERIFY — no live prod sleep sync has run; the adapter's all-null-on-nonempty-payload `console.warn` (key set only) is the trigger to confirm/refute the field mapping on the first real sync. Follow-up: FOLLOWUP-cadence-sleep-live-shape.
- Suite: `bunx tsc --noEmit` clean; `bun test` 206 pass / 0 fail across 18 files (18 new sleep tests + 2 MCP tool-count assertions updated 15→16).

### Whimsy rebrand DEPLOY round (2026-07-19, commit 52da290 live)

- Preflight: tree clean, 194 tests green, tsc clean, zero package.json/bun.lock diff vs deployed base 0c387a8, box service active, /health ok, 17G disk free.
- Backup: cadence-pre-whimsy-20260720T022003.db on box via readonly VACUUM INTO (94KB), activities baseline 52.
- Ship: git archive HEAD staged to scratchpad, rsync -az no --delete (env/DB/garmin-tokens untouched by construction), systemctl restart, service active.
- Smoke: fit.austinfiala.com/health 200 ok; suretas.com/health 200 and austinfiala.com 200 (no collateral); served styles.css carries 4 new-palette hexes; served index carries mascot + new copy; /api/activities 401 unauthenticated; nutrition_entries + nutrition_items tables present (guarded migration landed); activities 52 after restart (data intact); icon-192 served md5 == local md5; live Interceptor render through the real session shows the full rebrand with real training data.
- Disclosure: nutrition MVP (3fcfc42) went live in the same artifact because it was already committed on main; estimation is manual-fallback-only until ANTHROPIC_API_KEY is set on the box (FOLLOWUP-cadence-nutrition-live-estimate unchanged).

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

- conjectured: browser verification could proceed on this machine as it had on 2026-07-13, by launching the dedicated automation Chromium profile and driving it through Interceptor (VERIFY, 2026-07-21). refuted by: "no extensions connected" on every attempt; investigation showed two independent breaks: the automation profile's NativeMessagingHosts dir was missing the com.interceptor.host.json manifest entirely, and the only packed extension in the profile was KDE Plasma Integration, not Interceptor, which loads unpacked from ~/Projects/interceptor/extension/dist and had dropped out of the profile. learned: the Interceptor stack on Linux has three coupling points that must all agree: the unpacked extension path (extension/dist, whose path-derived ID must appear in allowed_origins), the native-host manifest present in EACH profile's own NativeMessagingHosts dir (a custom --user-data-dir does not inherit the default profile's), and a launch command that passes --load-extension explicitly. Fixed all three; the working launch is now: chromium --user-data-dir=~/.config/chromium-interceptor-profile --load-extension=~/Projects/interceptor/extension/dist. criterion now: ISC-281 verified through the repaired stack; gotcha recorded in the Interceptor skill.
- conjectured: the garmin-connect-sdk sleep endpoints (`sleep.getSleepRange` / `getDailySleep`) would return usable sleep data the way `activities.list` does, so `listRecentSleep` could call them directly and map the result (BUILD, 2026-07-20). refuted by: the first real prod sync returned `sleep_seen: 0` with no error, and a raw probe on the box showed the SDK throwing `GarminValidationError` — its zod schema declares `sleepStartTimestampLocal`/`sleepEndTimestampLocal` as `string` but live Garmin sends epoch-millisecond `number`s, so validation fails on every night. learned: an alpha-pinned SDK's declared schema is not the live contract; for the sleep path the SDK's own validation is the failure point, and the fix belongs at the transport boundary (a custom `fetch` passed to the SDK that coerces just those two fields before validation) rather than abandoning the SDK or its auth/retry machinery. The best-effort try/catch that made this non-fatal also made it silent — the load-bearing lesson is that "degrade to null" needs a paired observability hook (which the advisor forced, ISC-252) AND a real live probe before declaring a DEFERRED-VERIFY closed. criterion now: ISC-244/252 verified against real data; the coercion is documented in client.ts as the one-file blast radius the src/garmin/ isolation was built for.
- conjectured: the PWA service worker would serve stale CSS after the whimsy restyle deployed, so ISC-232 required a cache version bump (OBSERVE premortem, 2026-07-19). refuted by: reading sw.js — it is a deliberate no-op passthrough registered solely to satisfy Chromium installability (ISC-162), with no Cache storage and every request falling through to network. learned: premortems built on how a mechanism usually works must be probed against how this project actually built it before they become criteria; Cadence's sw.js is intentionally cache-free, so asset staleness is a browser-HTTP-cache concern, not a service-worker one. criterion now: ISC-232 tombstoned; no cache-bump step exists in the deploy path.

- conjectured: inline SVG data URIs in CSS url() with raw angle brackets would render decorative patterns, since the pattern is common in shipped sites (whimsy build, 2026-07-19). refuted by: live render in real Chrome — computed style carried the background-image but the image failed to load (Image onerror), with or without %3C encoding, while the same visual intent expressed as radial-gradient and text-decoration wavy rendered instantly. learned: for decorative CSS effects prefer primitives the CSS engine draws natively (gradients, text-decoration) over embedded-document parsing (SVG data URIs), which fail silently and cost debugging rounds; also, synthetic Ctrl+Shift+R does not hard-reload Chrome, so CSS verification needs an explicit cache-bust of the stylesheet link. criterion now: ISC-240's whimsy devices are implemented as wavy text-decoration underlines and radial-gradient dot fields, both confirmed in screenshots.

- conjectured: garmin-connect-client was the right library because it alone documented an MFA resume flow (ISC-24 decision at build time). refuted by: first real sync in production — its native dependency node-libcurl-ja3 binds raw V8 C++ APIs (undefined symbol v8::Object::DefineOwnProperty) that Bun does not implement; the module can never load under Bun, and every sync crashed the service (systemd auto-restart absorbed it). learned: for a Bun deployment, "zero native modules" is a HARD library-selection criterion that outranks feature checklists — a dependency's install scripts being blocked by default (bun pm untrusted) is the early warning, and MFA-capability claims must be probed on the deploy runtime, not on paper. criterion now: ISC-92 effectively extends to "no native .node modules in the production tree" (verified: find -name '*.node' → 0 after the swap), and ISC-24's choice is superseded by garmin-connect-sdk@1.0.0-alpha.4 (pure TS, typed MFA errors, FileTokenStorage restore) — exact-pinned per ISC-101, isolated per ISC-100, which made the swap a one-file change exactly as designed.

- conjectured: the static handler would serve /img/stretch/ subdirectory files because fonts/ appeared to be a served subdirectory (stretch-plan brief, 2026-07-16). refuted by: reading src/server.ts — STATIC_ROUTES is a flat allowlist where every fonts file is its own explicit key; no wildcard or directory serving exists, so subdirectory files 404'd into the app-shell fallthrough. learned: Cadence's static surface is a deliberate explicit allowlist (part of the health-data-private-by-construction posture); any new static asset class needs its own route, and that route must constrain the path to a server-composed string. criterion now: ISC-106 passes through a regex-gated route (`^/img/stretch/([a-z0-9-]+)\.svg$`) with traversal probes verified live and a charset-reject test in the suite.

