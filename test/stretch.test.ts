// Stretch-feature tests (ISC-106, ISC-109). Two load-bearing guarantees:
//   1. A logged ATG stretch session (sport=strength) NEVER counts toward G1
//      qualification — it must not inflate the week's session/hours numbers.
//   2. The stretch illustrations, which live in a subdirectory (unlike the
//      flat static allowlist), are actually served, and the safe-slug gate
//      does not let a request escape that directory.

import { test, expect, describe, beforeEach } from "bun:test";
import { resetDb, insertActivity } from "./helpers";
import { isG1Qualifying } from "../src/week";
import { computeWeekSummary } from "../src/services/weekSummary";
import { fetchHandler } from "../src/server";

const stubServer = { requestIP: (_req: Request) => ({ address: "127.0.0.1" }) };

describe("a stretch session never counts toward G1 (ISC-109)", () => {
  beforeEach(() => resetDb());

  test("isG1Qualifying('strength') is false", () => {
    expect(isG1Qualifying("strength")).toBe(false);
  });

  test("a logged ATG stretch does not increment the week's qualifying sessions", () => {
    // One genuine qualifying session for the week (cycling, 1h)...
    insertActivity({ sport: "cycling", start_time: "2026-07-13T10:00:00Z", duration_s: 3600 });
    // ...plus the stretch session the Log button creates (strength, 15 min).
    insertActivity({
      sport: "strength",
      start_time: "2026-07-14T10:00:00Z",
      duration_s: 15 * 60,
      title: "ATG Daily Stretch",
      notes: "Knees Over Toes daily plan",
    });

    const summary = computeWeekSummary(new Date("2026-07-14T12:00:00Z"));
    // Session count and G1 hours reflect ONLY the cycling activity.
    expect(summary.sessions).toBe(1);
    expect(summary.hours_g1).toBe(1);
    // The stretch still shows up in all-sport hours (1 + 0.25, rounded to
    // one decimal → 1.3), just not in G1 hours.
    expect(summary.hours_total).toBe(1.3);
  });
});

describe("stretch SVGs served from a subdirectory (ISC-106)", () => {
  test("serves an existing stretch SVG with the svg mime type", async () => {
    const res = await fetchHandler(
      new Request("http://localhost/img/stretch/backward-walk.svg"),
      stubServer,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  test("a slug outside the safe [a-z0-9-] charset is not served as a file", async () => {
    // Uppercase + underscore fall outside the safe-slug gate, so the route
    // never matches and the request falls through to the SPA shell (HTML) —
    // it is never read as an arbitrary file.
    const res = await fetchHandler(
      new Request("http://localhost/img/stretch/Backward_Walk.svg"),
      stubServer,
    );
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });
});
