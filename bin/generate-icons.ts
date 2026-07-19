#!/usr/bin/env bun
// Deterministic icon generator (ISC-155). Draws Cadence's app icon entirely in
// code (no image-gen, no binary assets checked in that we cannot reproduce): a
// solid evergreen rounded square with an emerald "C" glyph, encoded to PNG via
// src/lib/png.ts (node:zlib deflate, hand-rolled CRC). Re-run with:
//   bun bin/generate-icons.ts
// then commit the generated public/*.png. Output is byte-deterministic.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "../src/lib/png";

const EVERGREEN: [number, number, number] = [11, 61, 46]; // #0B3D2E
const EMERALD: [number, number, number] = [43, 182, 115]; // #2BB673

type IconSpec = {
  file: string;
  size: number;
  cornerRadius: number; // fraction of size; 0 = square
  glyphRadius: number; // fraction of size (outer radius of the C)
  opaqueBg: boolean; // full-bleed opaque square (maskable / apple)
};

const ICONS: IconSpec[] = [
  { file: "icon-192.png", size: 192, cornerRadius: 0.2, glyphRadius: 0.34, opaqueBg: false },
  { file: "icon-512.png", size: 512, cornerRadius: 0.2, glyphRadius: 0.34, opaqueBg: false },
  // Maskable: full-bleed opaque background, glyph pulled into the ~80% safe
  // zone so a platform mask never clips it.
  { file: "icon-512-maskable.png", size: 512, cornerRadius: 0, glyphRadius: 0.26, opaqueBg: true },
  // Apple applies its own squircle mask, so keep it opaque and square.
  { file: "apple-touch-icon.png", size: 180, cornerRadius: 0, glyphRadius: 0.34, opaqueBg: true },
];

function insideRoundedSquare(x: number, y: number, size: number, r: number): boolean {
  if (r <= 0) return true;
  const minX = r;
  const maxX = size - r;
  const minY = r;
  const maxY = size - r;
  if (x >= minX && x <= maxX) return true;
  if (y >= minY && y <= maxY) return true;
  const cx = x < minX ? minX : maxX;
  const cy = y < minY ? minY : maxY;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// A thick ring with an opening to the right = a "C".
function onGlyph(x: number, y: number, size: number, glyphRadiusFrac: number): boolean {
  const cx = size / 2;
  const cy = size / 2;
  const outer = glyphRadiusFrac * size;
  const inner = outer * 0.6;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > outer || dist < inner) return false;
  const angle = Math.atan2(dy, dx); // 0 points right (+x)
  const gapHalf = 0.62; // ~35 degrees each side -> the mouth of the C
  return Math.abs(angle) > gapHalf;
}

function renderIcon(spec: IconSpec): Uint8Array {
  const { size } = spec;
  const rgba = new Uint8Array(size * size * 4);
  const cornerR = spec.cornerRadius * size;
  const SS = 3; // 3x3 supersampling per pixel for smooth, deterministic edges

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          const inBg = spec.opaqueBg ? true : insideRoundedSquare(x, y, size, cornerR);
          if (!inBg) continue; // transparent subsample contributes no color
          const color = onGlyph(x, y, size, spec.glyphRadius) ? EMERALD : EVERGREEN;
          rSum += color[0];
          gSum += color[1];
          bSum += color[2];
          covered += 1;
        }
      }
      const idx = (py * size + px) * 4;
      const total = SS * SS;
      if (covered === 0) {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 0;
      } else {
        rgba[idx] = Math.round(rSum / covered);
        rgba[idx + 1] = Math.round(gSum / covered);
        rgba[idx + 2] = Math.round(bSum / covered);
        rgba[idx + 3] = Math.round((255 * covered) / total);
      }
    }
  }
  return rgba;
}

const publicDir = join(import.meta.dir, "..", "public");
for (const spec of ICONS) {
  const png = encodePng(spec.size, spec.size, renderIcon(spec));
  writeFileSync(join(publicDir, spec.file), png);
  console.log(`wrote ${spec.file} (${spec.size}x${spec.size}, ${png.length} bytes)`);
}
