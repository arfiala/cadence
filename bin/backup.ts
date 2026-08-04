#!/usr/bin/env bun
// bin/backup.ts — nightly off-site encrypted backup of the Cadence DB.
//
// Mirrors the proven Suretas pipeline: WAL-safe VACUUM INTO a temp snapshot,
// AES-256-GCM file encryption (iv|tag|ciphertext) under a dedicated
// BACKUP_ENCRYPTION_KEY, then an S3 PUT with SSE to a second-region bucket
// using a PutObject-only identity. Retention is an S3 lifecycle rule on the
// bucket, never this script: an identity that can delete backups can destroy
// the thing backups exist to protect.
//
// One deliberate difference from the Suretas script: the upload is a minimal
// AWS SigV4 signer over node:crypto instead of @aws-sdk/client-s3, because
// this repo keeps a no-new-dependencies discipline. SigV4 is standard HMAC
// plumbing, not novel cryptography, and a bad signature fails loudly as an
// S3 403 rather than a silent corruption.
//
// Env: DB_PATH (source, default ./cadence.db), BACKUP_S3_BUCKET,
// BACKUP_S3_REGION, BACKUP_ENCRYPTION_KEY (base64, 32B),
// BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY. --dry-run resolves
// all config and does everything except the upload.

import { Database } from "bun:sqlite";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S3_PREFIX = "cadence-db";

const dryRun = process.argv.includes("--dry-run");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) throw new Error(`${name} is required`);
  return v;
}

export function backupKey(): Buffer {
  const key = Buffer.from(requireEnv("BACKUP_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) throw new Error("BACKUP_ENCRYPTION_KEY must be 32 bytes (base64)");
  return key;
}

// Encrypts a buffer to iv|tag|ciphertext with AES-256-GCM (the same envelope
// the Suretas backups and restore scripts use).
export function encryptBuffer(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

// Minimal AWS Signature Version 4 for a virtual-hosted S3 request with no
// query string. Object keys here contain only unreserved characters and
// slashes (ISO stamps with : and . replaced by -), so the canonical URI is
// the path as-is; anything fancier must be percent-encoded first.
export function signV4(opts: {
  method: string;
  host: string;
  path: string;
  payloadSha256: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
}): Record<string, string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host: opts.host,
    "x-amz-content-sha256": opts.payloadSha256,
    "x-amz-date": amzDate,
  };
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) {
    headers[k.toLowerCase()] = v;
  }

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]?.trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    opts.method,
    opts.path,
    "", // no query string
    canonicalHeaders,
    signedHeaders,
    opts.payloadSha256,
  ].join("\n");

  const scope = `${dateStamp}/${opts.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${opts.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, opts.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export async function runBackup(): Promise<{ key: string; bytes: number }> {
  const dbPath = process.env.DB_PATH ?? "./cadence.db";

  // Resolve ALL config up front, dry-run included, so a dry run rehearses the
  // configuration and not just the crypto.
  const region = requireEnv("BACKUP_S3_REGION");
  const bucket = requireEnv("BACKUP_S3_BUCKET");
  const accessKeyId = requireEnv("BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("BACKUP_S3_SECRET_ACCESS_KEY");
  const key = backupKey();

  const tmp = mkdtempSync(join(tmpdir(), "cadence-backup-"));
  const snapshot = join(tmp, "snapshot.db");
  try {
    const src = new Database(dbPath, { readonly: true });
    src.exec(`VACUUM INTO '${snapshot}'`);
    src.close();
    chmodSync(snapshot, 0o600);

    const plain = readFileSync(snapshot);
    const encrypted = encryptBuffer(plain, key);

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const objectKey = `${S3_PREFIX}/${stamp}.db.enc`;

    if (dryRun) {
      console.log(
        `[dry-run] config OK (bucket ${bucket}, region ${region}); would upload ${encrypted.length} bytes to ${objectKey}`,
      );
      return { key: objectKey, bytes: encrypted.length };
    }

    const host = `${bucket}.s3.${region}.amazonaws.com`;
    const path = `/${objectKey}`;
    const headers = signV4({
      method: "PUT",
      host,
      path,
      payloadSha256: sha256Hex(encrypted),
      region,
      accessKeyId,
      secretAccessKey,
      extraHeaders: {
        "content-type": "application/octet-stream",
        "x-amz-server-side-encryption": "AES256",
      },
    });

    const res = await fetch(`https://${host}${path}`, {
      method: "PUT",
      headers,
      body: encrypted,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 500);
      throw new Error(`S3 PUT failed: ${res.status} ${detail}`);
    }
    console.log(`[cadence] backup uploaded: s3://${bucket}/${objectKey} (${encrypted.length} bytes)`);
    return { key: objectKey, bytes: encrypted.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runBackup().catch((err) => {
    console.error("[cadence] backup FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
