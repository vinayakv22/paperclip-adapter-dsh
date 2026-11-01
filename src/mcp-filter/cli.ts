#!/usr/bin/env node
/** `paperclip-dsh-mcp-filter`: filtering stdio relay in front of a Streamable HTTP MCP server. */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "./args.js";
import { createHttpUpstream, createRelay } from "./relay.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const relay = createRelay({ upstream: createHttpUpstream(args.url, args.headers), policy: args.policy });
  try {
    await relay.start(new StdioServerTransport());
  } catch (err) {
    // Lengths only, never values: tells an empty credential from a rejected one.
    const sizes = Object.entries(args.headers).map(([name, value]) => `${name} is ${value.length} chars long`);
    if (sizes.length > 0) process.stderr.write(`paperclip-dsh-mcp-filter: headers sent: ${sizes.join(", ")}\n`);
    throw err;
  }
  const stop = () => void relay.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.stdin.once("end", stop);
}

main().catch((err) => {
  // stdout is the MCP channel; diagnostics go to stderr (never print header values).
  const code = err && typeof err === "object" && "code" in err ? ` (code ${String((err as { code: unknown }).code)})` : "";
  process.stderr.write(`paperclip-dsh-mcp-filter: ${err instanceof Error ? err.message : String(err)}${code}\n`);
  process.exit(1);
});
