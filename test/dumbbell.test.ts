// Dumbbell-workouts + upper-body-stretch tests (ISC-479, ISC-485, ISC-489).
// Three load-bearing guarantees:
//   1. A logged dumbbell workout (sport=strength) NEVER counts toward G1
//      qualification, same contract as the stretch log.
//   2. Every slug in STRETCH_PLAN has a real SVG that serves over the
//      subdirectory route. The slugs are parsed out of public/app.js itself,
//      so adding a plan entry without its illustration fails this suite
//      instead of 404ing silently in the browser.
//   3. The new content blocks (STRETCH_PLAN, DUMBBELL_WORKOUTS, and the
//      Train-tab copy in index.html) carry zero em/en dashes, per the
//      2026-07-17 dash rule for user-facing strings.

import { test, expect, describe, beforeEach } from "bun:test";
import { join } from "node:path";
import { resetDb, insertActivity } from "./helpers";
import { isG1Qualifying } from "../src/week";
import { computeWeekSummary } from "../src/services/weekSummary";
import { fetchHandler } from "../src/server";

const stubServer = { requestIP: (_req: Request) => ({ address: "127.0.0.1" }) };
const appJs = await Bun.file(join(import.meta.dir, "..", "public", "app.js")).text();
const indexHtml = await Bun.file(join(import.meta.dir, "..", "public", "index.html")).text();

// Extracts a top-level `const NAME = [ ... ];` block from app.js source.
function extractBlock(name: string): string {
  const start = appJs.indexOf(`const ${name} = [`);
  expect(start).toBeGreaterThan(-1);
  const end = appJs.indexOf("\n  ];", start);
  expect(end).toBeGreaterThan(start);
  return appJs.slice(start, end);
}

describe("a dumbbell workout never counts toward G1 (ISC-479)", () => {
  beforeEach(() => resetDb());

  test("a logged dumbbell workout does not increment the week's qualifying sessions", () => {
    insertActivity({ sport: "swimming", start_time: "2026-07-13T10:00:00Z", duration_s: 3600 });
    // The workout the card's Log button creates (strength, 35 min).
    insertActivity({
      sport: "strength",
      start_time: "2026-07-14T10:00:00Z",
      duration_s: 35 * 60,
      title: "Dumbbells: Full Body Strength A",
      notes: "Dumbbell workout: Full Body Strength A",
    });

    const summary = computeWeekSummary(new Date("2026-07-14T12:00:00Z"));
    expect(isG1Qualifying("strength")).toBe(false);
    expect(summary.sessions).toBe(1);
    expect(summary.hours_g1).toBe(1);
  });
});

describe("every STRETCH_PLAN slug has a served SVG (ISC-485)", () => {
  const block = extractBlock("STRETCH_PLAN");
  const slugs = [...block.matchAll(/slug: "([a-z0-9-]+)"/g)].map((m) => m[1]);

  test("the plan includes the original lower-body items plus the upper-body block", () => {
    expect(slugs.length).toBe(13);
    for (const upper of ["dead-hang", "doorway-pec", "t-spine-reach", "cross-body-shoulder", "wrist-stretch"]) {
      expect(slugs).toContain(upper);
    }
  });

  for (const slug of slugs.length > 0 ? slugs : ["parse-failed"]) {
    test(`serves /img/stretch/${slug}.svg with the svg mime type`, async () => {
      const res = await fetchHandler(
        new Request(`http://localhost/img/stretch/${slug}.svg`),
        stubServer,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    });
  }
});

describe("dumbbell content shape and copy rules (ISC-473, ISC-489)", () => {
  const block = extractBlock("DUMBBELL_WORKOUTS");

  test("three routines, each exercise carrying name, dose, and cue", () => {
    expect([...block.matchAll(/\n    \{\n      name: "/g)].length).toBe(3);
    const exercises = [...block.matchAll(/\{ name: "[^"]+", dose: "[^"]+", cue: "[^"]+" \}/g)];
    expect(exercises.length).toBe(15);
  });

  test("KOT signature movements are present", () => {
    for (const move of ["ATG Split Squat", "External Rotation", "Cross-Bench Pullover", "Trap 3 Raise", "Dumbbell RDL"]) {
      expect(block).toContain(move);
    }
  });

  test("no em or en dashes in the new content blocks or Train-tab copy", () => {
    const stretchBlock = extractBlock("STRETCH_PLAN");
    for (const content of [block, stretchBlock]) {
      expect(content.includes("—")).toBe(false);
      expect(content.includes("–")).toBe(false);
    }
    const trainSection = indexHtml.slice(
      indexHtml.indexOf('id="view-stretch"'),
      indexHtml.indexOf('id="view-sleep"'),
    );
    expect(trainSection.includes("—")).toBe(false);
    expect(trainSection.includes("–")).toBe(false);
  });
});
