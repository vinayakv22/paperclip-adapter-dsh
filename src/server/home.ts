/**
 * Per-agent DSH_HOME layout.
 *
 *   $DSH_HOME/
 *     AGENTS.md              agent instructions (dsh loads it as user-global instructions)
 *     skills/<name>/         Paperclip skills, symlinked (dsh-skill-filesystem scans this)
 *     paperclip.patch.yml    model / telemetry / MCP overlay passed with --patch
 *     sessions …             dsh's own session store, so --session-id resumes work
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AGENTS_MD_FILENAME,
  DEFAULT_DSH_HOMES_DIRNAME,
  MANAGED_MARKER,
  PATCH_FILENAME,
  SKILLS_DIRNAME,
} from "../constants.js";

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Agent ids are UUIDs, but keep path segments safe whatever arrives. */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned || "unknown-agent";
}

/** Shared env file for keys every dsh_local agent may use: `~/.paperclip-dsh/.env`. */
export function sharedEnvFile(): string {
  return path.join(os.homedir(), DEFAULT_DSH_HOMES_DIRNAME, ".env");
}

/**
 * Reads DEEPSEEK_* keys from the shared env file, so a Codex agent swapped to dsh_local
 * needs no new secret binding. The file must be owner-only (mode 600); values are never logged.
 */
export async function readSharedDeepseekEnv(file = sharedEnvFile()): Promise<{ env: Record<string, string>; warning?: string }> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch {
    return { env: {} };
  }
  if (!stat.isFile()) return { env: {}, warning: `${file} is not a regular file; ignored.` };
  if ((stat.mode & 0o077) !== 0) return { env: {}, warning: `${file} is readable by other users; chmod 600 it. Ignored.` };
  const env: Record<string, string> = {};
  for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
    const m = /^\s*(?:export\s+)?(DEEPSEEK_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value) env[m[1]!] = value;
  }
  return { env };
}

/** Root that holds every agent's home when `dshHome` is not configured. */
export function defaultDshHomesRoot(): string {
  return path.join(os.homedir(), DEFAULT_DSH_HOMES_DIRNAME, "agents");
}

/**
 * Resolves the DSH_HOME for an agent:
 *   1. `config.dshHome` (supports `~` and an `{agentId}` placeholder)
 *   2. `config.env.DSH_HOME` (plain string only)
 *   3. `~/.paperclip-dsh/agents/<agentId>`
 */
export function resolveDshHome(config: Record<string, unknown>, agentId: string): string {
  const segment = safeSegment(agentId);
  const configured = typeof config.dshHome === "string" ? config.dshHome.trim() : "";
  if (configured) return path.resolve(expandHome(configured.replaceAll("{agentId}", segment)));
  const env = config.env && typeof config.env === "object" && !Array.isArray(config.env) ? (config.env as Record<string, unknown>) : {};
  const envHome = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  if (envHome) return path.resolve(expandHome(envHome));
  return path.join(defaultDshHomesRoot(), segment);
}

export function dshPaths(home: string) {
  return {
    home,
    agentsMd: path.join(home, AGENTS_MD_FILENAME),
    skills: path.join(home, SKILLS_DIRNAME),
    patch: path.join(home, PATCH_FILENAME),
  };
}

export async function ensureDshHome(home: string): Promise<void> {
  await fs.mkdir(home, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(home, SKILLS_DIRNAME), { recursive: true });
}

/** Writes a file only when its content changed (keeps mtimes stable for dsh's reloader). */
export async function writeIfChanged(file: string, content: string, mode = 0o600): Promise<boolean> {
  try {
    if ((await fs.readFile(file, "utf8")) === content) return false;
  } catch {
    // missing: write below
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, { mode });
  await fs.rename(tmp, file);
  return true;
}

export function renderAgentsMd(instructions: string, instructionsFilePath: string): string {
  const dir = path.dirname(instructionsFilePath);
  return [
    `<!-- ${MANAGED_MARKER}: copied from ${instructionsFilePath} before every run; edit the source instead. -->`,
    "",
    instructions.trim(),
    "",
    "---",
    `These instructions were loaded from ${instructionsFilePath}. Resolve relative file references from ${dir}/.`,
    "",
  ].join("\n");
}

/**
 * Syncs `$DSH_HOME/AGENTS.md` with the agent's instructions file.
 * Without instructions, removes a previously managed copy but never a user-authored file.
 */
export async function syncAgentsMd(
  home: string,
  instructionsFilePath: string,
): Promise<{ status: "written" | "unchanged" | "removed" | "none"; chars: number; warning?: string }> {
  const target = dshPaths(home).agentsMd;
  if (instructionsFilePath) {
    let content: string;
    try {
      content = await fs.readFile(instructionsFilePath, "utf8");
    } catch (err) {
      return {
        status: "none",
        chars: 0,
        warning: `could not read instructions file "${instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (content.trim()) {
      const rendered = renderAgentsMd(content, instructionsFilePath);
      const changed = await writeIfChanged(target, rendered, 0o644);
      return { status: changed ? "written" : "unchanged", chars: rendered.length };
    }
  }
  try {
    const existing = await fs.readFile(target, "utf8");
    if (existing.includes(MANAGED_MARKER)) {
      await fs.unlink(target);
      return { status: "removed", chars: 0 };
    }
  } catch {
    // nothing to remove
  }
  return { status: "none", chars: 0 };
}
