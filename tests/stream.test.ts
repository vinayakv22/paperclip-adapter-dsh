import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createDshStreamAccumulator,
  hasDshTerminalEvent,
  isDshSuccess,
  isUnknownSessionError,
  parseDshLine,
  parseDshStream,
} from "../src/server/stream.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseDshLine", () => {
  it("parses event objects and ignores everything else", () => {
    expect(parseDshLine('{"type":"text","text":"hi"}')).toEqual({ type: "text", text: "hi" });
    expect(parseDshLine("plain log line")).toBeNull();
    expect(parseDshLine("{not json")).toBeNull();
    expect(parseDshLine('{"no":"type"}')).toBeNull();
    expect(parseDshLine("[1,2]")).toBeNull();
  });
});

describe("parseDshStream", () => {
  it("summarises a completed run", () => {
    const s = parseDshStream(fixture("success.ndjson"));
    expect(s.sessionId).toBe("ses_01");
    expect(s.cwd).toBe("/work/repo");
    expect(s.hasFinal).toBe(true);
    expect(s.finalReason).toBe("completed");
    expect(s.text).toBe("Posted the status comment on SEO-12.");
    expect(s.steps).toBe(2);
    expect(s.toolCalls).toBe(2);
    expect(s.toolErrors).toBe(1);
    expect(s.errors).toEqual([]);
    expect(isDshSuccess(0, s)).toBe(true);
    expect(isDshSuccess(1, s)).toBe(false);
  });

  it("captures error events without a final event", () => {
    const s = parseDshStream(fixture("error.ndjson"));
    expect(s.hasFinal).toBe(false);
    expect(s.errors).toEqual(["DeepSeek API error 401: invalid api key"]);
    expect(isDshSuccess(0, s)).toBe(false);
  });

  it("treats a non-completed final reason as failure", () => {
    const s = parseDshStream(fixture("cancelled.ndjson"));
    expect(s.finalReason).toBe("max_steps");
    expect(isDshSuccess(0, s)).toBe(false);
  });

  it("falls back to the last text event when final has no text", () => {
    const s = parseDshStream('{"type":"text","text":"partial answer"}\n{"type":"final","sessionId":"x","reason":null,"text":""}\n');
    expect(s.text).toBe("partial answer");
    expect(s.finalReason).toBeNull();
  });

  it("handles lines split across chunks and a trailing line without newline", () => {
    const acc = createDshStreamAccumulator();
    const text = fixture("success.ndjson").trimEnd();
    for (let i = 0; i < text.length; i += 7) acc.push(text.slice(i, i + 7));
    const s = acc.summary();
    expect(s.hasFinal).toBe(true);
    expect(s.usage.inputTokens).toBe(1500);
  });

  it("detects the terminal event", () => {
    expect(hasDshTerminalEvent(fixture("success.ndjson"))).toBe(true);
    expect(hasDshTerminalEvent(fixture("error.ndjson"))).toBe(true);
    expect(hasDshTerminalEvent('{"type":"session","sessionId":"a"}\n')).toBe(false);
    expect(hasDshTerminalEvent('{"type":"text","text":"the word \\"type\\":\\"final\\" in text"}\n')).toBe(false);
  });
});

describe("isUnknownSessionError", () => {
  it("matches dsh refusing a session id", () => {
    expect(isUnknownSessionError("", "Error: unknown session ses_9 for this workspace\n")).toBe(true);
    expect(isUnknownSessionError("", "session ses_9 was not found in DSH_HOME\n")).toBe(true);
    expect(isUnknownSessionError('{"type":"error","message":"Cannot resume session ses_9"}\n', "")).toBe(true);
  });
  it("ignores other failures and completed runs", () => {
    expect(isUnknownSessionError("", "DeepSeek API error 401\n")).toBe(false);
    expect(isUnknownSessionError(fixture("success.ndjson"), "unknown session")).toBe(false);
  });
});
