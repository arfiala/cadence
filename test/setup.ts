// Test preload (see bunfig.toml). Runs before any test file and before any
// src/ module binds the db singleton. Points DB_PATH at a throwaway temp
// file unique to this test process and disables the 6h Garmin scheduler so
// tests never open a network connection or write the real cadence.db.

import { tmpdir } from "node:os";
import { join } from "node:path";

const dbFile = join(tmpdir(), `cadence-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;
process.env.CADENCE_DISABLE_SCHEDULER = "1";
// A deterministic session secret is irrelevant here (Cadence doesn't sign
// cookies — sessions are random UUID rows), but set PORT to something the
// tests can override per-server.
process.env.PORT = process.env.PORT ?? "4199";
