/**
 * Paperclip UI transcript parser for `dsh --json` output.
 *
 * Served to the browser by Paperclip (GET /api/dsh_local/ui-parser.js) and eval'd, so this
 * file must stay self-contained: no imports, no Node APIs.
 */

type TranscriptEntry =
  | { kind: "init"; ts: string; model: string; sessionId: string }
  | { kind: "assistant"; ts: string; text: string; channel?: "progress" | "final" | "unknown" }
  | { kind: "thinking"; ts: string; text: string }
  | { kind: "tool_call"; ts: string; name: string; input: unknown; toolUseId?: string }
  | { kind: "tool_result"; ts: string; toolUseId: string; toolName?: string; content: string; isError: boolean }
  | {
      kind: "result";
      ts: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      costUsd: number;
      subtype: string;
      isError: boolean;
      errors: string[];
    }
  | { kind: "system"; ts: string; text: string }
  | { kind: "stderr"; ts: string; text: string }
  | { kind: "stdout"; ts: string; text: string };

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function createStdoutParser() {
  let toolNames: Record<string, string> = {};
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let model = "";

  function parseLine(line: string, ts: string): TranscriptEntry[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    if (!trimmed.startsWith("{")) {
      if (trimmed.startsWith("[paperclip")) return [{ kind: "system", ts, text: trimmed }];
      return [{ kind: "stdout", ts, text: trimmed }];
    }
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [{ kind: "stdout", ts, text: trimmed }];
      event = parsed as Record<string, unknown>;
    } catch {
      return [{ kind: "stdout", ts, text: trimmed }];
    }

    switch (event.type) {
      case "session": {
        if (typeof event.model === "string") model = event.model;
        return [{ kind: "init", ts, model: model || "dsh", sessionId: asText(event.sessionId) }];
      }
      case "status": {
        if (event.phase === "step_end" && event.usage && typeof event.usage === "object") {
          const u = event.usage as Record<string, unknown>;
          input += n(u.inputTokens) + n(u.cacheReadTokens) + n(u.cacheWriteTokens);
          output += n(u.outputTokens);
          cacheRead += n(u.cacheReadTokens);
        }
        return [];
      }
      case "thinking": {
        const text = asText(event.text);
        return text.trim() ? [{ kind: "thinking", ts, text }] : [];
      }
      case "text": {
        const text = asText(event.text);
        return text.trim() ? [{ kind: "assistant", ts, text }] : [];
      }
      case "tool_call": {
        const id = asText(event.callId);
        const name = asText(event.tool) || "tool";
        if (id) toolNames[id] = name;
        return [{ kind: "tool_call", ts, name, input: event.input ?? {}, ...(id ? { toolUseId: id } : {}) }];
      }
      case "tool_result": {
        const id = asText(event.callId);
        const isError = event.status === "error";
        const content = isError ? asText(event.error) || asText(event.result) : asText(event.result);
        return [{ kind: "tool_result", ts, toolUseId: id, toolName: toolNames[id], content, isError }];
      }
      case "final": {
        const reason = event.reason && typeof event.reason === "object" ? (event.reason as Record<string, unknown>) : null;
        const kind = reason && typeof reason.kind === "string" ? reason.kind : "unknown";
        return [
          {
            kind: "result",
            ts,
            text: asText(event.text),
            inputTokens: input,
            outputTokens: output,
            cachedTokens: cacheRead,
            costUsd: 0,
            subtype: kind,
            isError: kind !== "completed",
            errors: kind === "completed" ? [] : [`dsh stopped: ${kind}`],
          },
        ];
      }
      case "error": {
        const message = asText(event.message) || trimmed;
        return [
          {
            kind: "result",
            ts,
            text: "",
            inputTokens: input,
            outputTokens: output,
            cachedTokens: cacheRead,
            costUsd: 0,
            subtype: "error",
            isError: true,
            errors: [message],
          },
        ];
      }
      default:
        return [{ kind: "system", ts, text: trimmed }];
    }
  }

  function reset() {
    toolNames = {};
    input = 0;
    output = 0;
    cacheRead = 0;
    model = "";
  }

  return { parseLine, reset };
}

/** Stateless variant: per-line parse without usage totals or tool-name lookup. */
export function parseStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return createStdoutParser().parseLine(line, ts);
}
