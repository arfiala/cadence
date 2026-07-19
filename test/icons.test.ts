// Generated-icon validation (ISC-155). The committed PNGs must be real,
// decodable PNGs: correct magic bytes, an IHDR whose dimensions match, and an
// IDAT that inflates to exactly the byte count an 8-bit RGBA image of those
// dimensions requires. Also round-trips the encoder on a tiny image so a
// regression in the encoder itself is caught without touching disk.

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng, decodePngMeta } from "../src/lib/png";

const publicDir = join(import.meta.dir, "..", "public");

const ICONS = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "icon-512-maskable.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
];

describe("generated PNG icons (ISC-155)", () => {
  for (const { file, size } of ICONS) {
    test(`${file} decodes as a valid ${size}x${size} RGBA PNG`, () => {
      const bytes = new Uint8Array(readFileSync(join(publicDir, file)));
      expect(Array.from(bytes.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      const meta = decodePngMeta(bytes);
      expect(meta.width).toBe(size);
      expect(meta.height).toBe(size);
      expect(meta.inflatedLength).toBe(meta.expectedLength);
    });
  }

  test("encodePng round-trips a 2x2 image through decode validation", () => {
    const px = new Uint8Array([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);
    const png = encodePng(2, 2, px);
    const meta = decodePngMeta(png);
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);
    expect(meta.inflatedLength).toBe(meta.expectedLength);
  });

  test("encodePng rejects a mismatched buffer length", () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });
});
