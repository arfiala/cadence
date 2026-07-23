#!/usr/bin/env bun
// bin/probe-golf.ts — one-shot LIVE probe (ISC-421): can the existing Garmin
// session reach the Garmin Golf scorecard endpoints? Run on the box where
// garmin-tokens/ lives. Read-only against Garmin; prints status + a redacted
// shape summary, never full personal data.
//
// Endpoint paths verified against python-garminconnect (community-maintained):
// /gcs-golfcommunity/api/v2/scorecard/summary | /detail | /shot/scorecard.

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
// Trigger one lightweight authenticated call so the capturing fetch sees headers.
await sdk.activities.listAll({ limit: 1 } as any).catch(() => {});
if (!captured.headers) {
  console.log("PROBE FAIL: no auth headers captured from SDK traffic");
  process.exit(1);
}
console.log("auth headers captured:", Object.keys(captured.headers).join(", "));

const res = await fetch(
  "https://connectapi.garmin.com/gcs-golfcommunity/api/v2/scorecard/summary?per-page=50",
  { headers: captured.headers },
);
console.log("scorecard summary status:", res.status, res.headers.get("content-type"));
const text = await res.text();
if (res.ok && (res.headers.get("content-type") ?? "").includes("json")) {
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j.scorecardSummaries ?? j.summaries ?? j.items ?? null);
    console.log("top-level keys:", Array.isArray(j) ? "(array)" : Object.keys(j).join(", "));
    if (Array.isArray(arr)) {
      console.log("scorecard count:", arr.length);
      if (arr[0]) console.log("first item keys:", Object.keys(arr[0]).join(", "));
    }
  } catch {
    console.log("PROBE WARN: 200 but unparseable JSON, first 200 chars:", text.slice(0, 200));
  }
} else {
  console.log("body head (redacted probe):", text.slice(0, 200).replace(/\s+/g, " "));
}
