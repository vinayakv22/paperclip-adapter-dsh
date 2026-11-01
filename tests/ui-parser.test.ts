import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createStdoutParser, parseStdoutLine } from "../src/ui-parser.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const TS = "2026-11-01T00:00:00.000Z";

describe("ui-parser", () => {
  it("has no imports, so Paperclip can eval it in the browser", () => {
    const source = readFileSync(new URL("../src/ui-parser.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/require\(/);
  });

  it("turns a dsh run into transcript entries", () => {
    const parser = createStdoutParser();
    const entries = fixture("success.ndjson")
      .split("\n")
      .flatMap((line) => parser.parseLine(line, TS));
    expect(entries.map((e) => e.kind)).toEqual([
      "init",
      "thinking",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant",
      "result",
    ]);
    expect(entries[0]).toMatchObject({ kind: "init", sessionId: "ses_01" });
    expect(entries[2]).toMatchObject({ kind: "tool_call", name: "shell", toolUseId: "c1" });
    expect(entries[5]).toMatchObject({ kind: "tool_result", toolUseId: "c2", toolName: "read_file", isError: true, content: "ENOENT: no such file" });
    expect(entries[7]).toMatchObject({
      kind: "result",
      text: "Posted the status comment on SEO-12.",
      inputTokens: 9100,
      outputTokens: 200,
      cachedTokens: 7100,
      isError: false,
      subtype: "completed",
    });
  });

  it("reports error events and non-completed finals as failed results", () => {
    const parser = createStdoutParser();
    const errorEntries = fixture("error.ndjson").split("\n").flatMap((l) => parser.parseLine(l, TS));
    expect(errorEntries.at(-1)).toMatchObject({ kind: "result", isError: true, errors: ["DeepSeek API error 401: invalid api key"] });
    parser.reset();
    const cancelled = fixture("cancelled.ndjson").split("\n").flatMap((l) => parser.parseLine(l, TS));
    expect(cancelled.at(-1)).toMatchObject({ kind: "result", isError: true, subtype: "max_steps" });
  });

  it("classifies non-JSON lines", () => {
    expect(parseStdoutLine("[paperclip] Linked skill paperclip", TS)).toEqual([{ kind: "system", ts: TS, text: "[paperclip] Linked skill paperclip" }]);
    expect(parseStdoutLine("npm warn something", TS)).toEqual([{ kind: "stdout", ts: TS, text: "npm warn something" }]);
    expect(parseStdoutLine("{broken", TS)[0]!.kind).toBe("stdout");
    expect(parseStdoutLine("   ", TS)).toEqual([]);
    expect(parseStdoutLine('{"type":"status","phase":"turn_start"}', TS)).toEqual([]);
    expect(parseStdoutLine('{"type":"future_event","x":1}', TS)[0]!.kind).toBe("system");
  });
});
