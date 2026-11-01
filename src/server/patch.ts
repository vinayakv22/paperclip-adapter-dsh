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

import { fileURLToPath } from "node:url";
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
  /** Tool allowlist (streamable-http only): the server is mounted through the filter relay. */
  enabledTools?: string[];
  /** Tools hidden after the allowlist is applied (streamable-http only). */
  disabledTools?: string[];
}

/** How a filtered server is launched: `<command> <script> --url ...`. */
export interface RelayLaunch {
  command: string;
  script: string;
}

export function defaultRelayLaunch(): RelayLaunch {
  return { command: process.execPath, script: fileURLToPath(new URL("../mcp-filter/cli.js", import.meta.url)) };
}

export interface DshPatchOptions {
  model: string;
  /** Route for `agent-default-model`; defaults to deepseek-official. */
  provider?: string;
  /** Extra llm-pi-ai route to declare (null/absent for deepseek-official). */
  route?: ProviderRoute | null;
  disableTelemetry: boolean;
  mcpServers?: McpServerSpec[];
  /** Override the relay launch command (tests). */
  relay?: RelayLaunch;
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

/** A tool list given as an array, or a string with one name per line / comma. Undefined when absent. */
function readToolList(rec: Record<string, unknown>, keys: string[], server: string, warnings: string[]): string[] | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (value === undefined || value === null) continue;
    const parts = Array.isArray(value) ? value.map((v) => String(v)) : typeof value === "string" ? value.split(/[\n,]/) : null;
    if (!parts) {
      warnings.push(`MCP server "${server}": ${key} must be a list of tool names; ignored.`);
      return undefined;
    }
    return [...new Set(parts.map((v) => v.trim()).filter(Boolean))];
  }
  return undefined;
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
    const enabledTools = readToolList(rec, ["enabledTools", "enabled_tools"], name, warnings);
    const disabledTools = readToolList(rec, ["disabledTools", "disabled_tools"], name, warnings);
    if (transport === "stdio" && (enabledTools || (disabledTools && disabledTools.length > 0))) {
      // Failing open would silently expose tools the operator meant to hide.
      warnings.push(`MCP server "${name}": enabledTools/disabledTools are only supported for streamable-http servers; skipped.`);
      continue;
    }
    const spec: McpServerSpec = { name, transport };
    if (enabledTools) spec.enabledTools = enabledTools;
    if (disabledTools && disabledTools.length > 0) spec.disabledTools = disabledTools;
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
  const retry = route.retryPolicy;
  if (retry) {
    lines.push("        retryPolicy:", `          mode: ${retry.mode}`);
    if (retry.maxRetries !== undefined) lines.push(`          maxRetries: ${retry.maxRetries}`);
    if (retry.retryableCodes?.length) {
      lines.push("          retryableCodes:", ...retry.retryableCodes.map((c) => `            - ${JSON.stringify(c)}`));
    }
    const backoff = Object.entries(retry.backoff ?? {});
    if (backoff.length > 0) lines.push("          backoff:", ...backoff.map(([k, v]) => `            ${k}: ${v}`));
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

/**
 * A tool-filtered HTTP server is mounted as a stdio server running the relay. Header values
 * (which may hold `${SECRET}` references) travel as the relay's env, not argv: dsh scrubs
 * credential-shaped names from the ambient env it hands a stdio child but not from the
 * server's own `env`, so the key reaches the relay while staying out of the patch file and `ps`.
 */
function relayConfigLines(s: McpServerSpec, index: number, launch: RelayLaunch): string[] {
  const args = [launch.script, "--url", s.url!];
  const env: Record<string, string> = {};
  Object.entries(s.headers ?? {}).forEach(([header, value], i) => {
    const envName = `PAPERCLIP_MCP_RELAY_${index}_H${i}`;
    env[envName] = value;
    args.push("--header-env", `${header}=${envName}`);
  });
  if (s.enabledTools) args.push(...(s.enabledTools.length > 0 ? ["--enable", s.enabledTools.join(",")] : ["--enable-none"]));
  if (s.disabledTools) args.push("--disable", s.disabledTools.join(","));
  const lines = ["        transport: stdio", `        command: ${yamlScalar(launch.command)}`, "        args:", ...args.map((a) => `          - ${yamlScalar(a)}`)];
  if (Object.keys(env).length > 0) lines.push("        env:", ...yamlMap(env, "          "));
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
    servers.forEach((s, index) => {
      lines.push(
        `    - id: ${JSON.stringify(`mcp-${s.name}`)}`,
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        `        serverName: ${JSON.stringify(s.name)}`,
      );
      if (s.transport === "streamable-http" && (s.enabledTools || s.disabledTools)) {
        lines.push(...relayConfigLines(s, index, options.relay ?? defaultRelayLaunch()));
      } else if (s.transport === "streamable-http") {
        lines.push(`        transport: ${s.transport}`, `        url: ${yamlScalar(s.url!)}`);
        if (s.headers) lines.push("        headers:", ...yamlMap(s.headers, "          "));
      } else {
        lines.push(`        transport: ${s.transport}`, `        command: ${yamlScalar(s.command!)}`);
        if (s.args && s.args.length > 0) lines.push("        args:", ...s.args.map((a) => `          - ${yamlScalar(a)}`));
        if (s.env) lines.push("        env:", ...yamlMap(s.env, "          "));
      }
    });
  }
  return `${lines.join("\n")}\n`;
}
