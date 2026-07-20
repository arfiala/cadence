// PWA install surface (ISC-153, ISC-155, ISC-161, ISC-162). The manifest,
// service worker, and icon PNGs must all serve 200 through the real router,
// the manifest must carry the required install fields, the service worker must
// be a tiny no-op with no Cache API usage, and an unauthenticated load of "/"
// (an installed standalone app with an expired session) must serve the app
// shell cleanly rather than crash or blank out.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiRequest } from "./helpers";

describe("web manifest (ISC-153)", () => {
  test("serves 200 with the required install fields", async () => {
    const res = await apiRequest("GET", "/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("manifest");
    const m = (await res.json()) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      theme_color: string;
      background_color: string;
      icons: { purpose: string }[];
    };
    expect(m.name).toBe("Cadence");
    expect(m.short_name).toBe("Cadence");
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.theme_color).toBe("#F6EEDC");
    expect(m.background_color).toBe("#F6EEDC");
    expect(Array.isArray(m.icons)).toBe(true);
    expect(m.icons.length).toBe(3);
    expect(m.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
  });
});

describe("service worker (ISC-162)", () => {
  test("serves 200 and is a sub-15-line no-op with no Cache API", async () => {
    const res = await apiRequest("GET", "/sw.js");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("caches");
    expect(body).not.toContain("respondWith");
    // Whole file (comments included) stays tight.
    const src = readFileSync(join(import.meta.dir, "..", "public", "sw.js"), "utf8");
    expect(src.trimEnd().split("\n").length).toBeLessThan(15);
  });
});

describe("icons served (ISC-155)", () => {
  for (const file of ["icon-192.png", "icon-512.png", "icon-512-maskable.png", "apple-touch-icon.png"]) {
    test(`${file} serves 200 image/png`, async () => {
      const res = await apiRequest("GET", `/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/png");
    });
  }
});

describe("standalone expired-session load (ISC-161)", () => {
  test("GET / while unauthenticated serves the app shell, not an error", async () => {
    const res = await apiRequest("GET", "/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="login-view"');
    expect(body).toContain('href="/manifest.webmanifest"');
  });
});
