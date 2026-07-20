# Cadence Deploy Notes

Bootstrapped 2026-07-17 from the deploy records in the project ISA and PAI PROJECTS.md (stretch-tab deploy was the reference run). Read before every deploy, append a log line after.

## Target

- Host: suretas-prod Lightsail instance, ubuntu@44.200.119.114
- SSH key: ~/.ssh/lightsail/suretas-deploy.pem
- App dir: /opt/cadence, service: cadence.service (port 4100)
- Public: https://fit.austinfiala.com via the shared Caddy (third site on the box, alongside suretas.com and austinfiala.com)
- Caddy rule: backup-then-reload, never restart. App-only deploys do not touch Caddy at all.

## Method

1. Clean tree check locally: git status clean, tests green, tsc clean.
2. WAL-safe DB backup ON THE BOX before any restart when the deploy carries a migration: run a bun one-liner in /opt/cadence using VACUUM INTO, writing ~/db-backups/cadence-pre-<slug>-<UTCstamp>.db. sqlite3 CLI is not assumed present on the instance.
3. Export a clean copy locally with git archive (never rsync the working tree: a concurrent session may have uncommitted changes).
4. rsync -az the export to /opt/cadence WITHOUT --delete. The untracked prod .env and the DB survive because nothing deletes them. Never rsync individual files into the root (path-flattening gotcha from Suretas).
5. sudo systemctl restart cadence.
6. Verify (see smoke set).
7. Append a deploy log line below.

## Secrets on target (names only)

- /opt/cadence/.env mode 600: GARMIN_USERNAME, GARMIN_PASSWORD (GARMIN_MFA_CODE transient), SESSION/TOKEN material as applicable, and since 2026-07-17 optionally ZWIFT_USERNAME, ZWIFT_PASSWORD, ZWIFT_PROFILE_ID (ZwiftPower dormant without them).

## Smoke set

- https://fit.austinfiala.com/health returns 200 ok.
- https://suretas.com/health and https://austinfiala.com return 200 (shared box, prove no collateral).
- Served bytes carry the new feature marker for whatever shipped (grep the fetched HTML/JS).
- Auth gate intact: a data API route returns 401 unauthenticated.
- Migration landed: probe the new table/columns via a read-only bun one-liner on the box.
- Austin's real data intact: activities count unchanged by deploy.
- UI render: Interceptor on the live site through Austin's real session, render-only, never click data-creating buttons in prod.

## Gotchas

- Rollback = git archive of the previous commit, same rsync, restart. DB restore only if a migration misbehaved: stop service, copy backup over, start.
- Guarded additive migrations run at boot; they are idempotent by pattern (pragma_table_info guards).
- The box is near capacity (~125MB headroom noted 2026-07-16); a fourth service needs a size bump, and big node_modules growth matters.
- node_modules IS rsynced from the local export? NO: git archive exports tracked files only, so dependencies must be installed on the box when package.json changes: run bun install --production in /opt/cadence after rsync when deps changed.

## Deploy log

- 2026-07-19 (UTC 07-20, follow-up): commit for wavy-underline removal, CSS-only. Same archive-rsync method, no restart needed (statics served from disk), no backup (no migration). Live bytes verified wavy-free, health 200, Interceptor render confirmed titles clean, rest of rebrand intact.
- 2026-07-19 (UTC 07-20): commit 52da290 (whimsy rebrand ISC-221..242, PLUS nutrition MVP 3fcfc42 riding along since it was already on main; nutrition estimation degrades to manual entry until ANTHROPIC_API_KEY lands on the box). Backup cadence-pre-whimsy-20260720T022003.db (VACUUM INTO; bun needs explicit $HOME/.bun/bin PATH over non-interactive ssh). No dep change (bun install skipped), migration = guarded nutrition tables, landed on restart. All three sites 200, new palette + mascot bytes live, icon-192 md5 matches local, /api/activities 401 unauth, activities count 52 before and after, live Interceptor render through the real session showed the full rebrand with real data. Surprise: none. Method exactly as documented above.

- 2026-07-16: Module-era deploys and stretch tab (see ISA Verification rounds for detail). Method as above.
- 2026-07-17: commit dcb31bd (ZwiftPower + training-load + roadmap). Backup cadence-pre-zwiftpower-20260717T185530.db (VACUUM INTO via bun, sqlite3 absent on box). First deploy with a dependency change: bun install --frozen-lockfile on box added the pinned wrapper, 0 native modules confirmed. All three sites 200 after restart, new bytes live, metrics and zwiftpower routes 401 unauthenticated, zwiftpower_results table + power columns present, activities count unchanged (1). Live Interceptor render: Races not-connected panel, Trends fitness/fatigue/form computing real values. Surprise: none. Cosmetic follow-up: single-activity load chart draws a wide block, recheck when real data flows.
