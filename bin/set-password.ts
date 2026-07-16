#!/usr/bin/env bun
// bin/set-password.ts — creates or resets THE single Cadence user (ISC-17).
// There is no /auth/register endpoint (ISC-18); this on-box CLI is the only
// way an account is ever provisioned or a password ever changed. SSH access
// to the box IS reset ability, by design (ISA constraint).
//
// Usage:
//   bun bin/set-password.ts <email> <password>
//
// Behavior:
//   - No user row exists yet: creates the one and only user.
//   - A user row already exists: updates that SAME row's email and password
//     (never inserts a second row — "single user" is a hard invariant, not
//     just a UI convention). failed_login_attempts and locked_until are
//     cleared, and every existing session is deleted, so a locked-out or
//     mid-session Austin gets a completely clean slate (ISC-102's
//     self-DoS escape hatch).

import "../src/db";
import { db } from "../src/db";
import { hashPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from "../src/auth/password";

async function main() {
  const [email, password] = process.argv.slice(2);

  if (email === undefined || password === undefined) {
    console.error("Usage: bun bin/set-password.ts <email> <password>");
    process.exit(1);
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Error: not a valid email address.");
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    console.error(
      `Error: password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters.`,
    );
    process.exit(1);
  }

  const normalizedEmail = email.toLowerCase();
  const passwordHash = await hashPassword(password);

  const existing = db.query("SELECT id FROM users LIMIT 1").get() as { id: number } | null;

  if (existing === null) {
    db.query(
      "INSERT INTO users (email, password_hash, failed_login_attempts, locked_until) VALUES (?, ?, 0, NULL)",
    ).run(normalizedEmail, passwordHash);
    console.log(`Created the single Cadence user: ${normalizedEmail}`);
  } else {
    db.query(
      "UPDATE users SET email = ?, password_hash = ?, failed_login_attempts = 0, locked_until = NULL WHERE id = ?",
    ).run(normalizedEmail, passwordHash, existing.id);
    const deleted = db.query("DELETE FROM sessions WHERE user_id = ?").run(existing.id);
    console.log(
      `Reset the single Cadence user's password (email set to ${normalizedEmail}); cleared lockout and revoked ${deleted.changes} active session(s).`,
    );
  }

  // Verify: exactly one row, always.
  const count = db.query("SELECT COUNT(*) as n FROM users").get() as { n: number };
  if (count.n !== 1) {
    console.error(`Warning: users table has ${count.n} rows, expected exactly 1.`);
    process.exit(1);
  }
}

main();
