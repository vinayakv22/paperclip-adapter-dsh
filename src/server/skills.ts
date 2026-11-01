/**
 * Paperclip skills → `$DSH_HOME/skills/<name>` symlinks, scanned by dsh-skill-filesystem.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  removeMaintainerOnlySkillSymlinks,
  resolveLegacyPaperclipDesiredSkillNames,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE } from "../constants.js";
import { dshPaths, resolveDshHome } from "./home.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function linkSkill(source: string, target: string): Promise<void> {
  try {
    await fs.symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch {
    await fs.symlink(source, target);
  }
}

export function resolveDshSkillsHome(config: Record<string, unknown>, agentId: string): string {
  return dshPaths(resolveDshHome(config, agentId)).skills;
}

async function snapshot(config: Record<string, unknown>, agentId: string): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolveDshSkillsHome(config, agentId);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: ADAPTER_TYPE,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "$DSH_HOME/skills",
    missingDetail: "Configured but not yet linked into this agent's DSH_HOME/skills.",
    externalConflictDetail: "Skill name is taken by a skill installed outside Paperclip.",
    externalDetail: "Installed in DSH_HOME/skills outside Paperclip management.",
  });
}

export async function listDshSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return snapshot(ctx.config, ctx.agentId);
}

export async function syncDshSkills(ctx: AdapterSkillContext, desiredSkills: string[]): Promise<AdapterSkillSnapshot> {
  const available = await readPaperclipRuntimeSkillEntries(ctx.config, moduleDir);
  const desired = new Set([
    ...desiredSkills,
    ...available.filter((e) => (e as { required?: boolean }).required).map((e) => e.key),
  ]);
  const skillsHome = resolveDshSkillsHome(ctx.config, ctx.agentId);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const byRuntimeName = new Map(available.map((e) => [e.runtimeName, e]));

  for (const entry of available) {
    if (!desired.has(entry.key) || isPaperclipSkillSourceMissing(entry)) continue;
    await ensurePaperclipSkillSymlink(entry.source, path.join(skillsHome, entry.runtimeName), linkSkill);
  }
  // Unlink only skills Paperclip owns (link target == its source) that are no longer wanted.
  for (const [name, item] of installed.entries()) {
    const entry = byRuntimeName.get(name);
    if (!entry || desired.has(entry.key) || item.targetPath !== entry.source) continue;
    await fs.unlink(path.join(skillsHome, name)).catch(() => {});
  }
  return snapshot(ctx.config, ctx.agentId);
}

/** Run-time variant used by execute(): link the desired skills, report what changed. */
export async function linkRuntimeSkills(
  config: Record<string, unknown>,
  skillsHome: string,
  log: (line: string) => Promise<void>,
): Promise<PaperclipSkillEntry[]> {
  const entries = await readPaperclipRuntimeSkillEntries(config, moduleDir);
  const desired = new Set(resolveLegacyPaperclipDesiredSkillNames(config, entries));
  const selected = entries.filter((e) => desired.has(e.key) && !isPaperclipSkillSourceMissing(e));
  await fs.mkdir(skillsHome, { recursive: true });
  for (const removed of await removeMaintainerOnlySkillSymlinks(skillsHome, selected.map((e) => e.runtimeName))) {
    await log(`Removed maintainer-only skill "${removed}" from ${skillsHome}`);
  }
  for (const entry of selected) {
    try {
      const result = await ensurePaperclipSkillSymlink(entry.source, path.join(skillsHome, entry.runtimeName), linkSkill);
      if (result !== "skipped") await log(`${result === "repaired" ? "Repaired" : "Linked"} skill ${entry.key}`);
    } catch (err) {
      await log(`Failed to link skill "${entry.key}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return selected;
}
