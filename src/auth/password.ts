// Password hashing for Cadence's single-user email+password auth. Mirrors
// Suretas's src/auth/password.ts (read for reference, not modified): Bun's
// built-in Bun.password hash/verify (argon2id by default), no bcrypt/argon2
// npm package — Cadence's constraint is even stricter (zero extra runtime
// deps beyond the Garmin client + MCP SDK), so this is a hard requirement,
// not just a preference here.

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return Bun.password.verify(plain, hash);
}

// Precomputed once at module load so /auth/login can run a verify against a
// real argon2id hash when no user row / no password / a locked account is
// hit, keeping every failure path's timing indistinguishable from a genuine
// wrong-password check (ISC-14).
export const DUMMY_PASSWORD_HASH = await hashPassword(
  "dummy-password-for-timing-parity",
);
