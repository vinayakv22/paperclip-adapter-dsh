/**
 * Codex -> DeepSeek handoff files. When the host's fallback governor swaps an agent from Codex to
 * dsh_local, it writes a condensed transcript of the work in progress to
 * ~/.paperclip-dsh/handoff/<issueIdentifier>.md (and a copy under <issueId>.md). A fresh dsh session
 * for that issue starts with the file's content at the top of its first prompt, so the agent knows
 * where to resume. Resumed sessions already hold the context and never get it again.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DSH_HOMES_DIRNAME } from "../constants.js";

const MAX_HANDOFF_CHARS = 24_000;

export function handoffDir(home = os.homedir()): string {
  return path.join(home, DEFAULT_DSH_HOMES_DIRNAME, "handoff");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** File-name-safe issue keys found in a run context: identifier first, then the issue id. */
export function handoffKeys(context: Record<string, unknown>): string[] {
  const wake = (context.paperclipWake ?? {}) as Record<string, unknown>;
  const wakeIssue = (wake.issue ?? {}) as Record<string, unknown>;
  const raw = [
    str(context.issueIdentifier),
    str(wakeIssue.identifier),
    str(context.taskKey),
    str(context.issueId),
    str(context.taskId),
    str(wakeIssue.id),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    if (k && /^[A-Za-z0-9._-]{1,80}$/.test(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/** The handoff text for this run's issue, or "" when there is none. Never throws. */
export async function readIssueHandoff(context: Record<string, unknown>, dir = handoffDir()): Promise<string> {
  for (const key of handoffKeys(context)) {
    try {
      const text = (await fs.readFile(path.join(dir, `${key}.md`), "utf8")).trim();
      if (!text) continue;
      const body = text.length > MAX_HANDOFF_CHARS ? `${text.slice(0, MAX_HANDOFF_CHARS)}\n[handoff truncated]` : text;
      return body;
    } catch {
      /* no file for this key */
    }
  }
  return "";
}
