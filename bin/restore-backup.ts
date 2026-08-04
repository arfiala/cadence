#!/usr/bin/env bun
// bin/restore-backup.ts — decrypt a Cadence .db.enc backup and prove it is a
// usable database. This is the DR half of bin/backup.ts: same AES-256-GCM
// iv|tag|ciphertext envelope, same key env var. The S3 download itself
// happens outside this script (the backup identity is write-only by design;
// restores use an operator's own credentials).
//
// Usage: BACKUP_ENCRYPTION_KEY=<base64> bun bin/restore-backup.ts <in.db.enc> <out.db>
//
// Verifies after decrypt: PRAGMA integrity_check passes and the core tables
// answer counts, printed for eyeball comparison against production.

import { Database } from "bun:sqlite";
import { createDecipheriv } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

export function decryptBuffer(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < 29) throw new Error("Backup file too small to be a valid envelope");
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("Usage: BACKUP_ENCRYPTION_KEY=<base64> bun bin/restore-backup.ts <in.db.enc> <out.db>");
    process.exit(1);
  }
  const keyB64 = process.env.BACKUP_ENCRYPTION_KEY;
  if (!keyB64) {
    console.error("BACKUP_ENCRYPTION_KEY is required");
    process.exit(1);
  }
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) {
    console.error("BACKUP_ENCRYPTION_KEY must be 32 bytes (base64)");
    process.exit(1);
  }

  const plain = decryptBuffer(readFileSync(input), key);
  writeFileSync(output, plain);
  chmodSync(output, 0o600);

  const db = new Database(output, { readonly: true });
  const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
  const counts = {
    activities: (db.query("SELECT COUNT(*) n FROM activities").get() as { n: number }).n,
    planned_workouts: (db.query("SELECT COUNT(*) n FROM planned_workouts").get() as { n: number }).n,
    nutrition_entries: (db.query("SELECT COUNT(*) n FROM nutrition_entries").get() as { n: number }).n,
    golf_scorecards: (db.query("SELECT COUNT(*) n FROM golf_scorecards").get() as { n: number }).n,
  };
  db.close();

  if (integrity.integrity_check !== "ok") {
    console.error(`[cadence] restore FAILED integrity_check: ${integrity.integrity_check}`);
    process.exit(1);
  }
  console.log(`[cadence] restore OK -> ${output}`);
  console.log(`[cadence] integrity_check: ok, counts: ${JSON.stringify(counts)}`);
}
