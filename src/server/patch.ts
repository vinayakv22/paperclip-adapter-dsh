/**
 * Generates the per-agent dsh patch file (`$DSH_HOME/paperclip.patch.yml`).
 *
 * A dsh patch is a YAML list of rows. A row addressed by `id` replaces that plugin's
 * whole `config`; an `insert` row mounts new plugins. The adapter uses it to:
 *   - pin the provider route and model (`agent-default-model`),
 *   - declare an OpenAI-compatible route such as InferX (`llm-pi-ai` providers),
 *   - turn off DeepSeek session-log upload (`session-log-deepseek`),
 *   - reject approval requests (`approval` policy `never`): nobody is there to answer,
 *   - unmount the UI permission presets (`permission`), which refuse to activate when the
 *     approval default is `never` and only serve interactive mode switching,
 *   - mount MCP servers through `@deepseek-ai/dsh-mcp-client`.
 *
 * Secrets never land in the file: any `${NAME}` inside an MCP string becomes a
 * `!!js` template literal that dsh evaluates against its own environment at load time.
 */

import { DEEPSEEK_PROVIDER, MANAGED_MARKER } from "../constants.js";
import type { ProviderRoute } from "./provider.js";

export type McpTransport = "stdio" | "streamable-http";

export interface McpServerSpec {
  name: string;
  transport: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DshPatchOptions {
  model: string;
  /** Route for `agent-default-model`; defaults to deepseek-official. */
  provider?: string;
  /** Extra llm-pi-ai route to declare (null/absent for deepseek-official). */
  route?: ProviderRoute | null;
  disableTelemetry: boolean;
  mcpServers?: McpServerSpec[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function asRecordOfStrings(value: unknown, field: string, server: string, warnings: string[]): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    warnings.push(`MCP server "${server}": "${field}" must be an object of strings; ignored.`);
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
    else warnings.push(`MCP server "${server}": ${field}.${key} is not a string; ignored.`);
  }
  return out;
}

/**
 * Normalizes the `mcpServers` config value. Accepts a JSON string, an object map
 * `{ name: spec }`, or an array of specs carrying `name` / `serverName`.
 */
export function normalizeMcpServers(value: unknown): { servers: McpServerSpec[]; warnings: string[] } {
  const warnings: string[] = [];
  let raw: unknown = value;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return { servers: [], warnings };
    try {
      raw = JSON.parse(text);
    } catch (err) {
      warnings.push(`mcpServers is not valid JSON (${err instanceof Error ? err.message : String(err)}); no MCP servers mounted.`);
      return { servers: [], warnings };
    }
  }
  if (raw === undefined || raw === null) return { servers: [], warnings };

  let entries: Array<[string, unknown]> = [];
  if (Array.isArray(raw)) {
    entries = raw.map((item, index) => {
      const rec = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const name = typeof rec.name === "string" ? rec.name : typeof rec.serverName === "string" ? rec.serverName : `server-${index + 1}`;
      return [name, item];
    });
  } else if (typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    // Accept the common `{ "mcpServers": { ... } }` wrapper too.
    const inner = rec.mcpServers && typeof rec.mcpServers === "object" && !Array.isArray(rec.mcpServers) ? rec.mcpServers : rec;
    entries = Object.entries(inner as Record<string, unknown>);
  } else {
    warnings.push("mcpServers must be an object or array; no MCP servers mounted.");
    return { servers: [], warnings };
  }

  const servers: McpServerSpec[] = [];
  const seen = new Set<string>();
  for (const [name, item] of entries) {
    if (!NAME_RE.test(name)) {
      warnings.push(`MCP server name "${name}" must match ${NAME_RE}; skipped.`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`MCP server "${name}" is listed twice; the second entry is skipped.`);
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      warnings.push(`MCP server "${name}" must be an object; skipped.`);
      continue;
    }
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === "string" && rec.url.trim() ? rec.url.trim() : undefined;
    const command = typeof rec.command === "string" && rec.command.trim() ? rec.command.trim() : undefined;
    const declared = typeof rec.transport === "string" ? rec.transport.trim() : typeof rec.type === "string" ? rec.type.trim() : "";
    let transport: McpTransport;
    if (declared === "stdio") transport = "stdio";
    else if (declared === "streamable-http" || declared === "http" || declared === "streamableHttp") transport = "streamable-http";
    else if (!declared) transport = command ? "stdio" : "streamable-http";
    else {
      warnings.push(`MCP server "${name}": unsupported transport "${declared}" (use stdio or streamable-http); skipped.`);
      continue;
    }
    if (transport === "stdio" && !command) {
      warnings.push(`MCP server "${name}": stdio transport needs "command"; skipped.`);
      continue;
    }
    if (transport === "streamable-http" && !url) {
      warnings.push(`MCP server "${name}": streamable-http transport needs "url"; skipped.`);
      continue;
    }
    const spec: McpServerSpec = { name, transport };
    if (transport === "streamable-http") {
      spec.url = url;
      const headers = asRecordOfStrings(rec.headers, "headers", name, warnings);
      if (headers && Object.keys(headers).length > 0) spec.headers = headers;
    } else {
      spec.command = command;
      if (Array.isArray(rec.args)) spec.args = rec.args.map((a) => String(a));
      const env = asRecordOfStrings(rec.env, "env", name, warnings);
      if (env && Object.keys(env).length > 0) spec.env = env;
    }
    seen.add(name);
    servers.push(spec);
  }
  return { servers, warnings };
}

/** Escapes literal text for use inside a JS template literal. */
function escapeTemplateLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

/** Renders a YAML scalar. Strings with `${NAME}` become `!!js` template literals over process.env. */
export function yamlScalar(value: string): string {
  ENV_REF_RE.lastIndex = 0;
  if (!ENV_REF_RE.test(value)) return JSON.stringify(value);
  ENV_REF_RE.lastIndex = 0;
  let out = "";
  let last = 0;
  for (const match of value.matchAll(ENV_REF_RE)) {
    out += escapeTemplateLiteral(value.slice(last, match.index));
    out += `\${process.env.${match[1]} ?? ""}`;
    last = (match.index ?? 0) + match[0].length;
  }
  out += escapeTemplateLiteral(value.slice(last));
  return `!!js ${JSON.stringify("`" + out + "`")}`;
}

function yamlMap(map: Record<string, string>, indent: string): string[] {
  return Object.entries(map).map(([k, v]) => `${indent}${JSON.stringify(k)}: ${yamlScalar(v)}`);
}

/** Lists the `${NAME}` env references used by the MCP config (for diagnostics). */
export function collectEnvRefs(servers: McpServerSpec[]): string[] {
  const names = new Set<string>();
  const scan = (s: string | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(ENV_REF_RE)) names.add(m[1]!);
  };
  for (const s of servers) {
    scan(s.url);
    scan(s.command);
    s.args?.forEach(scan);
    Object.values(s.headers ?? {}).forEach(scan);
    Object.values(s.env ?? {}).forEach(scan);
  }
  return [...names].sort();
}

/** `llm-pi-ai` row declaring one route. The key is referenced by env var name only. */
export function buildProviderRows(route: ProviderRoute): string[] {
  const lines = [
    "",
    `# Provider route "${route.name}"; its key is read from $${route.apiKeyEnv} at request time.`,
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    `      ${JSON.stringify(route.name)}:`,
    `        displayName: ${JSON.stringify(route.displayName)}`,
    `        api: ${route.api}`,
    `        baseURL: ${JSON.stringify(route.baseURL)}`,
    `        apiKeyEnv: ${JSON.stringify(route.apiKeyEnv)}`,
  ];
  const compat = Object.entries(route.compat);
  if (compat.length > 0) {
    lines.push("        compat:", ...compat.map(([k, v]) => `          ${JSON.stringify(k)}: ${JSON.stringify(v)}`));
  }
  lines.push("        models:");
  for (const m of route.models) {
    lines.push(`          - id: ${JSON.stringify(m.id)}`);
    if (m.name) lines.push(`            name: ${JSON.stringify(m.name)}`);
    if (m.contextWindow) lines.push(`            contextWindow: ${m.contextWindow}`);
    if (m.maxTokens) lines.push(`            maxTokens: ${m.maxTokens}`);
  }
  return lines;
}

export function buildDshPatch(options: DshPatchOptions): string {
  const provider = options.route?.name ?? options.provider ?? DEEPSEEK_PROVIDER;
  const lines: string[] = [
    `# ${MANAGED_MARKER}: rewritten before every run; edits here are lost.`,
    "",
    "- id: agent-default-model",
    "  config:",
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(options.model)}`,
  ];
  if (options.route) lines.push(...buildProviderRows(options.route));
  lines.push(
    "",
    "# Unattended run: approval requests are rejected instead of waiting for a human.",
    "- id: approval",
    "  config:",
    "    policy: never",
    "",
    "# Interactive preset switcher; it fails to activate with policy never and is not needed headless.",
    "- id: permission",
    "  disabled: true",
  );
  if (options.disableTelemetry) {
    lines.push("", "# Keep session transcripts on this host: no upload to DeepSeek.", "- id: session-log-deepseek", "  disabled: true");
  }
  const servers = options.mcpServers ?? [];
  if (servers.length > 0) {
    lines.push("", "- insert:");
    for (const s of servers) {
      lines.push(
        `    - id: ${JSON.stringify(`mcp-${s.name}`)}`,
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        `        serverName: ${JSON.stringify(s.name)}`,
        `        transport: ${s.transport}`,
      );
      if (s.transport === "streamable-http") {
        lines.push(`        url: ${yamlScalar(s.url!)}`);
        if (s.headers) lines.push("        headers:", ...yamlMap(s.headers, "          "));
      } else {
        lines.push(`        command: ${yamlScalar(s.command!)}`);
        if (s.args && s.args.length > 0) lines.push("        args:", ...s.args.map((a) => `          - ${yamlScalar(a)}`));
        if (s.env) lines.push("        env:", ...yamlMap(s.env, "          "));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
