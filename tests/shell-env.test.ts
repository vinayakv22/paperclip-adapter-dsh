import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BASH_ENV_SCRIPT, planShellForward, readForwardEnv } from "../src/server/shell-env.js";

describe("planShellForward", () => {
  it("forwards scrubbed PAPERCLIP_* credentials and listed extras, never DEEPSEEK_*", () => {
    const plan = planShellForward(
      {
        PAPERCLIP_API_KEY: "jwt",
        PAPERCLIP_RUNTIME_TOOLS_TOKEN: "tools",
        PAPERCLIP_RUN_ID: "run-1",
        GH_TOKEN: "gh",
        DEEPSEEK_API_KEY: "sk",
        OPENSEO_API_KEY: "os",
        PLAIN: "x",
      },
      ["GH_TOKEN", "PLAIN", "MISSING_TOKEN"],
      "/h/paperclip-bash-env.sh",
    );
    expect(plan.names).toEqual(["PAPERCLIP_API_KEY", "PAPERCLIP_RUNTIME_TOOLS_TOKEN", "GH_TOKEN"]);
    expect(plan.vars).toEqual({
      PAPERCLIP_FWD_NAMES: "PAPERCLIP_API_KEY PAPERCLIP_RUNTIME_TOOLS_TOKEN GH_TOKEN",
      BASH_ENV: "/h/paperclip-bash-env.sh",
      PAPERCLIP_FWD_V0: "jwt",
      PAPERCLIP_FWD_V1: "tools",
      PAPERCLIP_FWD_V2: "gh",
    });
    for (const k of Object.keys(plan.vars)) expect(k).not.toMatch(/KEY|PASSWORD|SECRET|TOKEN/i);
    expect(plan.warnings).toEqual(["forwardEnv names MISSING_TOKEN but it is not set for this run."]);
  });

  it("is a no-op without credentials", () => {
    expect(planShellForward({ PAPERCLIP_RUN_ID: "r" }, [], "/h/x.sh")).toEqual({ names: [], vars: {}, warnings: [] });
  });

  it("installs BASH_ENV alone when asked to, even with nothing to forward", () => {
    expect(planShellForward({ PAPERCLIP_RUN_ID: "r" }, [], "/h/x.sh", undefined, { always: true }).vars).toEqual({ BASH_ENV: "/h/x.sh" });
  });

  it("chains an inherited BASH_ENV", () => {
    const plan = planShellForward({ PAPERCLIP_API_KEY: "jwt" }, [], "/h/x.sh", "/etc/bash_env");
    expect(plan.vars.PAPERCLIP_FWD_PREV_BASH_ENV).toBe("/etc/bash_env");
  });
});

describe("readForwardEnv", () => {
  it("accepts lists and newline/comma strings, rejects bad and reserved names", () => {
    const warnings: string[] = [];
    expect(readForwardEnv("GH_TOKEN\nNPM_TOKEN, GH_TOKEN", warnings)).toEqual(["GH_TOKEN", "NPM_TOKEN"]);
    expect(readForwardEnv(["X-Y", "DSH_HOME", "DEEPSEEK_INFERX_API_KEY", "OK_KEY"], warnings)).toEqual(["OK_KEY"]);
    expect(readForwardEnv(42, warnings)).toEqual([]);
    expect(warnings).toHaveLength(4);
  });
});

// The parent env minus anything the assertions read (a bare PATH-only env makes macOS bash
// 3.2 skip BASH_ENV under vitest; Linux bash does not care).
function inherited(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(PAPERCLIP_|GH_TOKEN$|CHAINED$|BASH_ENV$)/.test(k)) env[k] = v;
  }
  return env;
}

describe("BASH_ENV_SCRIPT", () => {
  it("recreates missing /tmp scratch dirs and ignores dirs elsewhere", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-bashenv-"));
    const scratch = `/tmp/paperclip-dsh-test-${process.pid}-${Date.now()}`;
    try {
      const file = path.join(dir, "env.sh");
      await fs.writeFile(file, BASH_ENV_SCRIPT);
      const out = execFileSync("bash", ["-c", 'test -d "$TMPDIR" && test ! -e "$PAPERCLIP_SCRATCH_DIR" && echo ok'], {
        env: { ...inherited(), BASH_ENV: file, TMPDIR: scratch, PAPERCLIP_SCRATCH_DIR: path.join(dir, "not-tmp") },
        encoding: "utf8",
      });
      expect(out.trim()).toBe("ok");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });

  it("restores values with spaces, quotes and $ intact, unsets carriers, and chains", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-bashenv-"));
    try {
      const file = path.join(dir, "env.sh");
      const prev = path.join(dir, "prev.sh");
      await fs.writeFile(file, BASH_ENV_SCRIPT);
      await fs.writeFile(prev, "export CHAINED=yes\n");
      const value = `a b "c" 'd' $HOME \`x\``;
      const plan = planShellForward({ PAPERCLIP_API_KEY: value, GH_TOKEN: "g" }, ["GH_TOKEN"], file, prev);
      const out = execFileSync(
        "bash",
        ["-c", 'printf "%s|%s|%s|%s|%s" "$PAPERCLIP_API_KEY" "$GH_TOKEN" "${PAPERCLIP_FWD_V0-gone}" "${PAPERCLIP_FWD_NAMES-gone}" "$CHAINED"'],
        { env: { ...inherited(), ...plan.vars }, encoding: "utf8" },
      );
      expect(out).toBe(`${value}|g|gone|gone|yes`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
