import { describe, expect, it } from "vitest";
import { parseSessionParams, sessionCodec, sessionResumeBlocker } from "../src/server/session.js";

describe("sessionCodec", () => {
  it("round-trips session params", () => {
    const params = { sessionId: "ses_1", cwd: "/w", dshHome: "/h", model: "deepseek-flash" };
    expect(sessionCodec.deserialize(sessionCodec.serialize(params))).toEqual(params);
    expect(sessionCodec.getDisplayId!(params)).toBe("ses_1");
  });
  it("accepts legacy key spellings and drops junk", () => {
    expect(parseSessionParams({ session_id: " ses_2 ", workdir: "/w", extra: 1 })).toEqual({ sessionId: "ses_2", cwd: "/w" });
    expect(sessionCodec.deserialize({ cwd: "/w" })).toBeNull();
    expect(sessionCodec.deserialize("ses_3")).toBeNull();
    expect(sessionCodec.deserialize([])).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
    expect(sessionCodec.getDisplayId!(null)).toBeNull();
  });
});

describe("sessionResumeBlocker", () => {
  it("allows resume only in the same cwd and DSH_HOME", () => {
    const here = { cwd: "/w", dshHome: "/h" };
    expect(sessionResumeBlocker({ sessionId: "s", cwd: "/w/", dshHome: "/h" }, here)).toBeNull();
    expect(sessionResumeBlocker({ sessionId: "s", dshHome: "/h" }, here)).toBeNull();
    expect(sessionResumeBlocker({ sessionId: "codex-thread", cwd: "/w" }, here)).toMatch(/not created by dsh_local/);
    expect(sessionResumeBlocker({ sessionId: "s", cwd: "/other", dshHome: "/h" }, here)).toMatch(/cwd/);
    expect(sessionResumeBlocker({ sessionId: "s", cwd: "/w", dshHome: "/x" }, here)).toMatch(/DSH_HOME/);
    expect(sessionResumeBlocker(null, here)).toMatch(/no saved session/);
  });
});
