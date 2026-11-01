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
        "        retryPolicy:",
        "          mode: normal",
        "          maxRetries: 12",
        "          backoff:",
        "            initialDelayMs: 2000",
        "            maxDelayMs: 30000",
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

describe("provider retry policy rows", () => {
  it("renders the InferX retry policy inside its route", () => {
    const llm = resolveProvider({ model: "deepseek-flash" }, () => true);
    const patch = buildDshPatch({ model: llm.model, provider: llm.provider, route: llm.route, disableTelemetry: true, mcpServers: [] });
    expect(patch).toContain(
      ["        retryPolicy:", "          mode: normal", "          maxRetries: 12", "          backoff:", "            initialDelayMs: 2000", "            maxDelayMs: 30000", "        models:"].join("\n"),
    );
  });
  it("renders retryable codes and omits the row for dsh's default", () => {
    const custom = resolveProvider({ providerRetry: { retryableCodes: ["RATE_LIMIT"] } }, () => true);
    expect(buildDshPatch({ model: custom.model, provider: custom.provider, route: custom.route, disableTelemetry: true, mcpServers: [] })).toContain(
      '          retryableCodes:\n            - "RATE_LIMIT"',
    );
    const dflt = resolveProvider({ providerRetry: "default" }, () => true);
    expect(buildDshPatch({ model: dflt.model, provider: dflt.provider, route: dflt.route, disableTelemetry: true, mcpServers: [] })).not.toContain("retryPolicy");
  });
});

describe("deepseek-official catalog row", () => {
  it("replaces dsh's catalog with explicit windows on DeepSeek's API, and only when asked", () => {
    const llm = resolveProvider({ model: "deepseek-flash" }, (n) => n === "DEEPSEEK_API_KEY");
    const yaml = buildDshPatch({ model: llm.model, provider: llm.provider, route: llm.route, officialModels: llm.officialModels, disableTelemetry: true });
    expect(yaml).toContain(
      [
        "- id: llm-deepseek",
        "  config:",
        "    models:",
        '      - id: "deepseek-flash"',
        '        name: "DeepSeek-V4.1-Flash"',
        "        contextWindow: 262144",
        '        inputModalities: ["text", "image"]',
        '        systemPromptUpdate: "in-history"',
        '        toolUpdate: "addition-only"',
        '      - id: "deepseek-v4-pro"',
        '        name: "DeepSeek-V4-Pro"',
        "        contextWindow: 1048576",
      ].join("\n"),
    );
    expect(buildDshPatch({ model: "deepseek-flash", disableTelemetry: true })).not.toContain("llm-deepseek");
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

describe("MCP tool filtering", () => {
  const relay = { command: "/usr/bin/node", script: "/opt/adapter/dist/mcp-filter/cli.js" };
  const openseo = {
    url: "https://app.openseo.so/mcp",
    headers: { Authorization: "Bearer ${OPENSEO_API_KEY}" },
    enabledTools: ["whoami", "list_projects"],
  };

  it("accepts enabledTools / enabled_tools and disabledTools, as arrays or strings", () => {
    const { servers, warnings } = normalizeMcpServers({
      a: { ...openseo, enabledTools: undefined, enabled_tools: "whoami\nlist_projects, whoami" },
      b: { url: "https://b.test/mcp", disabledTools: ["x"] },
      c: { url: "https://c.test/mcp" },
    });
    expect(warnings).toEqual([]);
    expect(servers.map((s) => [s.name, s.enabledTools, s.disabledTools])).toEqual([
      ["a", ["whoami", "list_projects"], undefined],
      ["b", undefined, ["x"]],
      ["c", undefined, undefined],
    ]);
  });

  it("mounts a filtered server through the relay, keeping the key in env only", () => {
    const { servers } = normalizeMcpServers({ openseo });
    const yaml = buildDshPatch({ model: "deepseek-flash", disableTelemetry: true, mcpServers: servers, relay });
    expect(yaml).toContain(
      [
        '        serverName: "openseo"',
        "        transport: stdio",
        '        command: "/usr/bin/node"',
        "        args:",
        '          - "/opt/adapter/dist/mcp-filter/cli.js"',
        '          - "--url"',
        '          - "https://app.openseo.so/mcp"',
        '          - "--header-env"',
        '          - "Authorization=PAPERCLIP_MCP_RELAY_0_H0"',
        '          - "--enable"',
        '          - "whoami,list_projects"',
        "        env:",
        '          "PAPERCLIP_MCP_RELAY_0_H0": !!js "`Bearer ${process.env.OPENSEO_API_KEY ?? \\"\\"}`"',
      ].join("\n"),
    );
    expect(yaml).not.toContain("streamable-http");
    expect(yaml).not.toContain("headers:");
    expect(collectEnvRefs(servers)).toEqual(["OPENSEO_API_KEY"]);
  });

  it("leaves unfiltered servers on the direct transport", () => {
    const { servers } = normalizeMcpServers({ plain: { url: "https://p.test/mcp" } });
    const yaml = buildDshPatch({ model: "deepseek-flash", disableTelemetry: true, mcpServers: servers, relay });
    expect(yaml).toContain("transport: streamable-http");
    expect(yaml).not.toContain("cli.js");
  });

  it("renders an empty allowlist as --enable-none and disabledTools as --disable", () => {
    const { servers } = normalizeMcpServers({ a: { url: "https://a.test/mcp", enabledTools: [], disabledTools: ["x", "y"] } });
    const yaml = buildDshPatch({ model: "deepseek-flash", disableTelemetry: true, mcpServers: servers, relay });
    expect(yaml).toContain('          - "--enable-none"\n          - "--disable"\n          - "x,y"');
  });

  it("refuses to mount a stdio server with a tool filter instead of failing open", () => {
    const { servers, warnings } = normalizeMcpServers({ fs: { command: "npx", enabledTools: ["read"] } });
    expect(servers).toEqual([]);
    expect(warnings[0]).toContain("only supported for streamable-http");
  });
});

describe("MCP bearerTokenEnv", () => {
  it("builds the Authorization header from an env var name, so no credential header is stored in the config", () => {
    const { servers, warnings } = normalizeMcpServers({ openseo: { url: "https://app.openseo.so/mcp", bearerTokenEnv: "OPENSEO_API_KEY", enabled_tools: ["whoami"] } });
    expect(warnings).toEqual([]);
    expect(servers[0]!.headers).toEqual({ Authorization: "Bearer ${OPENSEO_API_KEY}" });
    expect(collectEnvRefs(servers)).toEqual(["OPENSEO_API_KEY"]);
  });

  it("accepts the Codex spelling bearer_token_env_var and keeps an explicit Authorization header", () => {
    const a = normalizeMcpServers({ a: { url: "https://a.test/mcp", bearer_token_env_var: "A_KEY" } });
    expect(a.servers[0]!.headers).toEqual({ Authorization: "Bearer ${A_KEY}" });
    const b = normalizeMcpServers({ b: { url: "https://b.test/mcp", bearerTokenEnv: "B_KEY", headers: { authorization: "Bearer ${OTHER}" } } });
    expect(b.servers[0]!.headers).toEqual({ authorization: "Bearer ${OTHER}" });
  });

  it("rejects a bad env var name", () => {
    const { servers, warnings } = normalizeMcpServers({ a: { url: "https://a.test/mcp", bearerTokenEnv: "not a name" } });
    expect(servers).toEqual([]);
    expect(warnings[0]).toContain("not an environment variable name");
  });

  it("skips a server whose header is Paperclip's redaction placeholder instead of sending it", () => {
    const { servers, warnings } = normalizeMcpServers({ openseo: { url: "https://app.openseo.so/mcp", headers: { Authorization: "***REDACTED***" } } });
    expect(servers).toEqual([]);
    expect(warnings[0]).toContain("redaction placeholder");
    expect(warnings[0]).toContain("bearerTokenEnv");
  });
});

