import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { parseArgs } from "../src/mcp-filter/args.js";
import { filterTools, isToolAllowed } from "../src/mcp-filter/policy.js";
import { createRelay } from "../src/mcp-filter/relay.js";

const TOOLS = ["whoami", "list_projects", "run_site_audit", "create_rank_tracker"];

/** Fake upstream: lists TOOLS, records every tools/call it receives. */
async function setup(policy: Parameters<typeof createRelay>[0]["policy"]) {
  const upstreamCalls: string[] = [];
  const upstream = new Server({ name: "fake-openseo", version: "1" }, { capabilities: { tools: {} }, instructions: "Use OpenSEO wisely." });
  upstream.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((name) => ({ name, description: name, inputSchema: { type: "object" as const } })),
  }));
  upstream.setRequestHandler(CallToolRequestSchema, async (req) => {
    upstreamCalls.push(req.params.name);
    return { content: [{ type: "text" as const, text: `ran ${req.params.name}` }] };
  });
  const [upstreamClientSide, upstreamServerSide] = InMemoryTransport.createLinkedPair();
  await upstream.connect(upstreamServerSide);

  const relay = createRelay({ upstream: upstreamClientSide, policy });
  const [downstreamServerSide, downstreamClientSide] = InMemoryTransport.createLinkedPair();
  await relay.start(downstreamServerSide);
  const client = new Client({ name: "dsh", version: "1" });
  await client.connect(downstreamClientSide);
  return { client, relay, upstreamCalls };
}

describe("policy", () => {
  it("allows everything without a policy", () => {
    expect(isToolAllowed({}, "anything")).toBe(true);
  });
  it("applies the allowlist, then the denylist", () => {
    const policy = { enabled: ["a", "b"], disabled: ["b"] };
    expect(filterTools(policy, [{ name: "a" }, { name: "b" }, { name: "c" }])).toEqual([{ name: "a" }]);
  });
  it("treats an empty allowlist as nothing allowed", () => {
    expect(isToolAllowed({ enabled: [] }, "a")).toBe(false);
  });
});

describe("relay", () => {
  it("lists exactly the allowlisted tools and passes instructions through", async () => {
    const { client } = await setup({ enabled: ["whoami", "list_projects"] });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami", "list_projects"]);
    expect(client.getInstructions()).toBe("Use OpenSEO wisely.");
  });

  it("forwards an allowed call to the upstream", async () => {
    const { client, upstreamCalls } = await setup({ enabled: ["whoami"] });
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "ran whoami" }]);
    expect(upstreamCalls).toEqual(["whoami"]);
  });

  it("refuses a hidden tool without contacting the upstream", async () => {
    const { client, upstreamCalls } = await setup({ enabled: ["whoami"] });
    const result = await client.callTool({ name: "run_site_audit", arguments: { url: "https://example.com" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not available");
    expect(upstreamCalls).toEqual([]);
  });

  it("refuses a tool the upstream does not even list", async () => {
    const { client, upstreamCalls } = await setup({ enabled: ["whoami"] });
    expect((await client.callTool({ name: "no_such_tool" })).isError).toBe(true);
    expect(upstreamCalls).toEqual([]);
  });

  it("hides and refuses disabledTools while exposing the rest", async () => {
    const { client, upstreamCalls } = await setup({ disabled: ["run_site_audit", "create_rank_tracker"] });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami", "list_projects"]);
    expect((await client.callTool({ name: "create_rank_tracker" })).isError).toBe(true);
    expect(upstreamCalls).toEqual([]);
  });

  it("exposes nothing for an empty allowlist", async () => {
    const { client } = await setup({ enabled: [] });
    expect((await client.listTools()).tools).toEqual([]);
  });

  it("closes both ends", async () => {
    const { relay } = await setup({});
    const spy = vi.spyOn(relay.client, "close");
    await relay.close();
    expect(spy).toHaveBeenCalled();
  });
});

describe("parseArgs", () => {
  it("builds headers from env var names, never from argv values", () => {
    const parsed = parseArgs(
      ["--url", "https://app.openseo.so/mcp", "--bearer-env", "OPENSEO_API_KEY", "--header-env", "X-Org=ORG", "--enable", "whoami,list_projects", "--disable", "x"],
      { OPENSEO_API_KEY: "sekret", ORG: "acme" },
    );
    expect(parsed.url).toBe("https://app.openseo.so/mcp");
    expect(parsed.headers).toEqual({ Authorization: "Bearer sekret", "X-Org": "acme" });
    expect(parsed.policy).toEqual({ enabled: ["whoami", "list_projects"], disabled: ["x"] });
  });

  it("errors when a referenced env var is unset, without echoing values", () => {
    expect(() => parseArgs(["--url", "https://x.test/mcp", "--bearer-env", "MISSING"], {})).toThrow("MISSING is not set");
  });

  it("supports --enable-none and rejects bad input", () => {
    expect(parseArgs(["--url", "https://x.test/mcp", "--enable-none"], {}).policy).toEqual({ enabled: [] });
    expect(() => parseArgs([], {})).toThrow("--url is required");
    expect(() => parseArgs(["--url", "nope"], {})).toThrow("not a valid URL");
    expect(() => parseArgs(["--url", "https://x.test/mcp", "--wat"], {})).toThrow("unknown argument");
    expect(() => parseArgs(["--url", "https://x.test/mcp", "--header-env", "bad"], {})).toThrow("<Header>=<ENV_NAME>");
  });
});
