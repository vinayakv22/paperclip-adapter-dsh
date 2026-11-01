import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSharedDeepseekEnv, resolveDshHome, safeSegment, syncAgentsMd } from "../src/server/home.js";

const tmp: string[] = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-home-"));
  tmp.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tmp.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe("resolveDshHome", () => {
  it("defaults to a per-agent directory", () => {
    expect(resolveDshHome({}, "agent-1")).toBe(path.join(os.homedir(), ".paperclip-dsh", "agents", "agent-1"));
  });
  it("honours dshHome with {agentId} and ~", () => {
    expect(resolveDshHome({ dshHome: "~/dsh/{agentId}" }, "a1")).toBe(path.join(os.homedir(), "dsh", "a1"));
    expect(resolveDshHome({ env: { DSH_HOME: "/srv/dsh" } }, "a1")).toBe("/srv/dsh");
  });
  it("sanitises agent ids", () => {
    expect(safeSegment("../../etc")).toBe("__.._etc");
    expect(safeSegment("")).toBe("unknown-agent");
  });
});

describe("syncAgentsMd", () => {
  it("copies instructions, then removes only its own copy", async () => {
    const home = await tempDir();
    const src = path.join(await tempDir(), "AGENTS.md");
    await fs.writeFile(src, "# Role\nBe useful.\n");
    expect((await syncAgentsMd(home, src)).status).toBe("written");
    expect((await syncAgentsMd(home, src)).status).toBe("unchanged");
    const copy = await fs.readFile(path.join(home, "AGENTS.md"), "utf8");
    expect(copy).toContain("Be useful.");
    expect(copy).toContain(`Resolve relative file references from ${path.dirname(src)}/`);
    expect((await syncAgentsMd(home, "")).status).toBe("removed");

    await fs.writeFile(path.join(home, "AGENTS.md"), "user-owned");
    expect((await syncAgentsMd(home, "")).status).toBe("none");
    expect(await fs.readFile(path.join(home, "AGENTS.md"), "utf8")).toBe("user-owned");
  });
  it("warns when the instructions file is unreadable", async () => {
    const result = await syncAgentsMd(await tempDir(), "/nope/AGENTS.md");
    expect(result.warning).toMatch(/could not read/);
  });
});

describe("readSharedDeepseekEnv", () => {
  it("reads DEEPSEEK_* keys from an owner-only file", async () => {
    const file = path.join(await tempDir(), ".env");
    await fs.writeFile(file, "# shared\nexport DEEPSEEK_API_KEY='sk-abc'\nOTHER=1\nDEEPSEEK_BASE_URL=\"https://api.deepseek.com\"\n", { mode: 0o600 });
    expect((await readSharedDeepseekEnv(file)).env).toEqual({ DEEPSEEK_API_KEY: "sk-abc", DEEPSEEK_BASE_URL: "https://api.deepseek.com" });
  });
  it("refuses a group/world-readable file and tolerates a missing one", async () => {
    const file = path.join(await tempDir(), ".env");
    await fs.writeFile(file, "DEEPSEEK_API_KEY=sk-abc\n");
    await fs.chmod(file, 0o644);
    const result = await readSharedDeepseekEnv(file);
    expect(result.env).toEqual({});
    expect(result.warning).toMatch(/chmod 600/);
    expect(await readSharedDeepseekEnv("/nope/.env")).toEqual({ env: {} });
  });
});
