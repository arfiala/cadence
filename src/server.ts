// Cadence's HTTP server. Bun.serve directly — no framework (ISA Principle:
// "trust the framework"). Routes /health and /auth/login unauthenticated,
// everything under /api/* behind a session cookie OR bearer token (ISC-19),
// and serves the single static app shell + assets for everything else.

import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import "./db"; // runs migrations on import
import { jsonError } from "./lib/http";
import { handleAuth } from "./routes/auth";
import { requireAuth } from "./auth/session";
import { listActivities, createActivity, updateActivity, deleteActivity } from "./routes/activities";
import { getWeek } from "./routes/week";
import { getTrends } from "./routes/trends";
import { getSettingsRoute, patchSettingsRoute } from "./routes/settings";
import { postSync, getSyncStatus } from "./routes/sync";
import { getSleep } from "./routes/sleep";
import { importCsv } from "./routes/csv";
import { postZwiftPowerSync, getZwiftPowerResults, getZwiftPowerStatus } from "./routes/zwiftpower";
import { getTrainingLoad, getConsistency, getRecords, getDigest, getWeight, getG1Risk, getPacing, getYoy, getPowerCurveRoute } from "./routes/metrics";
import { handleGolfRounds } from "./routes/golf";
import { getActivityDetail } from "./routes/activityDetail";
import { getPlanWeek, getPlanSummary, patchPlanStatus, getPlanAdaptations } from "./routes/plan";
import { getDuplicates, postDismissDuplicate, postUndismissDuplicate, postMergeDuplicate } from "./routes/duplicates";
import {
  estimateNutritionRoute,
  createNutrition,
  listNutrition,
  nutritionHistory,
  updateNutrition,
  deleteNutrition,
} from "./routes/nutrition";
import { createRealGarminClient } from "./garmin/client";
import { startScheduler } from "./garmin/sync";
import { createRealZwiftPowerClient } from "./zwiftpower/client";
import { isZwiftPowerConfigured } from "./zwiftpower/config";
import { startZpScheduler } from "./zwiftpower/sync";

const PORT = Number(process.env.PORT ?? 4100);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

// Serves a file from public/ by relative path. Path is always a fixed,
// server-chosen string per route below — never taken verbatim from the
// request path — so there is no traversal surface here.
function serveStatic(relativePath: string): Response {
  try {
    const fullPath = join(PUBLIC_DIR, relativePath);
    const bytes = readFileSync(fullPath);
    const type = MIME_TYPES[extname(fullPath)] ?? "application/octet-stream";
    // no-cache forces revalidation on every load. Without it Chrome's
    // heuristic caching kept serving stale app.js/styles.css after deploys
    // (observed 2026-07-21: a deployed CSS fix stayed invisible until a
    // cache-busted fetch). One user, small files: correctness beats 304s.
    return new Response(bytes, {
      headers: { "Content-Type": type, "Cache-Control": "no-cache" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const auth = requireAuth(req);
  if (auth instanceof Response) return auth;

  const path = url.pathname;
  const method = req.method;

  if (path === "/api/activities" && method === "GET") return listActivities(url);
  if (path === "/api/activities" && method === "POST") return createActivity(req);

  // Lazy per-activity Garmin detail (ISC-319). Matched before the bare
  // /:id route below; the detail suffix keeps the two patterns disjoint.
  const detailMatch = /^\/api\/activities\/(\d+)\/detail$/.exec(path);
  if (detailMatch !== null && method === "GET") {
    return getActivityDetail(url, detailMatch[1] as string, createRealGarminClient);
  }

  const activityMatch = /^\/api\/activities\/(\d+)$/.exec(path);
  if (activityMatch !== null) {
    const id = activityMatch[1] as string;
    if (method === "PATCH") return updateActivity(req, id);
    if (method === "DELETE") return deleteActivity(url, id);
  }

  // Duplicate review (ISC-310..312). On-demand only; never in the sync path.
  if (path === "/api/duplicates" && method === "GET") return getDuplicates();
  if (path === "/api/duplicates/dismiss" && method === "POST") return postDismissDuplicate(req);
  if (path === "/api/duplicates/undismiss" && method === "POST") return postUndismissDuplicate(req);
  if (path === "/api/duplicates/merge" && method === "POST") return postMergeDuplicate(req);

  if (path === "/api/week" && method === "GET") return getWeek(url);
  if (path === "/api/trends" && method === "GET") return getTrends(url);

  if (path === "/api/settings" && method === "GET") return getSettingsRoute();
  if (path === "/api/settings" && method === "PATCH") return patchSettingsRoute(req);

  if (path === "/api/sync" && method === "POST") return postSync();
  if (path === "/api/sync/status" && method === "GET") return getSyncStatus();

  if (path === "/api/sleep" && method === "GET") return getSleep(url);

  if (path === "/api/zwiftpower/sync" && method === "POST") return postZwiftPowerSync();
  if (path === "/api/zwiftpower/results" && method === "GET") return getZwiftPowerResults();
  if (path === "/api/zwiftpower/status" && method === "GET") return getZwiftPowerStatus();

  if (path === "/api/golf/rounds" && method === "GET") return handleGolfRounds();
  if (path === "/api/metrics/training-load" && method === "GET") return getTrainingLoad(url);
  if (path === "/api/metrics/consistency" && method === "GET") return getConsistency();
  if (path === "/api/metrics/records" && method === "GET") return getRecords();
  if (path === "/api/metrics/digest" && method === "GET") return getDigest();
  if (path === "/api/metrics/weight" && method === "GET") return getWeight();
  if (path === "/api/metrics/g1-risk" && method === "GET") return getG1Risk();
  if (path === "/api/metrics/pacing" && method === "GET") return getPacing();
  if (path === "/api/metrics/yoy" && method === "GET") return getYoy();
  if (path === "/api/metrics/power-curve" && method === "GET") return getPowerCurveRoute();

  if (path === "/api/import/csv" && method === "POST") return importCsv(req);

  // Training plan (planned workouts). Read and mark-only; content is seeded.
  if (path === "/api/plan/week" && method === "GET") return getPlanWeek(url);
  if (path === "/api/plan/summary" && method === "GET") return getPlanSummary();
  if (path === "/api/plan/adaptations" && method === "GET") return getPlanAdaptations();
  const planMatch = /^\/api\/plan\/(\d+)$/.exec(path);
  if (planMatch !== null && method === "PATCH") return patchPlanStatus(req, planMatch[1] as string);

  // Nutrition (ISC-199..205). All behind the same /api/* auth gate above.
  if (path === "/api/nutrition/estimate" && method === "POST") return estimateNutritionRoute(req);
  if (path === "/api/nutrition/history" && method === "GET") return nutritionHistory(url);
  if (path === "/api/nutrition" && method === "GET") return listNutrition(url);
  if (path === "/api/nutrition" && method === "POST") return createNutrition(req);

  const nutritionMatch = /^\/api\/nutrition\/(\d+)$/.exec(path);
  if (nutritionMatch !== null) {
    const id = nutritionMatch[1] as string;
    if (method === "PATCH") return updateNutrition(req, id);
    if (method === "DELETE") return deleteNutrition(url, id);
  }

  return jsonError("Not found", 404);
}

const STATIC_ROUTES: Record<string, string> = {
  "/app.js": "app.js",
  "/styles.css": "styles.css",
  "/fonts/space-grotesk-400.woff2": "fonts/space-grotesk-400.woff2",
  "/fonts/space-grotesk-500.woff2": "fonts/space-grotesk-500.woff2",
  "/fonts/space-grotesk-700.woff2": "fonts/space-grotesk-700.woff2",
  "/fonts/inter-400.woff2": "fonts/inter-400.woff2",
  "/fonts/inter-500.woff2": "fonts/inter-500.woff2",
  "/fonts/inter-700.woff2": "fonts/inter-700.woff2",
  // PWA install assets (ISC-153..155, ISC-162). Each is its own explicit
  // allowlist entry, matching the flat static-route discipline: the served
  // path is always a fixed server-chosen string, never the raw request path.
  "/manifest.webmanifest": "manifest.webmanifest",
  "/sw.js": "sw.js",
  "/icon-192.png": "icon-192.png",
  "/icon-512.png": "icon-512.png",
  "/icon-512-maskable.png": "icon-512-maskable.png",
  "/apple-touch-icon.png": "apple-touch-icon.png",
};

type IpProvider = { requestIP(req: Request): { address: string } | null };

export async function fetchHandler(req: Request, server: IpProvider): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/health") {
    return Response.json({ status: "ok", service: "cadence" });
  }

  if (path.startsWith("/auth/")) {
    const ip = server.requestIP(req)?.address ?? "unknown";
    return handleAuth(req, url, ip);
  }

  if (path.startsWith("/api/")) {
    return handleApi(req, url);
  }

  const staticFile = STATIC_ROUTES[path];
  if (staticFile !== undefined) {
    return serveStatic(staticFile);
  }

  // Stretch illustrations live in a subdirectory (public/img/stretch/), unlike
  // the flat allowlist above. The slug is constrained to [a-z0-9-] with a fixed
  // `.svg` suffix, so there is no `.`/`/` for a traversal — the served path is
  // still a server-composed fixed string, never the raw request path.
  const stretchImg = /^\/img\/stretch\/([a-z0-9-]+)\.svg$/.exec(path);
  if (stretchImg !== null) {
    return serveStatic(join("img", "stretch", `${stretchImg[1]}.svg`));
  }

  // Every other path (including "/") serves the single app shell. The HTML
  // itself never embeds health data (ISC-58) — the shell's JS calls the
  // authenticated API and toggles between a login view and the dashboard.
  return serveStatic("index.html");
}

export function startServer() {
  const server = Bun.serve({
    port: PORT,
    fetch: (req, srv) => fetchHandler(req, srv),
  });

  // Wire the actual Garmin client factory into the scheduler here (not in
  // sync.ts, which stays client-agnostic) so tests that import sync.ts
  // never trigger a real scheduler.
  if (process.env.CADENCE_DISABLE_SCHEDULER !== "1") {
    startScheduler(createRealGarminClient);
    // ZwiftPower stays fully dormant unless credentials are configured
    // (ISC-131): no scheduler entry, no background work, no errors.
    if (isZwiftPowerConfigured()) {
      startZpScheduler(createRealZwiftPowerClient);
    }
  }

  return server;
}

if (import.meta.main) {
  const server = startServer();
  console.log(`Cadence listening on http://localhost:${server.port}`);
}
