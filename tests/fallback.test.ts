import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyProviderFailure, readCooldown, readCooldownSec, writeCooldown } from "../src/server/fallback.js";
import { parseDshStream } from "../src/server/stream.js";

const ev = (...events: object[]) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";
const failedTurn = (error: object) =>
  parseDshStream(ev({ type: "session", sessionId: "s1" }, { type: "status", phase: "turn_end", reason: { kind: "error", error } }, { type: "final", text: "" }));

describe("classifyProviderFailure", () => {
  it("names provider failures by dsh error code", () => {
    for (const code of ["RATE_LIMIT", "SERVER", "TRANSPORT", "TIMEOUT", "INVALID_CREDENTIAL", "MISSING_CREDENTIAL", "QUOTA_EXCEEDED"]) {
      expect(classifyProviderFailure({ success: false, timedOut: false, summary: failedTurn({ code, message: "x" }), stderr: "" })).toBe(`${code}: x`);
    }
  });
  it("reads the code from dsh's stderr line and recognises bare HTTP failures", () => {
    const empty = parseDshStream("");
    expect(classifyProviderFailure({ success: false, timedOut: false, summary: empty, stderr: "dsh: TRANSPORT: Connection error.\n" })).toBe("TRANSPORT: Connection error.");
    expect(classifyProviderFailure({ success: false, timedOut: false, summary: empty, stderr: "upstream returned 503 Service Unavailable" })).toContain("503");
    expect(classifyProviderFailure({ success: false, timedOut: false, summary: empty, stderr: "Error: 403 Forbidden" })).toContain("403");
  });
  it("ignores successes, Paperclip timeouts, task-level stops and unrelated errors", () => {
    const capacity = failedTurn({ code: "RATE_LIMIT", message: "429" });
    expect(classifyProviderFailure({ success: true, timedOut: false, summary: capacity, stderr: "" })).toBeNull();
    expect(classifyProviderFailure({ success: false, timedOut: true, summary: capacity, stderr: "" })).toBeNull();
    const maxSteps = parseDshStream(ev({ type: "status", phase: "turn_end", reason: { kind: "max_steps" } }, { type: "final", text: "" }));
    expect(classifyProviderFailure({ success: false, timedOut: false, summary: maxSteps, stderr: "dsh: RATE_LIMIT: 429" })).toBeNull();
    expect(classifyProviderFailure({ success: false, timedOut: false, summary: failedTurn({ code: "CONTEXT_WINDOW_EXCEEDED", message: "too long" }), stderr: "" })).toBeNull();
  });
});

describe("cool-down state", () => {
  it("writes, reads, expires, and keeps other routes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-cool-"));
    try {
      const file = path.join(dir, "sub", "provider-cooldown.json");
      const t0 = new Date("2026-11-02T00:00:00Z");
      await writeCooldown("other", "x", 60, t0, file);
      const entry = await writeCooldown("inferx", "RATE_LIMIT: 429", 900, t0, file);
      expect(entry?.until).toBe("2026-11-02T00:15:00.000Z");
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect(await readCooldown("inferx", new Date("2026-11-02T00:14:59Z"), file)).toMatchObject({ reason: "RATE_LIMIT: 429" });
      expect(await readCooldown("inferx", new Date("2026-11-02T00:15:00Z"), file)).toBeNull();
      expect(await readCooldown("other", t0, file)).not.toBeNull();
      expect(await writeCooldown("inferx", "x", 0, t0, file)).toBeNull();
      await fs.writeFile(file, "{not json");
      expect(await readCooldown("inferx", t0, file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("reads fallbackCooldownSec", () => {
    const w: string[] = [];
    expect(readCooldownSec(undefined)).toBe(900);
    expect(readCooldownSec("0")).toBe(0);
    expect(readCooldownSec(300)).toBe(300);
    expect(readCooldownSec(-5, w)).toBe(900);
    expect(readCooldownSec(10 ** 9)).toBe(86_400);
    expect(w).toHaveLength(1);
  });
});
