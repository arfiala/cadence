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
import { importCsv } from "./routes/csv";
import { createRealGarminClient } from "./garmin/client";
import { startScheduler } from "./garmin/sync";

const PORT = Number(process.env.PORT ?? 4100);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// Serves a file from public/ by relative path. Path is always a fixed,
// server-chosen string per route below — never taken verbatim from the
// request path — so there is no traversal surface here.
function serveStatic(relativePath: string): Response {
  try {
    const fullPath = join(PUBLIC_DIR, relativePath);
    const bytes = readFileSync(fullPath);
    const type = MIME_TYPES[extname(fullPath)] ?? "application/octet-stream";
    return new Response(bytes, { headers: { "Content-Type": type } });
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

  const activityMatch = /^\/api\/activities\/(\d+)$/.exec(path);
  if (activityMatch !== null) {
    const id = activityMatch[1] as string;
    if (method === "PATCH") return updateActivity(req, id);
    if (method === "DELETE") return deleteActivity(url, id);
  }

  if (path === "/api/week" && method === "GET") return getWeek(url);
  if (path === "/api/trends" && method === "GET") return getTrends(url);

  if (path === "/api/settings" && method === "GET") return getSettingsRoute();
  if (path === "/api/settings" && method === "PATCH") return patchSettingsRoute(req);

  if (path === "/api/sync" && method === "POST") return postSync();
  if (path === "/api/sync/status" && method === "GET") return getSyncStatus();

  if (path === "/api/import/csv" && method === "POST") return importCsv(req);

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
  }

  return server;
}

if (import.meta.main) {
  const server = startServer();
  console.log(`Cadence listening on http://localhost:${server.port}`);
}
