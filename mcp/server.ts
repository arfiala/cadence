#!/usr/bin/env bun
// Cadence MCP server (ISC-60). Speaks MCP over stdio using
// @modelcontextprotocol/sdk's low-level Server, exposing the 8 Cadence
// tools. It is a thin stdio client of the HTTP API — it holds NO business
// logic and NO SQL (ISC-71); every tool delegates to CadenceClient, which
// only makes authenticated fetch calls.
//
// Config: CADENCE_URL + CADENCE_TOKEN from env (ISC-68). A missing value
// throws a clear error before the transport is ever connected, so the
// process exits with a readable message instead of crash-looping.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readConfig, CadenceClient } from "./client";
import { TOOLS, callTool } from "./tools";

export function buildServer(client: CadenceClient): Server {
  const server = new Server(
    { name: "cadence", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const { text, isError } = await callTool(client, request.params.name, args);
    return {
      content: [{ type: "text", text }],
      isError,
    };
  });

  return server;
}

async function main() {
  let config;
  try {
    config = readConfig(process.env);
  } catch (err) {
    // Clear startup error, no crash loop (ISC-68).
    console.error(`Cadence MCP server cannot start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const client = new CadenceClient(config);
  const server = buildServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Note: no console.log here — stdout is the MCP transport channel; any
  // stray write would corrupt the protocol stream. Operational messages go
  // to stderr only.
  console.error("Cadence MCP server connected over stdio.");
}

if (import.meta.main) {
  void main();
}
