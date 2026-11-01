/**
 * Provider fallback: when an InferX run fails for provider reasons (capacity 429s that outlast
 * the retry policy, 5xx, auth, connection), execute() re-runs the heartbeat once on
 * deepseek-official and records a short cool-down so later runs skip InferX for a while.
 *
 * State lives in ~/.paperclip-dsh/provider-cooldown.json, shared by every dsh_local agent on
 * the host: { "<route>": { "until": ISO, "reason": "…", "at": ISO } }.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DSH_HOMES_DIRNAME } from "../constants.js";
import type { DshStreamSummary } from "./stream.js";

export const DEFAULT_FALLBACK_COOLDOWN_SEC = 15 * 60;
const MAX_COOLDOWN_SEC = 24 * 60 * 60;

/** dsh-llm error codes that mean "the provider failed", not "the task failed". */
const PROVIDER_FAILURE_CODES = new Set([
  "RATE_LIMIT",
  "SERVER",
  "TRANSPORT",
  "TIMEOUT",
  "INVALID_CREDENTIAL",
  "MISSING_CREDENTIAL",
  "QUOTA_EXCEEDED",
]);
const PROVIDER_FAILURE_TEXT =
  /\b(429|5\d\d|401|403)\b|at capacity|rate.?limit|connection (error|refused|reset)|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|unauthori[sz]ed|forbidden/i;

export interface ProviderFailureInput {
  success: boolean;
  /** Paperclip's own run timeout: the task ran long, not a provider fault. */
  timedOut: boolean;
  summary: DshStreamSummary;
  stderr: string;
}

/**
 * Returns a one-line reason when a failed run failed because of the model provider, else null.
 * Task-level stops (max_steps, a cancelled turn, Paperclip's timeout) never count.
 */
export function classifyProviderFailure(input: ProviderFailureInput): string | null {
  if (input.success || input.timedOut) return null;
  const { summary } = input;
  if (summary.hasFinal && summary.finalReason && summary.finalReason !== "error") return null;
  const stderrHit = /^dsh: ([A-Z_]+): (.+)$/m.exec(input.stderr);
  const code = summary.providerError?.code ?? stderrHit?.[1] ?? null;
  const message = (summary.providerError?.message ?? stderrHit?.[2] ?? summary.errors.at(-1) ?? "").trim();
  const short = (text: string) => (text.length > 160 ? `${text.slice(0, 157)}...` : text);
  if (code && PROVIDER_FAILURE_CODES.has(code)) return short(message ? `${code}: ${message}` : code);
  const haystack = [summary.providerError?.message ?? "", ...summary.errors, input.stderr].join("\n");
  const hit = PROVIDER_FAILURE_TEXT.exec(haystack);
  if (!hit) return null;
  const line = haystack.split("\n").find((l) => PROVIDER_FAILURE_TEXT.test(l))?.trim() ?? hit[0];
  return short(line.replace(/^dsh:\s*/, ""));
}

export function cooldownFile(): string {
  return path.join(os.homedir(), DEFAULT_DSH_HOMES_DIRNAME, "provider-cooldown.json");
}

export interface Cooldown {
  until: string;
  reason: string;
  at: string;
}

async function readAll(file: string): Promise<Record<string, Cooldown>> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, Cooldown>) : {};
  } catch {
    return {};
  }
}

/** The active cool-down for `route`, or null when none or expired. */
export async function readCooldown(route: string, now = new Date(), file = cooldownFile()): Promise<Cooldown | null> {
  const entry = (await readAll(file))[route];
  if (!entry || typeof entry.until !== "string") return null;
  const until = Date.parse(entry.until);
  return Number.isFinite(until) && until > now.getTime()
    ? { until: entry.until, reason: String(entry.reason ?? ""), at: String(entry.at ?? "") }
    : null;
}

/** Starts (or extends) a cool-down for `route`. Best effort: a write failure only skips it. */
export async function writeCooldown(
  route: string,
  reason: string,
  seconds: number,
  now = new Date(),
  file = cooldownFile(),
): Promise<Cooldown | null> {
  if (seconds <= 0) return null;
  const entry: Cooldown = {
    until: new Date(now.getTime() + seconds * 1000).toISOString(),
    reason: reason.slice(0, 200),
    at: now.toISOString(),
  };
  const all = await readAll(file);
  all[route] = entry;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
  return entry;
}

/** `fallbackCooldownSec`: seconds, default 900; 0 turns the cool-down off. */
export function readCooldownSec(value: unknown, warnings: string[] = []): number {
  if (value === undefined || value === null || value === "") return DEFAULT_FALLBACK_COOLDOWN_SEC;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    warnings.push(`fallbackCooldownSec must be a number of seconds >= 0; using ${DEFAULT_FALLBACK_COOLDOWN_SEC}.`);
    return DEFAULT_FALLBACK_COOLDOWN_SEC;
  }
  return Math.min(Math.floor(n), MAX_COOLDOWN_SEC);
}
