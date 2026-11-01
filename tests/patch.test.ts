import { describe, expect, it } from "vitest";
import { buildDshPatch, collectEnvRefs, normalizeMcpServers, yamlScalar } from "../src/server/patch.js";
import { resolveProvider } from "../src/server/provider.js";

describe("buildDshPatch", () => {
  it("pins the model and disables session-log upload", () => {
    const yaml = buildDshPatch({ model: "deepseek-v4-pro", disableTelemetry: true });
    expect(yaml).toContain("- id: agent-default-model\n  config:\n    provider: \"deepseek-official\"\n    model: \"deepseek-v4-pro\"");
    expect(yaml).not.toContain("llm-pi-ai");
    expect(yaml).toContain("- id: session-log-deepseek\n  disabled: true");
    expect(yaml).not.toContain("insert");
    expect(yaml.startsWith("# managed by paperclip-adapter-dsh")).toBe(true);
  });

  it("declares an InferX route on llm-pi-ai and points the agent at it", () => {
    const llm = resolveProvider({ provider: "inferx" }, () => false);
    const yaml = buildDshPatch({ model: llm.model, provider: llm.provider, route: llm.route, disableTelemetry: true });
    expect(yaml).toContain('- id: agent-default-model\n  config:\n    provider: "inferx"\n    model: "deepseek-v4.1-flash-1017-basic"');
    expect(yaml).toContain(
      [
        "- id: llm-pi-ai",
        "  config:",
        "    providers:",
        '      "inferx":',
        '        displayName: "InferX (DeepSeek)"',
        "        api: openai-completions",
        '        baseURL: "https://model.inferx.net/endpoints/v1"',
        '        apiKeyEnv: "DEEPSEEK_INFERX_API_KEY"',
        "        models:",
        '          - id: "deepseek-v4.1-flash-1017-basic"',
        '            name: "DeepSeek V4.1 Flash (InferX)"',
        "            contextWindow: 262144",
      ].join("\n"),
    );
    expect(yaml).not.toContain("maxTokens");
  });

  it("renders provider compat switches", () => {
    const llm = resolveProvider(
      { provider: "acme", baseUrl: "https://gw.example/v1", apiKeyEnv: "ACME_KEY", model: "acme-1", providerCompat: '{"thinkingFormat":"deepseek","supportsStore":false}' },
      () => false,
    );
    const yaml = buildDshPatch({ model: llm.model, provider: llm.provider, route: llm.route, disableTelemetry: true });
    expect(yaml).toContain('        compat:\n          "thinkingFormat": "deepseek"\n          "supportsStore": false\n        models:');
  });

  it("leaves session-log alone when telemetry is allowed", () => {
    expect(buildDshPatch({ model: "deepseek-flash", disableTelemetry: false })).not.toContain("session-log-deepseek");
  });

  it("mounts MCP servers with env references instead of secrets", () => {
    const { servers, warnings } = normalizeMcpServers(
      JSON.stringify({
        openseo: { url: "https://app.openseo.so/mcp", headers: { Authorization: "Bearer ${OPENSEO_API_KEY}" } },
        files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv"], env: { TOKEN: "${FS_TOKEN}" } },
      }),
    );
    expect(warnings).toEqual([]);
    const yaml = buildDshPatch({ model: "deepseek-flash", disableTelemetry: true, mcpServers: servers });
    expect(yaml).toContain(
      [
        "- insert:",
        '    - id: "mcp-openseo"',
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        '        serverName: "openseo"',
        "        transport: streamable-http",
        '        url: "https://app.openseo.so/mcp"',
        "        headers:",
        '          "Authorization": !!js "`Bearer ${process.env.OPENSEO_API_KEY ?? \\"\\"}`"',
      ].join("\n"),
    );
    expect(yaml).toContain('        transport: stdio\n        command: "npx"\n        args:\n          - "-y"');
    expect(yaml).toContain('"TOKEN": !!js "`${process.env.FS_TOKEN ?? \\"\\"}`"');
    expect(collectEnvRefs(servers)).toEqual(["FS_TOKEN", "OPENSEO_API_KEY"]);
  });
});

describe("yamlScalar", () => {
  it("quotes plain strings as JSON (valid YAML double-quoted scalars)", () => {
    expect(yamlScalar('a "quoted": value # not a comment')).toBe('"a \\"quoted\\": value # not a comment"');
  });
  it("escapes template-literal syntax around env refs", () => {
    expect(yamlScalar("`x` \\ ${A}")).toBe('!!js "`\\\\`x\\\\` \\\\\\\\ ${process.env.A ?? \\"\\"}`"');
  });
  it("leaves invalid env names (digit first) literal", () => {
    expect(yamlScalar("${1BAD}")).toBe('"${1BAD}"');
  });
});

describe("normalizeMcpServers", () => {
  it("accepts arrays, wrappers and objects", () => {
    expect(normalizeMcpServers([{ name: "a", url: "https://a" }]).servers).toHaveLength(1);
    expect(normalizeMcpServers({ mcpServers: { b: { url: "https://b" } } }).servers[0]!.name).toBe("b");
    expect(normalizeMcpServers(undefined).servers).toEqual([]);
    expect(normalizeMcpServers("   ").servers).toEqual([]);
  });
  it("reports bad entries instead of throwing", () => {
    const { servers, warnings } = normalizeMcpServers({
      "bad name": { url: "https://x" },
      nourl: { transport: "streamable-http" },
      nocmd: { transport: "stdio" },
      weird: { transport: "sse", url: "https://x" },
      ok: { type: "http", url: "https://ok" },
    });
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
    expect(warnings).toHaveLength(4);
    expect(normalizeMcpServers("{oops").warnings[0]).toMatch(/not valid JSON/);
  });
});
