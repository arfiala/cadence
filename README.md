# Cadence

Austin's personal fitness app — Garmin-synced training log with a
conversational MCP surface, built to track TELOS goal **G1** (5 swim/bike
sessions per week totaling ≥8 hours).

Single-user. Bun + TypeScript + `bun:sqlite`. Zero frontend framework (one
server-rendered HTML page, vanilla JS, inline-SVG charts). Zero external
requests from any page (fonts self-hosted).

## Stack & dependencies

Exactly two runtime npm dependencies (pinned exact):

- **`garmin-connect-client@2.0.0`** — the unofficial Garmin Connect client.
  Chosen because it is the only one of the three candidates
  (`garmin-connect`, `garmin-connect-client`, `@gooin/garmin-connect`) that
  actually implements an **MFA resume flow** and documents **session
  persistence** (`getSession()` / `fromSession()`) — both hard requirements
  in the spec. The other two list "Handle MFA" as an *unchecked TODO* in
  their own READMEs. See `ISA.md` Decisions for the full probe evidence.
- **`@modelcontextprotocol/sdk@1.29.0`** — the MCP server SDK.

Everything else (SQLite, HTTP server, password hashing, argon2id) uses
Bun built-ins. **bun/bunx only — never npm/npx.**

### Native binding note (deploy)

`garmin-connect-client` depends on `node-libcurl-ja3`, a native module that
impersonates a browser TLS fingerprint (Garmin increasingly blocks plain
HTTP clients). Its postinstall compiles from source. On the box run:

```sh
bun install
bun pm trust node-libcurl-ja3   # builds the native binding
```

The library is imported **dynamically** and only when a sync actually runs,
so the server, API, MCP tools, and the entire test suite load fine even if
the native binding is absent (e.g. before `bun pm trust`). The binding is
only required to talk to Garmin for real.

## Layout

```
src/
  server.ts            Bun.serve entry; routing; static shell
  db.ts                schema + migrations (bun:sqlite, WAL, mode 600)
  week.ts              Monday-anchored, America/New_York, DST-safe week math + G1 rule
  auth/                password (argon2id), session/token middleware, rate limit
  routes/              activities, week, trends, settings, sync, csv, auth
  services/            weekSummary (the one G1 aggregation consumer)
  garmin/              THE ONLY place the Garmin library is touched (ISC-100)
    client.ts          dynamic import of garmin-connect-client
    sync.ts            upsert + field-level merge + scheduler + concurrency guard
    mapping.ts         Garmin type → sport vocabulary
    types.ts           GarminClient interface (mocked in tests)
mcp/
  server.ts            stdio MCP server (thin — zero SQL, zero business logic)
  client.ts            HTTP client of the Cadence API (bearer token)
  tools.ts             the 8 tools
bin/
  set-password.ts      create/reset THE single user (clears lockout + sessions)
  issue-token.ts       issue/list/revoke hashed bearer tokens
public/                index.html, app.js, styles.css, self-hosted fonts
test/                  bun test suite (93 tests)
```

## Setup

```sh
bun install
cp .env.example .env          # then edit .env (chmod 600 on the box)
bun bin/set-password.ts austin@example.com "a-long-passphrase"
bun run start                 # http://localhost:4100
```

`/health` is unauthenticated; everything else needs the session cookie
(web login) or a bearer token (MCP/API).

## Password CLI

```sh
bun bin/set-password.ts <email> <password>
```

Creates the single user, or resets that same user's password if one already
exists. Always clears the lockout counter and revokes all sessions — this is
the self-DoS escape hatch (lock yourself out → SSH in → reset). There is no
web registration; SSH access to the box **is** reset ability, by design.

## Token CLI (for the MCP server / API clients)

```sh
bun bin/issue-token.ts [label]        # issue; printed ONCE
bun bin/issue-token.ts --list         # list (no secret material)
bun bin/issue-token.ts --revoke <id>  # or --revoke <raw-token>
```

Only the SHA-256 hash is stored. Copy the token at issue time; it is never
recoverable. Use it as `Authorization: Bearer <token>`, never in a URL.

## Garmin sync

- Isolated entirely in `src/garmin/`. Swapping the library changes one dir.
- Pulls recent activities, upserts by `garmin_id`.
- **Field-level merge**: your edits to `sport`/`title`/`notes` win over
  re-sync; `duration`/`distance` from Garmin always win. Sync **never
  deletes** rows.
- Runs every 6h in-process, plus a manual "Sync now" button / `trigger_sync`
  MCP tool — all the same code path. Concurrent triggers collapse.
- Session tokens persist to `GARMIN_TOKEN_PATH` (mode 600) so MFA is not
  re-prompted every sync.

### First Garmin login (MFA)

Set `GARMIN_EMAIL` / `GARMIN_PASSWORD` in `.env`. If Garmin prompts for MFA,
set `GARMIN_MFA_CODE` transiently, run one sync to establish the session,
then unset it. Every later sync reuses the saved session file.

### Zwift → Garmin linking

Zwift auto-uploads completed rides to Garmin Connect when linked, so one
Garmin integration covers Zwift + outdoor rides + swims. In Zwift:
**Settings → Connections → Garmin Connect** and authorize. Zwift rides then
appear in Cadence as `virtual_cycling` (they count toward G1).

## ZwiftPower race results

ZwiftPower holds race data (finishing category, position, power) that never
flows through Garmin, so Cadence connects to it directly. The feature is
**dormant until configured**: with `ZWIFT_USERNAME` / `ZWIFT_PASSWORD` unset
there is no scheduler, no background work, no errors, and the **Races** tab
shows a "not connected" panel.

To connect, set in `.env`:

- `ZWIFT_USERNAME` / `ZWIFT_PASSWORD`: your Zwift SSO credentials (used to log
  in to ZwiftPower). These live only on the box, never in git, the DB, or logs.
- `ZWIFT_PROFILE_ID`: your numeric ZwiftPower profile id (the number in your
  `zwiftpower.com/profile.php?z=NNNN` URL).
- `ZWIFT_COOKIE_PATH` (optional): where the session cookies are persisted,
  mode 600, so re-auth is not needed every sync. Defaults to
  `./zwiftpower-tokens/session.json`.

**One-time ZwiftPower activation:** your ZwiftPower profile must be activated
once by logging in at `zwiftpower.com` and linking your Zwift account. Until
that is done, the results feed is empty even with valid credentials.

Sync every 6h in-process (only when configured), or on demand via the "Sync
ZwiftPower" button on the Races tab, or the `get_race_results` MCP tool.
Results upsert idempotently and never touch the `activities` table.

## Training load (fitness, fatigue, form)

Cadence computes a TrainingPeaks-equivalent training-load model natively (the
TrainingPeaks partner API is closed to individuals). Per activity it picks the
best available tier: a power-based load when a power number and your FTP are
present, else a heart-rate-based load from average HR and your LTHR, else a
duration estimate. From the daily load series it derives Fitness (42-day
average), Fatigue (7-day average), and Form (freshness), shown as an inline
SVG chart on the **Trends** tab.

Set your thresholds on the Trends tab (or `PATCH /api/settings` with
`ftp_watts` / `lthr_bpm`) for a sharper estimate. With no thresholds set the
duration tier still produces a real number and the UI prompts you to set them.
`GET /api/metrics/training-load` returns the daily series; the
`get_training_load` MCP tool returns the current fitness / fatigue / form and
this week's load.

## CSV import (Garmin-outage survival path)

If the unofficial Garmin library breaks, import history by CSV instead.
Columns: `date,sport,duration_minutes,distance_km,notes` (last two optional).
Upload on the **Sync** tab, or `POST /api/import/csv` (text/csv body or a
`file` multipart field). Rows are imported as manual activities; invalid
rows are skipped and reported, never silently dropped.

## MCP server

`mcp/server.ts` speaks MCP over stdio and is a thin client of the HTTP API —
zero SQL, zero business logic (UI/MCP parity by construction). Reads
`CADENCE_URL` + `CADENCE_TOKEN` from env. Register it with your MCP client:

```json
{
  "mcpServers": {
    "cadence": {
      "command": "bun",
      "args": ["/absolute/path/to/cadence/mcp/server.ts"],
      "env": { "CADENCE_URL": "https://fit.austinfiala.com", "CADENCE_TOKEN": "<issued-token>" }
    }
  }
}
```

Tools: `get_week_summary`, `get_goal_progress`, `list_activities`,
`log_activity`, `edit_activity`, `delete_activity`, `trigger_sync`,
`get_sync_status`, `get_race_results`, `get_training_load`. The three write
tools name Austin's *real training log* in their descriptions (informed model
consent).

## Tests & quality

```sh
bun test              # 93 tests
bunx tsc --noEmit     # zero errors
```

Covered: schema/migrations, the auth quartet (lockout race, enumeration
byte-equality, token revocation, unauthenticated sweep), week math including
DST transitions, sync (idempotent upsert, edit-survives-resync merge,
failure recording, type mapping, concurrency collapse, never-delete), every
API route, CSV import, and every MCP tool against a live test instance plus a
full stdio handshake.

## Deploy

Not done here — deploy, DNS, Caddy, and the production MCP registration are
handled separately (see `ISA.md` ISC-73..85, left unchecked for the deploy
owner). This repo is the built, tested application only.
