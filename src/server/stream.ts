/**
 * Parser for `dsh --json` output: newline-delimited JSON events.
 *
 *   {type:"session", sessionId, cwd}                       first event
 *   {type:"status", phase, usage?, reason?}                turn/step boundaries; usage on step_end,
 *                                                          reason:{kind} on turn_end
 *   {type:"thinking"|"text", text}
 *   {type:"tool_call", callId, tool, input}
 *   {type:"tool_result", callId, status, result, error?}
 *   {type:"final", text, sessionId?, reason?}              last event on a normal end (dsh 0.2.x
 *                                                          puts the reason on turn_end, not here)
 *   {type:"error", message}                                fatal error, no final event
 */

import type { UsageSummary } from "@paperclipai/adapter-utils";

export interface DshUsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface DshStreamSummary {
  sessionId: string | null;
  cwd: string | null;
  /** True once a `{type:"final"}` event was seen. */
  hasFinal: boolean;
  /** `final.reason.kind`, else the last `turn_end` reason kind ("completed" on success), or null. */
  finalReason: string | null;
  /** Final answer text: `final.text`, else the last `text` event. */
  text: string;
  errors: string[];
  usage: DshUsageCounters;
  toolCalls: number;
  toolErrors: number;
  steps: number;
  finalEvent: Record<string, unknown> | null;
}

export function emptyUsage(): DshUsageCounters {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Adds one dsh usage object (Anthropic-style counters) onto a running total. */
export function addUsage(total: DshUsageCounters, usage: unknown): DshUsageCounters {
  if (!usage || typeof usage !== "object") return total;
  const u = usage as Record<string, unknown>;
  total.inputTokens += num(u.inputTokens);
  total.outputTokens += num(u.outputTokens);
  total.cacheReadTokens += num(u.cacheReadTokens);
  total.cacheWriteTokens += num(u.cacheWriteTokens);
  total.reasoningTokens += num(u.reasoningTokens);
  return total;
}

/**
 * Converts dsh counters to Paperclip's usage shape.
 *
 * dsh reports `inputTokens` without cache reads/writes (Anthropic style); Paperclip
 * expects `inputTokens` to be the full prompt size with `cachedInputTokens` as the
 * cached subset.
 */
export function toPaperclipUsage(c: DshUsageCounters): UsageSummary {
  return {
    inputTokens: c.inputTokens + c.cacheReadTokens + c.cacheWriteTokens,
    outputTokens: c.outputTokens,
    cachedInputTokens: c.cacheReadTokens,
  };
}

/** Parses one stdout line into a dsh event object, or null for non-JSON / non-event lines. */
export function parseDshLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { type?: unknown }).type === "string") {
      return value as Record<string, unknown>;
    }
  } catch {
    // not an event line
  }
  return null;
}

/** Incremental accumulator; feed raw stdout chunks (lines may be split across chunks). */
export function createDshStreamAccumulator() {
  let buffer = "";
  const stepUsage = emptyUsage();
  const turnUsage = emptyUsage();
  let sawStepUsage = false;
  const summary: DshStreamSummary = {
    sessionId: null,
    cwd: null,
    hasFinal: false,
    finalReason: null,
    text: "",
    errors: [],
    usage: stepUsage,
    toolCalls: 0,
    toolErrors: 0,
    steps: 0,
    finalEvent: null,
  };
  let lastText = "";
  let turnEndReason: string | null = null;
  const reasonKind = (reason: unknown): string | null =>
    reason && typeof reason === "object" && typeof (reason as { kind?: unknown }).kind === "string"
      ? (reason as { kind: string }).kind
      : null;

  const handle = (event: Record<string, unknown>) => {
    switch (event.type) {
      case "session": {
        summary.sessionId = str(event.sessionId) ?? summary.sessionId;
        summary.cwd = str(event.cwd) ?? summary.cwd;
        break;
      }
      case "status": {
        if (event.phase === "step_end") {
          summary.steps += 1;
          if (event.usage && typeof event.usage === "object") {
            sawStepUsage = true;
            addUsage(stepUsage, event.usage);
          }
        } else if (event.phase === "turn_end") {
          if (event.usage && typeof event.usage === "object") addUsage(turnUsage, event.usage);
          turnEndReason = reasonKind(event.reason) ?? turnEndReason;
        }
        break;
      }
      case "text": {
        const text = typeof event.text === "string" ? event.text : "";
        if (text.trim()) lastText = text;
        break;
      }
      case "tool_call":
        summary.toolCalls += 1;
        break;
      case "tool_result":
        if (event.status === "error") summary.toolErrors += 1;
        break;
      case "final": {
        summary.hasFinal = true;
        summary.finalEvent = event;
        summary.sessionId = str(event.sessionId) ?? summary.sessionId;
        summary.finalReason = reasonKind(event.reason);
        if (typeof event.text === "string" && event.text.trim()) lastText = event.text;
        break;
      }
      case "error": {
        const message = str(event.message) ?? JSON.stringify(event);
        summary.errors.push(message);
        break;
      }
      default:
        break;
    }
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const event = parseDshLine(line);
        if (event) handle(event);
        newline = buffer.indexOf("\n");
      }
    },
    summary(): DshStreamSummary {
      if (buffer.trim()) {
        const event = parseDshLine(buffer);
        buffer = "";
        if (event) handle(event);
      }
      summary.text = lastText;
      if (summary.hasFinal && summary.finalReason === null) summary.finalReason = turnEndReason;
      // Prefer per-step usage; fall back to turn totals for dsh builds that only report those.
      summary.usage = sawStepUsage ? stepUsage : turnUsage;
      return summary;
    },
  };
}

export function parseDshStream(stdout: string): DshStreamSummary {
  const acc = createDshStreamAccumulator();
  acc.push(stdout);
  return acc.summary();
}

/** A dsh run succeeded only when it exited 0 and its final event says "completed". */
export function isDshSuccess(exitCode: number | null, summary: DshStreamSummary): boolean {
  return exitCode === 0 && summary.hasFinal && summary.finalReason === "completed";
}

/** True when stdout already contains the terminal event (used to reap a lingering process). */
export function hasDshTerminalEvent(stdout: string): boolean {
  if (!/"type"\s*:\s*"(final|error)"/.test(stdout)) return false;
  const summary = parseDshStream(stdout);
  return summary.hasFinal || summary.errors.length > 0;
}

const UNKNOWN_SESSION_PATTERNS = [
  /\b(unknown|missing|invalid|no such|nonexistent|non-existent)\s+session\b/i,
  /\bsession\b[^\n]{0,80}\b(not found|does not exist|doesn't exist|was not found|unknown|belongs to (a )?different|mismatch)/i,
  /\b(can ?not|cannot|could not|failed to)\s+(resume|load|open)\b[^\n]{0,40}\bsession\b/i,
];

/** Detects dsh refusing `--session-id` (session gone, other DSH_HOME, or other cwd). */
export function isUnknownSessionError(stdout: string, stderr: string, summary?: DshStreamSummary): boolean {
  const parsed = summary ?? parseDshStream(stdout);
  if (parsed.hasFinal) return false;
  const haystack = [...parsed.errors, stderr].join("\n");
  return UNKNOWN_SESSION_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function isAuthError(text: string): boolean {
  return /DEEPSEEK_API_KEY|api[ _-]?key|\b401\b|unauthori[sz]ed|authentication (failed|required)|invalid[_ ]api[_ ]key/i.test(text);
}

export function isRateLimitError(text: string): boolean {
  return /\b429\b|rate[ _-]?limit|too many requests/i.test(text);
}

export function isBalanceError(text: string): boolean {
  return /\b402\b|insufficient[_ ]balance|payment required/i.test(text);
}
