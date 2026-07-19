// Minimal, dependency-free PNG encoder (8-bit RGBA, single IDAT, no interlace)
// plus a structural decoder used to validate what we produce (ISC-155).
// Compression is node:zlib's deflateSync, which emits exactly the zlib-wrapped
// stream a PNG IDAT chunk expects, so there is zero runtime dependency of any
// kind (ISC-187). The CRC32 lookup table is hand-rolled per the brief.

import { deflateSync, inflateSync } from "node:zlib";

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
  ]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// Encode an 8-bit RGBA image (rgba length must be width*height*4) as a PNG.
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  if (rgba.length !== stride * height) {
    throw new Error(`rgba length ${rgba.length} does not match ${width}x${height}x4`);
  }
  // Each scanline is prefixed with a filter-type byte of 0 (no filtering).
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const compressed = new Uint8Array(deflateSync(raw));

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor with alpha (RGBA)
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  return concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export type PngMeta = {
  width: number;
  height: number;
  inflatedLength: number;
  expectedLength: number;
};

// Structural decode used by the icon test (ISC-155): verify the signature,
// read IHDR dimensions, concatenate IDAT payloads, inflate them, and report
// the inflated byte count against the (stride+1)*height a valid 8-bit RGBA
// image must contain.
export function decodePngMeta(bytes: Uint8Array): PngMeta {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("bad PNG signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const len = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + len));
    }
    offset = dataStart + len + 4; // skip data + 4-byte CRC
    if (type === "IEND") break;
  }
  const inflated = new Uint8Array(inflateSync(concat(idat)));
  return {
    width,
    height,
    inflatedLength: inflated.length,
    expectedLength: (width * 4 + 1) * height,
  };
}
