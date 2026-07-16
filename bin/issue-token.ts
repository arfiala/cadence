#!/usr/bin/env bun
// bin/issue-token.ts — issues and revokes API bearer tokens for Cadence
// (ISC-20, ISC-21). A token grants the same single-user scope as the web
// login; it never carries a separate role because there is only one user.
//
// Usage:
//   bun bin/issue-token.ts [label]           Issue a new token, printed ONCE.
//   bun bin/issue-token.ts --list            List tokens (no secret material).
//   bun bin/issue-token.ts --revoke <id>     Revoke by numeric id.
//   bun bin/issue-token.ts --revoke <token>  Revoke by the raw token value.

import { randomBytes } from "node:crypto";
import "../src/db";
import { db } from "../src/db";
import { hashToken } from "../src/auth/session";
import type { ApiTokenRow } from "../src/db";

function issue(label: string | undefined) {
  const token = randomBytes(32).toString("hex"); // ISC-20: 32-byte random hex
  const tokenHash = hashToken(token);
  db.query("INSERT INTO api_tokens (token_hash, label) VALUES (?, ?)").run(
    tokenHash,
    label ?? null,
  );
  console.log("Token issued. This is shown ONCE — copy it now:\n");
  console.log(token);
  console.log(
    "\nSet this as CADENCE_TOKEN for the MCP server, or Authorization: Bearer <token> for API calls.",
  );
}

function list() {
  const rows = db
    .query("SELECT id, label, created_at, revoked_at FROM api_tokens ORDER BY id DESC")
    .all() as Omit<ApiTokenRow, "token_hash">[];
  if (rows.length === 0) {
    console.log("No tokens issued.");
    return;
  }
  for (const row of rows) {
    const status = row.revoked_at === null ? "active" : `revoked at ${row.revoked_at}`;
    console.log(`#${row.id}  ${row.label ?? "(no label)"}  ${status}  created ${row.created_at}`);
  }
}

function revoke(idOrToken: string) {
  const asId = Number(idOrToken);
  let changes = 0;
  if (Number.isInteger(asId) && String(asId) === idOrToken) {
    const result = db
      .query(
        "UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL",
      )
      .run(asId);
    changes = result.changes;
  } else {
    const hash = hashToken(idOrToken);
    const result = db
      .query(
        "UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(hash);
    changes = result.changes;
  }
  if (changes === 0) {
    console.error("No matching active token found.");
    process.exit(1);
  }
  console.log("Token revoked.");
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--revoke") {
    const target = args[1];
    if (target === undefined) {
      console.error("Usage: bun bin/issue-token.ts --revoke <id|token>");
      process.exit(1);
    }
    revoke(target);
    return;
  }

  if (args[0] === "--list") {
    list();
    return;
  }

  // Default action: issue a new token. An optional positional arg is used
  // as a human-readable label (e.g. "mcp-laptop").
  issue(args[0]);
}

main();
