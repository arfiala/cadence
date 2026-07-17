---
task: Cadence — Austin's personal fitness app (Garmin-synced, MCP-editable)
project: cadence
effort: E4
phase: build
progress: 96/117
mode: standard
started: 2026-07-16T19:50:29Z
updated: 2026-07-16T23:28:00Z
---

## Problem

Austin trains toward TELOS G1 (5 swim/bike sessions per week, ≥8 hours) but his training data is scattered: Zwift rides in Zwift, watch activities in Garmin Connect, and a hand-maintained `TRAINING_LOG.md` that is empty because manual logging never survives contact with a newborn's schedule. There is no single place that answers "how is my training week going," and no way for his DA to read or fix that data conversationally. MyFitnessPal nutrition is explicitly OUT of v1 (Austin's call, 2026-07-16); the model leaves room for it.

## Vision

Austin asks "how's my week" in any conversation and gets an answer from his real training data — sessions, hours, the G1 gap — without opening anything. When something is wrong ("that was a swim, not a ride"), he says so and it's fixed. Opening fit.austinfiala.com on his phone shows the week at a glance in the same visual language as his personal site. Euphoric surprise: the app disappears into conversation; the dashboard is just the proof.

## Out of Scope

Nutrition/MyFitnessPal integration (deferred by Austin, v2 candidate). Multi-user anything: registration, roles, sharing. Training PLANS and coaching logic (v1 is truth about what happened, not prescriptions) — AMENDED 2026-07-16: Austin explicitly requested a static ATG daily stretching plan (ISC-104+); the exclusion now covers dynamic/adaptive coaching logic only, not this fixed reference plan. Native mobile apps. Strava. Direct Zwift API integration — Zwift reaches the app through Zwift's own auto-upload to Garmin Connect. Public visibility of any health data. Charts libraries and frontend frameworks — inline SVG and vanilla JS only, matching austinfiala.com's zero-dependency ethos.

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
- [DEFERRED-VERIFY] ISC-29: Garmin session tokens persisted to disk (mode 600) so MFA is not re-prompted every sync — probe: stat + re-sync without re-auth in mock
- [x] ISC-30: Scheduled sync every 6h in-process; "Sync now" button and MCP tool trigger the same code path — probe: bun test single implementation
- [x] ISC-31: Concurrent sync attempts collapse (second request returns 'already running') — probe: bun test parallel trigger
- [x] ISC-32: Sync maps Garmin activity types → sport vocabulary incl. virtual_ride→virtual_cycling, lap_swimming/open_water→swimming — probe: bun test mapping table
- [DEFERRED-VERIFY] ISC-33: DEFERRED-VERIFY: live pull of Austin's real Garmin activities once he sets credentials — follow-up: FOLLOWUP-cadence-live-garmin — probe: sync_runs row with real counts
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
- [ ] ISC-104: "Stretch" tab appears in the nav and switches to the stretch view — probe: Interceptor click
- [ ] ISC-105: Plan data contains exactly 8 items in ATG order (backward-walk warm-up, ATG split squat, couch stretch, elephant walk, pancake good morning, butterfly, pigeon, calf stretch), each with name, dose, target area, coaching cue — probe: data read + count
- [ ] ISC-106: All 8 stretch SVGs served 200 from /img/stretch/ — probe: curl ×8
- [ ] ISC-107: Anti: SVGs make zero external requests (no http refs inside) — probe: grep
- [ ] ISC-108: "Log stretch session" button creates a manual activity (sport=strength, 15 min, title "ATG Daily Stretch") via the existing activities API — probe: click + API read-back
- [ ] ISC-109: Anti: a logged stretch session never counts toward G1 qualification — probe: bun test
- [ ] ISC-110: Log button disables during the request (double-submit guard, Suretas lesson) — probe: code grep + double-click test
- [ ] ISC-111: After logging, the view shows a "done today" state that survives reload (derived from today's activities) — probe: Interceptor reload
- [ ] ISC-112: Anti: zero new runtime dependencies — probe: package.json/bun.lock diff
- [ ] ISC-113: Anti: zero schema changes — probe: db.ts diff
- [ ] ISC-114: bun test green (incl. new tests) and bunx tsc --noEmit clean — probe: Bash
- [ ] ISC-115: Stretch view single-column readable at 375px via existing responsive CSS — probe: CSS structural check (phone screenshot rides FOLLOWUP-cadence-ui-pass)
- [ ] ISC-116: Anti: dashboard, activities, trends, sync views render unchanged — probe: Interceptor spot-check
- [ ] ISC-117: Deployed to production and the stretch tab live-verified — probe: Interceptor on fit.austinfiala.com (gated on Austin's deploy approval)

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

## Decisions

- 2026-07-16T19:50Z — Scope set by Austin via AskUserQuestion: hosted "in my personal website... with a login" → fit.austinfiala.com subdomain on the existing box, linked from the site nav (a path under the static site would force base-path handling and a mixed Caddy block; a subdomain keeps both sites clean — flagged to Austin in the summary). Nutrition/MFP: skipped for v1, his call. Garmin auth: "decide for me" → MFA-capable library with token persistence, credentials in box .env only. Python: not approved; TypeScript only, blockers come back to him.
- 2026-07-16T19:50Z — Zwift integration is DELIBERATELY indirect: Zwift auto-uploads completed rides to Garmin Connect when linked (verified via Zwift/Garmin support + community docs 2026-07-16), so one Garmin integration covers Zwift + outdoor rides + swims. Direct Zwift API is unofficial, unstable, and adds nothing once linking is on.
- 2026-07-16T19:50Z — ISC floor math (E4 soft ≥128): natural granularity yielded 103 atomic ISCs (98 + 5 advisor-driven). Shown math rather than padded: v1 has ONE integration (nutrition deferred by Austin's answer), one user (no RBAC surface), and no payment/email subsystems — the domains that inflate counts in comparable apps are structurally absent. Every ISC above is one tool probe; splitting further would manufacture rows, not tests.
- 2026-07-16T20:05Z — Advisor pre-build review (Rule 2): confirmed the one-resident-service topology (MCP spawned on demand on Austin's machine, sync in-process — the box gains exactly one daemon); added ISC-99 (CSV import survival path for when the unofficial Garmin lib breaks — and they do break), ISC-100 (lib isolated to src/garmin/), ISC-101 (exact version pin), ISC-102 (lockout self-DoS escape: auto-expiry + CLI clear), ISC-103 (anti: no extra daemons). Token-scoping suggestion partially adopted: the bearer token is already separately issued, hashed, and revocable (ISC-20/21) which covers rotate-without-password; per-tool scoping rejected as over-engineering for a single-user personal app. Advisor's state-mismatch warning was an --auto-state artifact (it read the previous task's ISA); the builder receives this file's absolute path pinned verbatim.
- 2026-07-16T19:50Z — Delegation: Engineer agent builds from this ISA (session-standard; codex absent → `SOURCE: codex-unavailable`, Forge slot falls back to Engineer). Primary (me) does independent verification, deploy, DNS/Caddy surgery on the shared box, and the MCP registration on this machine.
- 2026-07-16T23:28Z — Stretch plan (Austin: "build a daily stretching plan based off of the kneesovertoes guy, create images for it, add it to the fitness app"). Content grounded in fetched sources this session (a1athlete.com ATG stretch guide; Ben Patrick's own TikTok note that couch stretch belongs AFTER ATG split squat; search-corroborated doses: pancake pulses ×20, couch 45-60s/side, elephant walk ×20). Out of Scope amended (fixed plan in, adaptive coaching still out). Images: hand-authored SVG — probed this session: no image-gen keys on this box (KNOWLEDGE/Research/linux-machine-image-gen-gap.md still accurate). Log-as-activity uses sport=strength (isG1Qualifying filters to cycling/swim family, so G1 stays clean — ISC-109 tests it). Deploy gated on Austin's explicit approval per Permission Boundaries; everything staged ready. `SOURCE: codex-unavailable` re-probed this session — Forge slot again falls back to Engineer.

## Verification

(populated at VERIFY)

### Primary-agent verification round (2026-07-16, post-build)
- ISC-73..85: pushed nothing (local repo, no remote yet); /opt/cadence created, clean git-archive rsync, `bun install --production` (237 pkgs), .env mode 600 with generated SESSION_SECRET, systemd unit enabled+active, DNS A record live on authoritative NS, Caddy block appended after timestamped backup + validate + RELOAD, all three sites healthy after (suretas /health 200, austinfiala 200, fit /health 200 over valid TLS), Fitness footer link live on austinfiala.com, no secrets in git history (new repo, .env gitignored from first commit), box has 125MB available with all services active.
- ISC-95: real prod login as arfiala@gmail.com via Interceptor — dashboard rendered, logged out after.
- ISC-96/98: MCP stdio round-trip against prod — 8 tools listed, get_goal_progress returned the G1 gap line, log_activity created row id 1, delete refused without confirm=true then deleted with it, list confirmed clean after.
- ISC-70: ~/.claude/.mcp.json registers `cadence` (stdio, env-wired); handshake + tool calls proven by the round-trip driver.
- ISC-48/49/50/54/55/58: local walkthrough — dashboard gap line ("1 sessions, 0.8 h — need 4 more..."), list with MANUAL badge, add-form round-trip (45min/1.8km swim persisted as 2700s/1800m), unauthenticated / serves only the login form, brand fonts/palette rendered; escapeHtml verified by grep.
- ISC-97: TRAINING_LOG.md carries the supersession pointer to Cadence + MCP.
- DEFERRED (FOLLOWUP-cadence-ui-pass): ISC-51/52/53/56/59/94 — edit/delete via UI, trends view, sync button, 375px, session-expiry redirect, full click-through in one pass. DEFERRED (FOLLOWUP-cadence-live-garmin): ISC-29/33 — need Austin's Garmin credentials in /opt/cadence/.env, then one manual sync verifies both.

## Changelog

- conjectured: garmin-connect-client was the right library because it alone documented an MFA resume flow (ISC-24 decision at build time). refuted by: first real sync in production — its native dependency node-libcurl-ja3 binds raw V8 C++ APIs (undefined symbol v8::Object::DefineOwnProperty) that Bun does not implement; the module can never load under Bun, and every sync crashed the service (systemd auto-restart absorbed it). learned: for a Bun deployment, "zero native modules" is a HARD library-selection criterion that outranks feature checklists — a dependency's install scripts being blocked by default (bun pm untrusted) is the early warning, and MFA-capability claims must be probed on the deploy runtime, not on paper. criterion now: ISC-92 effectively extends to "no native .node modules in the production tree" (verified: find -name '*.node' → 0 after the swap), and ISC-24's choice is superseded by garmin-connect-sdk@1.0.0-alpha.4 (pure TS, typed MFA errors, FileTokenStorage restore) — exact-pinned per ISC-101, isolated per ISC-100, which made the swap a one-file change exactly as designed.

