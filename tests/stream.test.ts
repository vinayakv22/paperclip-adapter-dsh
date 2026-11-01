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

  it("parses a real dsh 0.2.1-rc.5 headless stream (reason on turn_end, final without reason)", () => {
    const stdout = [
      '{"type":"session","sessionId":"session-90a687ff","cwd":"/tmp/ws"}',
      '{"type":"status","phase":"turn_start","turn":1}',
      '{"type":"status","phase":"step_start","turn":1,"step":1}',
      '{"type":"thinking","text":""}',
      '{"type":"text","text":"I\'ll run the requested command."}',
      '{"type":"tool_call","callId":"call_00","tool":"bash","input":{"command":"curl -s https://example.com/"}}',
      '{"type":"tool_result","callId":"call_00","status":"completed","result":"200"}',
      '{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":5707,"outputTokens":85,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":5792}}',
      '{"type":"status","phase":"step_start","turn":1,"step":2}',
      '{"type":"text","text":"200"}',
      '{"type":"status","phase":"step_end","turn":1,"step":2,"usage":{"inputTokens":173,"outputTokens":31,"cacheReadTokens":5632,"cacheWriteTokens":0,"totalTokens":5836}}',
      '{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}',
      '{"type":"final","text":"200"}',
    ].join("\n") + "\n";
    const s = parseDshStream(stdout);
    expect(s.sessionId).toBe("session-90a687ff");
    expect(s.hasFinal).toBe(true);
    expect(s.finalReason).toBe("completed");
    expect(s.text).toBe("200");
    expect(s.toolCalls).toBe(1);
    expect(s.steps).toBe(2);
    expect(s.usage).toMatchObject({ inputTokens: 5880, outputTokens: 116, cacheReadTokens: 5632 });
    expect(isDshSuccess(0, s)).toBe(true);
  });
  it("does not take a turn_end reason without a final event", () => {
    const s = parseDshStream('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n');
    expect(s.hasFinal).toBe(false);
    expect(isDshSuccess(0, s)).toBe(false);
  });
  it("prefers final.reason over turn_end", () => {
    const s = parseDshStream('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n{"type":"final","reason":{"kind":"max_steps"},"text":""}\n');
    expect(s.finalReason).toBe("max_steps");
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
