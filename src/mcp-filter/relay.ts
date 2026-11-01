/**
 * Stdio MCP server that fronts one upstream Streamable HTTP MCP server and re-exposes only
 * the tools a {@link ToolPolicy} allows. dsh's MCP client has no tool allowlist of its own,
 * so the adapter points it at this relay instead of the upstream.
 *
 *   tools/list  -> upstream list, filtered (fetched live on every request)
 *   tools/call  -> refused locally for a hidden tool; the upstream is never contacted
 *   instructions -> passed through from the upstream
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { filterTools, isToolAllowed, type ToolPolicy } from "./policy.js";

export interface RelayOptions {
  /** Connected-ready transport to the upstream server. */
  upstream: Transport;
  policy: ToolPolicy;
  name?: string;
  version?: string;
}

export interface Relay {
  server: Server;
  client: Client;
  /** Connects upstream, then serves the downstream transport. */
  start(downstream: Transport): Promise<void>;
  close(): Promise<void>;
}

export function refusalMessage(tool: string): string {
  return `Tool "${tool}" is not available: it is not on this agent's allowed tool list.`;
}

export function createRelay(options: RelayOptions): Relay {
  const client = new Client({ name: options.name ?? "paperclip-dsh-mcp-filter", version: options.version ?? "0.0.0" });
  let server!: Server;

  async function listUpstreamTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  return {
    get server() {
      return server;
    },
    client,
    async start(downstream) {
      await client.connect(options.upstream);
      const instructions = client.getInstructions();
      server = new Server(
        { name: options.name ?? "paperclip-dsh-mcp-filter", version: options.version ?? "0.0.0" },
        { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: filterTools(options.policy, await listUpstreamTools()),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        if (!isToolAllowed(options.policy, name)) {
          return { isError: true, content: [{ type: "text" as const, text: refusalMessage(name) }] };
        }
        return client.callTool({ name, arguments: request.params.arguments ?? {} });
      });
      await server.connect(downstream);
    },
    async close() {
      await Promise.allSettled([server?.close(), client.close()]);
    },
  };
}

export function createHttpUpstream(url: string, headers: Record<string, string>): Transport {
  return new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
}
