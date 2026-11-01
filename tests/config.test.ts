import { describe, expect, it } from "vitest";
import { createServerAdapter } from "../src/index.js";
import { resolveDshModel } from "../src/constants.js";
import { buildDshArgs, buildDshEnv, readDshConfig } from "../src/server/config.js";
import { compareVersions } from "../src/server/test.js";

describe("readDshConfig", () => {
  it("applies defaults", () => {
    const c = readDshConfig({});
    expect(c).toMatchObject({
      command: "dsh",
      model: "deepseek-flash",
      permissionMode: "workspace-write",
      addDirs: [],
      mcpServers: [],
      disableTelemetry: true,
      timeoutSec: 0,
      graceSec: 15,
      extraArgs: [],
    });
  });
  it("normalizes user input", () => {
    const c = readDshConfig({
      command: " /opt/dsh ",
      model: "pro",
      permissionMode: "bogus",
      addDirs: "/srv/site/.git\nrelative/dir, /srv/shared\n/srv/shared",
      disableTelemetry: "false",
      timeoutSec: "600",
      graceSec: -1,
      dshExtraArgs: "--verbose\n--max-steps\n40",
    });
    expect(c.command).toBe("/opt/dsh");
    expect(c.model).toBe("deepseek-v4-pro");
    expect(c.permissionMode).toBe("workspace-write");
    expect(c.addDirs).toEqual(["/srv/site/.git", "/srv/shared"]);
    expect(c.warnings.join("\n")).toMatch(/relative\/dir/);
    expect(c.warnings.join("\n")).toMatch(/permissionMode "bogus" is not a dsh mode/);
    expect(c.warnings.join("\n")).toMatch(/addDirs .* is not supported by dsh 0\.2\.x/);
    expect(c.disableTelemetry).toBe(false);
    expect(c.timeoutSec).toBe(600);
    expect(c.graceSec).toBe(15);
    expect(c.extraArgs).toEqual(["--verbose", "--max-steps", "40"]);
  });
  it("accepts a Codex agent's config unchanged (fallback swap)", () => {
    const c = readDshConfig({
      command: "/home/paperclip/.local/bin/codex-lb",
      model: "gpt-5.5-codex",
      modelReasoningEffort: "high",
      engine: "cli",
      extraArgs: ["-c", "mcp_servers.openseo.url=https://app.openseo.so/mcp"],
      timeoutSec: 3600,
      graceSec: 30,
    });
    expect(c.command).toBe("dsh");
    expect(c.model).toBe("deepseek-flash");
    expect(c.extraArgs).toEqual([]);
    expect(c.timeoutSec).toBe(3600);
    expect(c.graceSec).toBe(30);
    expect(c.warnings).toEqual([]);
  });
  it("keeps dsh-looking commands only", () => {
    for (const ok of ["dsh", "/home/u/.local/bin/dsh", "C:\\tools\\dsh.cmd", "my-dsh-wrapper", "fake-dsh.mjs"]) {
      expect(readDshConfig({ command: ok }).command).toBe(ok);
    }
    for (const bad of ["codex", "codex-lb", "/home/paperclip/.local/bin/dsh-paperclip", "dashboard", "ssh"]) {
      expect(readDshConfig({ command: bad }).command).toBe("dsh");
    }
  });
  it("accepts dsh's three sandbox modes", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"]) {
      const c = readDshConfig({ permissionMode: mode });
      expect(c.permissionMode).toBe(mode);
      expect(c.warnings).toEqual([]);
    }
    expect(readDshConfig({ permissionMode: "auto" }).permissionMode).toBe("workspace-write");
  });
  it("resolves model aliases", () => {
    expect(resolveDshModel("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(resolveDshModel("inherit")).toBe("deepseek-flash");
    expect(resolveDshModel("deepseek-v5-preview")).toBe("deepseek-v5-preview");
    expect(resolveDshModel("gpt-5.5")).toBe("deepseek-flash");
  });
});

describe("buildDshArgs", () => {
  it("puts launcher flags first and reads the task from stdin", () => {
    expect(
      buildDshArgs({ patchFile: "/h/p.yml", sessionId: "ses_1", extraArgs: ["--x"] }),
    ).toEqual([
      "--profile", "headless", "--patch", "/h/p.yml", "--json",
      "--session-id", "ses_1",
      "--x", "-",
    ]);
  });
  it("never passes flags the dsh 0.2.x headless app rejects", () => {
    const args = buildDshArgs({ patchFile: "/h/p.yml", sessionId: null, extraArgs: [] });
    for (const flag of ["--permission-mode", "--approval-policy", "--add-dir"]) expect(args).not.toContain(flag);
  });
  it("sets the permission mode through DSH_PERMISSION_MODE", () => {
    expect(buildDshEnv({ permissionMode: "read-only" })).toEqual({ DSH_PERMISSION_MODE: "read-only" });
  });
});

describe("createServerAdapter", () => {
  it("exposes the Paperclip contract", () => {
    const a = createServerAdapter();
    expect(a.type).toBe("dsh_local");
    expect(a.supportsLocalAgentJwt).toBe(true);
    expect(a.supportsInstructionsBundle).toBe(true);
    expect(a.instructionsPathKey).toBe("instructionsFilePath");
    expect(a.models!.map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-v4-pro", "deepseek-v4.1-flash-1017-basic"]);
    for (const fn of [a.execute, a.testEnvironment, a.listSkills, a.syncSkills, a.getConfigSchema]) expect(typeof fn).toBe("function");
    expect(a.sessionCodec).toBeDefined();
    expect(a.agentConfigurationDoc).toContain("dsh_local");
  });
  it("never exposes env as a plain form field", async () => {
    const schema = await createServerAdapter().getConfigSchema!();
    expect(schema.fields.map((f) => f.key)).not.toContain("env");
  });
});

describe("compareVersions", () => {
  it("compares node versions", () => {
    expect(compareVersions("v26.1.0", "24.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v24.9.0", "24.9.0")).toBe(0);
    expect(compareVersions("v22.18.0", "24.9.0")).toBeLessThan(0);
  });
});
