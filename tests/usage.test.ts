import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addUsage, emptyUsage, parseDshStream, toPaperclipUsage } from "../src/server/stream.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("usage math", () => {
  it("sums step_end usage and ignores turn_end when steps report usage", () => {
    const s = parseDshStream(fixture("success.ndjson"));
    expect(s.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 200,
      cacheReadTokens: 7100,
      cacheWriteTokens: 500,
      reasoningTokens: 40,
    });
  });

  it("maps Anthropic-style counters to Paperclip usage", () => {
    expect(
      toPaperclipUsage({ inputTokens: 1500, outputTokens: 200, cacheReadTokens: 7100, cacheWriteTokens: 500, reasoningTokens: 40 }),
    ).toEqual({ inputTokens: 9100, outputTokens: 200, cachedInputTokens: 7100 });
  });

  it("falls back to turn_end usage when no step reports usage", () => {
    const s = parseDshStream(fixture("cancelled.ndjson"));
    expect(toPaperclipUsage(s.usage)).toEqual({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 });
  });

  it("ignores junk values", () => {
    const total = addUsage(emptyUsage(), { inputTokens: "12", outputTokens: -4, cacheReadTokens: Number.NaN, cacheWriteTokens: 3 });
    expect(total).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3, reasoningTokens: 0 });
    expect(addUsage(emptyUsage(), null)).toEqual(emptyUsage());
  });

  it("reports zero usage for an empty stream", () => {
    expect(toPaperclipUsage(parseDshStream("").usage)).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
  });
});
