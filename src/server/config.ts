/**
 * Normalizes an agent's adapterConfig and builds the dsh command line.
 */

import path from "node:path";
import {
  DEFAULT_DSH_COMMAND,
  DEFAULT_GRACE_SEC,
  DEFAULT_TIMEOUT_SEC,
  DSH_PROFILE,
  PERMISSION_MODES,
  isUnknownPermissionMode,
  looksLikeDshCommand,
  resolveDshModel,
  resolvePermissionMode,
  type PermissionMode,
} from "../constants.js";
import { normalizeMcpServers, type McpServerSpec } from "./patch.js";

export interface DshAdapterConfig {
  command: string;
  model: string;
  permissionMode: PermissionMode;
  addDirs: string[];
  mcpServers: McpServerSpec[];
  disableTelemetry: boolean;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
  warnings: string[];
}

/** Accepts an array, or a string with one entry per line (commas also split for addDirs). */
export function readList(value: unknown, { splitCommas = false } = {}): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  const pattern = splitCommas ? /[\n,]/ : /\n/;
  return value
    .split(pattern)
    .map((v) => v.trim())
    .filter(Boolean);
}

function readNumber(value: unknown, fallback: number): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function readDshConfig(config: Record<string, unknown>): DshAdapterConfig {
  const warnings: string[] = [];
  // Codex agents falling back to dsh keep their adapterConfig, so `command` may point at
  // codex / codex-lb. Only a dsh-looking command is used; anything else runs plain `dsh`.
  const configuredCommand = typeof config.command === "string" ? config.command.trim() : "";
  const command = configuredCommand && looksLikeDshCommand(configuredCommand) ? configuredCommand : DEFAULT_DSH_COMMAND;
  if (isUnknownPermissionMode(config.permissionMode)) {
    warnings.push(
      `permissionMode "${String(config.permissionMode)}" is not a dsh mode (${PERMISSION_MODES.join(", ")}); using ${resolvePermissionMode(config.permissionMode)}.`,
    );
  }
  const addDirs: string[] = [];
  for (const dir of readList(config.addDirs, { splitCommas: true })) {
    if (path.isAbsolute(dir)) addDirs.push(path.resolve(dir));
    else warnings.push(`addDirs entry "${dir}" is not an absolute path; ignored.`);
  }
  if (addDirs.length > 0) {
    // dsh 0.2.x sandbox-policy has one writable root per session (the session cwd) and the
    // headless profile has no --add-dir flag, so extra roots cannot be granted.
    warnings.push(
      `addDirs (${addDirs.join(", ")}) is not supported by dsh 0.2.x: only the workspace is writable under workspace-write. Use danger-full-access if the agent must write elsewhere.`,
    );
  }
  const mcp = normalizeMcpServers(config.mcpServers);
  warnings.push(...mcp.warnings);
  // `dshExtraArgs`, not `extraArgs`: Codex agents use `extraArgs` for Codex `-c` flags,
  // which dsh would reject after a fallback swap.
  const extra = Array.isArray(config.dshExtraArgs) ? config.dshExtraArgs.map(String) : readList(config.dshExtraArgs);
  return {
    command,
    model: resolveDshModel(config.model),
    permissionMode: resolvePermissionMode(config.permissionMode),
    addDirs: [...new Set(addDirs)],
    mcpServers: mcp.servers,
    disableTelemetry: readBoolean(config.disableTelemetry, true),
    timeoutSec: readNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC),
    graceSec: readNumber(config.graceSec, DEFAULT_GRACE_SEC),
    extraArgs: extra.filter((a) => a.length > 0),
    warnings,
  };
}

/**
 * `dsh --profile headless --patch <file> --json [--session-id <id>] [extra...] -`
 *
 * The headless app only takes `--json` and `--session-id`. The permission mode travels in
 * `DSH_PERMISSION_MODE` (see {@link buildDshEnv}) and the approval policy in the patch file.
 * Launcher flags (`--profile`, `--patch`) come before app flags; `-` reads the task from stdin.
 */
export function buildDshArgs(input: { patchFile: string; sessionId: string | null; extraArgs: string[] }): string[] {
  const args = ["--profile", DSH_PROFILE, "--patch", input.patchFile, "--json"];
  if (input.sessionId) args.push("--session-id", input.sessionId);
  args.push(...input.extraArgs, "-");
  return args;
}

/** Environment the headless profile reads: the sandbox mode for its sandbox-policy row. */
export function buildDshEnv(input: { permissionMode: PermissionMode }): Record<string, string> {
  return { DSH_PERMISSION_MODE: input.permissionMode };
}
