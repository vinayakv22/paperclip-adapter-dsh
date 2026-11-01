/**
 * Session codec. A dsh session lives in one DSH_HOME and is bound to one cwd, so both
 * are stored next to the id and checked before `--session-id` is passed.
 */

import path from "node:path";
import type { AdapterSessionCodec } from "@paperclipai/adapter-utils";

export interface DshSessionParams {
  sessionId: string;
  cwd?: string;
  dshHome?: string;
  model?: string;
}

function read(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function parseSessionParams(record: Record<string, unknown>): DshSessionParams | null {
  const sessionId = read(record.sessionId) ?? read(record.session_id) ?? read(record.sessionID);
  if (!sessionId) return null;
  const cwd = read(record.cwd) ?? read(record.workdir);
  const dshHome = read(record.dshHome) ?? read(record.dsh_home);
  const model = read(record.model);
  return {
    sessionId,
    ...(cwd ? { cwd } : {}),
    ...(dshHome ? { dshHome } : {}),
    ...(model ? { model } : {}),
  };
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return parseSessionParams(raw as Record<string, unknown>) as Record<string, unknown> | null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    return parseSessionParams(params) as Record<string, unknown> | null;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return parseSessionParams(params)?.sessionId ?? null;
  },
};

/** Why a saved session cannot be resumed here, or null when it can. */
export function sessionResumeBlocker(
  saved: DshSessionParams | null,
  current: { cwd: string; dshHome: string },
): string | null {
  if (!saved) return "no saved session";
  // Sessions from another adapter (e.g. Codex before a fallback swap) carry no dshHome.
  if (!saved.dshHome) return "it was not created by dsh_local";
  if (saved.cwd && path.resolve(saved.cwd) !== path.resolve(current.cwd)) {
    return `it was saved for cwd "${saved.cwd}", not "${current.cwd}"`;
  }
  if (path.resolve(saved.dshHome) !== path.resolve(current.dshHome)) {
    return `it lives in DSH_HOME "${saved.dshHome}", not "${current.dshHome}"`;
  }
  return null;
}
