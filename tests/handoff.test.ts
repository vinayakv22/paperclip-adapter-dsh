import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handoffKeys, readIssueHandoff } from "../src/server/handoff.js";

describe("issue handoff", () => {
  it("collects safe keys, identifier first", () => {
    expect(handoffKeys({ issueId: "uuid-1", paperclipWake: { issue: { identifier: "SEO-9" } } })).toEqual(["SEO-9", "uuid-1"]);
    expect(handoffKeys({ issueIdentifier: "../etc/passwd", taskId: "ok-1" })).toEqual(["ok-1"]);
    expect(handoffKeys({})).toEqual([]);
  });
  it("reads the file by identifier, falls back to the issue id, truncates, and tolerates absence", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-handoff-"));
    try {
      expect(await readIssueHandoff({ issueId: "u1" }, dir)).toBe("");
      await fs.writeFile(path.join(dir, "u1.md"), "by id\n");
      expect(await readIssueHandoff({ issueId: "u1", issueIdentifier: "SEO-1" }, dir)).toBe("by id");
      await fs.writeFile(path.join(dir, "SEO-1.md"), "by identifier");
      expect(await readIssueHandoff({ issueId: "u1", issueIdentifier: "SEO-1" }, dir)).toBe("by identifier");
      await fs.writeFile(path.join(dir, "SEO-2.md"), "x".repeat(30000));
      expect(await readIssueHandoff({ issueIdentifier: "SEO-2" }, dir)).toContain("[handoff truncated]");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
