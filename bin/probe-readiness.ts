#!/usr/bin/env bun
// bin/probe-readiness.ts — one-shot LIVE probe: can the existing Garmin
// session reach the Training Readiness endpoint? Run on the box where
// garmin-tokens/ lives. Read-only; prints status + a redacted shape summary
// (score presence and level only), never raw personal data dumps.
//
// Endpoint path follows python-garminconnect (community-maintained):
// /metrics-service/metrics/trainingreadiness/{date}

import { GarminConnectSDK, FileTokenStorage } from "garmin-connect-sdk";

const captured: { headers: Record<string, string> | null } = { headers: null };

const capturingFetch: typeof fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : (input?.url ?? String(input));
  if (url.includes("connectapi.garmin.com") && init?.headers) {
    const h: Record<string, string> = {};
    const src = init.headers;
    if (src instanceof Headers) src.forEach((v: string, k: string) => (h[k] = v));
    else Object.assign(h, src);
    if (h.Authorization || h.authorization) captured.headers = h;
  }
  return fetch(input, init);
}) as typeof fetch;

const sdk = new GarminConnectSDK({
  storage: new FileTokenStorage(process.env.GARMIN_TOKEN_DIR ?? "./garmin-tokens"),
  fetch: capturingFetch,
} as any);

const restored = await sdk.restoreSession();
if (!restored) {
  console.log("PROBE FAIL: no restorable Garmin session");
  process.exit(1);
}
await sdk.activities.listAll({ limit: 1 } as any).catch(() => {});
if (!captured.headers) {
  console.log("PROBE FAIL: no auth headers captured from SDK traffic");
  process.exit(1);
}

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const res = await fetch(
  `https://connectapi.garmin.com/metrics-service/metrics/trainingreadiness/${today}`,
  { headers: captured.headers, signal: AbortSignal.timeout(15_000) },
);
console.log(`status: ${res.status}`);
if (!res.ok) process.exit(1);
const body = await res.json();
const list = Array.isArray(body) ? body : [body];
const first = list[0] as { score?: unknown; level?: unknown; calendarDate?: unknown } | undefined;
console.log(
  `shape: entries=${list.length} score=${typeof first?.score === "number" ? "number(" + first.score + ")" : typeof first?.score} level=${typeof first?.level === "string" ? first.level : typeof first?.level} calendarDate=${typeof first?.calendarDate}`,
);
