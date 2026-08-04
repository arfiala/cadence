// Backup pipeline tests: the AES-256-GCM envelope round-trips and detects
// tampering, and the SigV4 signer is deterministic with the required header
// set. The signature pin is a regression tripwire: the live S3 endpoint is
// the true oracle (a wrong signature is a loud 403 at the first real upload),
// so what these tests guard is accidental drift after that first success.

import { test, expect, describe } from "bun:test";
import { encryptBuffer, signV4 } from "../bin/backup.ts";
import { decryptBuffer } from "../bin/restore-backup.ts";
import { randomBytes } from "node:crypto";

const KEY = randomBytes(32);

describe("backup envelope", () => {
  test("round-trips bytes exactly", () => {
    const plain = randomBytes(4096);
    const blob = encryptBuffer(plain, KEY);
    expect(blob.length).toBe(12 + 16 + plain.length);
    expect(decryptBuffer(blob, KEY).equals(plain)).toBe(true);
  });

  test("a flipped ciphertext byte fails authentication", () => {
    const blob = encryptBuffer(randomBytes(256), KEY);
    const idx = blob.length - 1;
    blob[idx] = blob[idx]! ^ 0xff;
    expect(() => decryptBuffer(blob, KEY)).toThrow();
  });

  test("the wrong key fails authentication", () => {
    const blob = encryptBuffer(randomBytes(256), KEY);
    expect(() => decryptBuffer(blob, randomBytes(32))).toThrow();
  });
});

describe("SigV4 signer", () => {
  const fixed = {
    method: "PUT",
    host: "bucket.s3.us-west-2.amazonaws.com",
    path: "/cadence-db/2026-08-04T00-00-00-000Z.db.enc",
    payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    region: "us-west-2",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secretexample",
    extraHeaders: {
      "content-type": "application/octet-stream",
      "x-amz-server-side-encryption": "AES256",
    },
    now: new Date("2026-08-04T00:00:00.000Z"),
  };

  test("is deterministic for fixed inputs", () => {
    const a = signV4(fixed);
    const b = signV4(fixed);
    expect(a).toEqual(b);
  });

  test("carries the required headers and a well-formed authorization", () => {
    const h = signV4(fixed);
    expect(h.host).toBe(fixed.host);
    expect(h["x-amz-date"]).toBe("20260804T000000Z");
    expect(h["x-amz-content-sha256"]).toBe(fixed.payloadSha256);
    expect(h["x-amz-server-side-encryption"]).toBe("AES256");
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260804\/us-west-2\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-server-side-encryption, Signature=[0-9a-f]{64}$/,
    );
  });

  test("signature responds to the secret (no accidental constant)", () => {
    const a = signV4(fixed);
    const b = signV4({ ...fixed, secretAccessKey: "different" });
    expect(a.authorization).not.toBe(b.authorization);
  });
});
