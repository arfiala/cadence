// Modest per-IP fixed-window rate limiter for /auth/login (ISC-23). This is
// deliberately simple in-memory state — Cadence is a single small process
// with no multi-instance deployment, so a Map is sufficient and needs no
// external store. Not intended as a substitute for the lockout counter
// (ISC-13), which is per-account; this is per-source-IP and catches a
// caller hammering many different (or nonexistent) emails.

const WINDOW_MS = 60_000; // 1 minute
const MAX_ATTEMPTS_PER_WINDOW = 10;

type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();

// Exported for tests only, so each test starts from a clean slate rather
// than accumulating state across test files that import this module.
export function _resetRateLimitState(): void {
  buckets.clear();
}

// Returns true if the request should be allowed, false if the caller has
// exceeded MAX_ATTEMPTS_PER_WINDOW login attempts from this IP within the
// current window.
export function allowLoginAttempt(ip: string): boolean {
  const now = Date.now();
  const existing = buckets.get(ip);

  if (existing === undefined || now - existing.windowStart >= WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    return true;
  }

  existing.count += 1;
  return existing.count <= MAX_ATTEMPTS_PER_WINDOW;
}
