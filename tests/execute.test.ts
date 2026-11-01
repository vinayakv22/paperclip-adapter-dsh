import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";

const FAKE_DSH = fileURLToPath(new URL("./fixtures/fake-dsh.mjs", import.meta.url));
const tmp: string[] = [];
const savedEnv = { HOME: process.env.HOME, DEEPSEEK_INFERX_API_KEY: process.env.DEEPSEEK_INFERX_API_KEY, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await Promise.all(tmp.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function setup(extraConfig: Record<string, unknown> = {}, sessionParams: Record<string, unknown> | null = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-exec-"));
  tmp.push(root);
  // Isolate from the host: no real ~/.paperclip-dsh/.env, no ambient InferX key.
  const userHome = path.join(root, "user");
  await fs.mkdir(userHome, { recursive: true });
  process.env.HOME = userHome;
  delete process.env.DEEPSEEK_INFERX_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const cwd = path.join(root, "workspace");
  const home = path.join(root, "home");
  const record = path.join(root, "calls.ndjson");
  const instructions = path.join(root, "bundle", "AGENTS.md");
  await fs.mkdir(path.dirname(instructions), { recursive: true });
  await fs.writeFile(instructions, "# Release Operator\nShip carefully.\n");
  const logs: string[] = [];
  const metas: unknown[] = [];
  const ctx = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "Release Operator", adapterType: "dsh_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams, sessionDisplayId: null, taskKey: null },
    config: {
      command: FAKE_DSH,
      dshHome: home,
      cwd,
      model: "pro",
      instructionsFilePath: instructions,
      addDirs: ["/srv/site/.git"],
      mcpServers: { openseo: { url: "https://app.openseo.so/mcp", headers: { Authorization: "Bearer ${OPENSEO_API_KEY}" } } },
      env: { FAKE_DSH_RECORD: record, DEEPSEEK_API_KEY: "sk-test-not-real" },
      ...extraConfig,
    },
    context: { taskId: "issue-7", wakeReason: "assigned" },
    authToken: "jwt-token",
    onLog: async (_stream: string, chunk: string) => {
      logs.push(chunk);
    },
    onMeta: async (meta: unknown) => {
      metas.push(meta);
    },
  } as unknown as AdapterExecutionContext;
  const calls = async () =>
    (await fs.readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return { ctx, cwd, home, userHome, logs, metas, calls };
}

describe("execute (fake dsh)", () => {
  it("runs dsh headless and reports usage, session and summary", async () => {
    const { ctx, cwd, home, metas, calls } = await setup();
    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toMatch(/^Finished \(\d+ chars of task\)$/);
    expect(result.usage).toEqual({ inputTokens: 160, outputTokens: 20, cachedInputTokens: 50 });
    expect(result).toMatchObject({ usageBasis: "per_run", provider: "deepseek", biller: "deepseek", billingType: "api", model: "deepseek-v4-pro" });
    expect(result.sessionParams).toEqual({ sessionId: "ses_fresh", cwd, dshHome: home, model: "deepseek-v4-pro" });

    const [call] = await calls();
    expect(call.args).toEqual([
      "--profile", "headless", "--patch", path.join(home, "paperclip.patch.yml"), "--json", "-",
    ]);
    expect(await fs.realpath(call.cwd)).toBe(await fs.realpath(cwd));
    expect(call.env).toMatchObject({
      DSH_HOME: home,
      DSH_TELEMETRY_MODE: "DISABLED",
      DSH_PERMISSION_MODE: "workspace-write",
      PAPERCLIP_RUN_ID: "run-1",
      PAPERCLIP_TASK_ID: "issue-7",
      PAPERCLIP_API_KEY_SET: true,
      DEEPSEEK_API_KEY_SET: true,
    });
    expect(call.stdin).toContain("X-Paperclip-Run-Id");

    const patch = await fs.readFile(path.join(home, "paperclip.patch.yml"), "utf8");
    expect(patch).toContain('model: "deepseek-v4-pro"');
    expect(patch).toContain("process.env.OPENSEO_API_KEY");
    expect(patch).not.toContain("sk-test-not-real");
    expect(patch).toMatch(/- id: approval\n  config:\n    policy: never/);
    expect(patch).toMatch(/- id: permission\n  disabled: true/);
    expect(await fs.readFile(path.join(home, "AGENTS.md"), "utf8")).toContain("Ship carefully.");

    const meta = JSON.stringify(metas);
    expect(meta).not.toContain("sk-test-not-real");
    expect(meta).not.toContain("jwt-token");
  });

  it("gets the run token past dsh's shell env scrub via BASH_ENV", async () => {
    const { ctx, home, logs, metas, calls } = await setup({
      env: { FAKE_DSH_RECORD: "", DEEPSEEK_API_KEY: "sk-test-not-real", GH_TOKEN: "gh-not-real" },
      forwardEnv: ["GH_TOKEN", "DEEPSEEK_API_KEY"],
    });
    const record = path.join(path.dirname(home), "calls.ndjson");
    (ctx.config as { env: Record<string, string> }).env.FAKE_DSH_RECORD = record;
    const result = await execute(ctx);
    expect(result.exitCode).toBe(0);

    const [call] = await calls();
    expect(call.shell).toEqual({
      PAPERCLIP_API_KEY: "jwt-token",
      GH_TOKEN: "gh-not-real",
      DEEPSEEK_API_KEY: "<unset>",
      PAPERCLIP_FWD_V0: "<unset>",
    });
    const script = await fs.readFile(path.join(home, "paperclip-bash-env.sh"), "utf8");
    expect(script).not.toContain("jwt-token");
    expect(logs.join("")).toContain("Forwarding PAPERCLIP_API_KEY, GH_TOKEN to the dsh shell tool");
    expect(logs.join("")).toContain("forwardEnv entry DEEPSEEK_API_KEY is reserved");
    const meta = JSON.stringify(metas);
    expect(meta).not.toContain("jwt-token");
    expect(meta).not.toContain("gh-not-real");
  });

  it("forwards nothing and warns when Paperclip mints no run token", async () => {
    const { ctx, home, logs, calls } = await setup();
    (ctx as { authToken?: string }).authToken = undefined;
    await execute(ctx);
    const [call] = await calls();
    expect(call.shell.PAPERCLIP_API_KEY).toBe("<unset>");
    // workspace-write still installs BASH_ENV (it recreates the scratch dirs), with nothing to forward.
    expect(await fs.readFile(path.join(home, "paperclip-bash-env.sh"), "utf8")).toContain("mkdir -p");
    expect(logs.join("")).not.toContain("Forwarding");
    expect(logs.join("")).toContain("No Paperclip run token");
  });

  it("leaves BASH_ENV alone outside workspace-write when there is nothing to forward", async () => {
    const { ctx, home, calls } = await setup({ permissionMode: "danger-full-access" });
    (ctx as { authToken?: string }).authToken = undefined;
    await execute(ctx);
    const [call] = await calls();
    await expect(fs.access(path.join(home, "paperclip-bash-env.sh"))).rejects.toThrow();
    expect(call.stdin).not.toContain("Shell sandbox:");
  });

  it("tells workspace-write agents that /tmp does not survive between commands", async () => {
    const { ctx, calls } = await setup();
    await execute(ctx);
    const [call] = await calls();
    expect(call.stdin).toContain("Shell sandbox: every shell command starts with an empty /tmp");
  });

  it("resumes a matching session", async () => {
    const s = await setup();
    const first = await execute(s.ctx);
    (s.ctx.runtime as { sessionParams: unknown }).sessionParams = first.sessionParams!;
    const second = await execute(s.ctx);
    const calls = await s.calls();
    expect(calls[1].args).toContain("--session-id");
    expect(second.sessionId).toBe("ses_fresh");
    expect(second.clearSession).toBe(false);
  });

  it("skips a session saved for another cwd", async () => {
    const s = await setup({}, { sessionId: "ses_old", cwd: "/elsewhere" });
    await execute(s.ctx);
    expect((await s.calls())[0].args).not.toContain("--session-id");
    expect(s.logs.join("")).toMatch(/Not resuming dsh session ses_old/);
  });

  it("retries fresh when dsh no longer knows the session", async () => {
    const s = await setup({ env: { FAKE_DSH_MODE: "unknown-session" } }, null);
    (s.ctx.config as Record<string, unknown>).env = {
      FAKE_DSH_MODE: "unknown-session",
      FAKE_DSH_RECORD: path.join(path.dirname(s.home), "calls.ndjson"),
    };
    (s.ctx.runtime as { sessionParams: unknown }).sessionParams = { sessionId: "ses_gone", cwd: s.cwd, dshHome: s.home };
    const result = await execute(s.ctx);
    const calls = await s.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toContain("ses_gone");
    expect(calls[1].args).not.toContain("--session-id");
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBe("ses_fresh");
  });

  it("classifies API failures", async () => {
    const s = await setup();
    (s.ctx.config as Record<string, unknown>).env = {
      FAKE_DSH_MODE: "error",
      FAKE_DSH_RECORD: path.join(path.dirname(s.home), "calls.ndjson"),
    };
    const result = await execute(s.ctx);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("rate_limited");
    expect(result.errorMessage).toBe("DeepSeek API error 429: rate limit reached");
  });

  it("reaps a dsh process that lingers after its final event", async () => {
    const s = await setup();
    (s.ctx.config as Record<string, unknown>).env = {
      FAKE_DSH_MODE: "hang",
      FAKE_DSH_RECORD: path.join(path.dirname(s.home), "calls.ndjson"),
    };
    const result = await execute(s.ctx);
    expect(result.summary).toMatch(/^Finished/);
    expect(result.timedOut).toBe(false);
  }, 20_000);

  it("keeps the prompt lean: AGENTS.md stays in DSH_HOME, resume sends the compact task brief", async () => {
    const wake = { reason: "issue_commented", comments: [{ id: "c1", body: "any update?", authorType: "user", createdAt: "2026-11-01T00:00:00Z" }] };
    const taskContext = { paperclipTaskMarkdown: "FULL TASK BRIEF", paperclipTaskMarkdownCompact: "COMPACT BRIEF", paperclipWake: wake };

    const fresh = await setup({ mcpServers: undefined, addDirs: undefined });
    Object.assign(fresh.ctx.context as Record<string, unknown>, taskContext);
    await execute(fresh.ctx);
    const [first] = await fresh.calls();
    expect(first.stdin).not.toContain("Ship carefully.");
    expect(first.stdin).toContain("FULL TASK BRIEF");

    const resumed = await setup({ mcpServers: undefined, addDirs: undefined });
    (resumed.ctx.runtime as { sessionParams: unknown }).sessionParams = { sessionId: "ses_prev", cwd: resumed.cwd, dshHome: resumed.home };
    Object.assign(resumed.ctx.context as Record<string, unknown>, taskContext);
    await execute(resumed.ctx);
    const [second] = await resumed.calls();
    expect(second.args).toContain("--session-id");
    expect(second.stdin).not.toContain("Ship carefully.");
    expect(second.stdin).toContain("COMPACT BRIEF");
    expect(second.stdin).not.toContain("FULL TASK BRIEF");
    expect(second.stdin.length).toBeLessThan(first.stdin.length);
  });

  it("uses InferX when DEEPSEEK_INFERX_API_KEY is in the shared key file", async () => {
    const s = await setup({ model: "deepseek-flash", mcpServers: undefined, addDirs: undefined });
    const sharedDir = path.join(s.userHome, ".paperclip-dsh");
    await fs.mkdir(sharedDir, { recursive: true });
    await fs.writeFile(path.join(sharedDir, ".env"), "DEEPSEEK_INFERX_API_KEY=ix-test-not-real\nOTHER=x\n", { mode: 0o600 });
    const result = await execute(s.ctx);
    expect(result.exitCode).toBe(0);
    expect(result).toMatchObject({ provider: "inferx", biller: "inferx", model: "deepseek-v4.1-flash-1017-basic" });
    const [call] = await s.calls();
    expect(call.env.DEEPSEEK_INFERX_API_KEY_SET).toBe(true);
    const patch = await fs.readFile(path.join(s.home, "paperclip.patch.yml"), "utf8");
    expect(patch).toContain('    provider: "inferx"\n    model: "deepseek-v4.1-flash-1017-basic"');
    expect(patch).toContain('        baseURL: "https://model.inferx.net/endpoints/v1"');
    expect(patch).toContain('        apiKeyEnv: "DEEPSEEK_INFERX_API_KEY"');
    expect(patch).not.toContain("ix-test-not-real");
    expect(s.logs.join("")).toMatch(/Using DEEPSEEK_INFERX_API_KEY from .*\.paperclip-dsh\/\.env/);
    expect(s.logs.join("")).not.toContain("ix-test-not-real");
  });

  describe("InferX fallback", () => {
    async function withInferx(extra: Record<string, unknown> = {}) {
      const s = await setup({ model: "deepseek-flash", mcpServers: undefined, addDirs: undefined, ...extra });
      const sharedDir = path.join(s.userHome, ".paperclip-dsh");
      await fs.mkdir(sharedDir, { recursive: true });
      await fs.writeFile(path.join(sharedDir, ".env"), "DEEPSEEK_INFERX_API_KEY=ix-test-not-real\n", { mode: 0o600 });
      return { ...s, cooldownFile: path.join(sharedDir, "provider-cooldown.json") };
    }
    const mode = (ctx: AdapterExecutionContext, m: string) => {
      (ctx.config as { env: Record<string, string> }).env.FAKE_DSH_MODE = m;
    };

    it("re-runs a capacity-failed InferX heartbeat on deepseek-official, resuming its session", async () => {
      const s = await withInferx();
      mode(s.ctx, "inferx-down");
      const result = await execute(s.ctx);

      expect(result.exitCode).toBe(0);
      expect(result.errorMessage).toBeNull();
      expect(result).toMatchObject({ provider: "deepseek", biller: "deepseek", model: "deepseek-flash" });
      expect(result.sessionParams).toMatchObject({ sessionId: "ses_fresh", model: "deepseek-flash" });
      expect(result.resultJson).toMatchObject({
        fallback: { from: "inferx", to: "deepseek-official", resumedSession: "ses_fresh", reason: expect.stringContaining("RATE_LIMIT: 429") },
      });

      const calls = await s.calls();
      expect(calls).toHaveLength(2);
      expect(calls[0].args).not.toContain("--session-id");
      expect(calls[1].args).toEqual(expect.arrayContaining(["--session-id", "ses_fresh"]));
      expect(calls[1].stdin).toContain("the previous model provider (InferX) failed");
      expect(calls[1].env.DEEPSEEK_API_KEY_SET).toBe(true);

      const log = s.logs.join("");
      expect(log).toContain("[dsh] InferX failed (RATE_LIMIT: 429 service failure");
      expect(log).toContain("falling back to deepseek-official");
      const patch = await fs.readFile(path.join(s.home, "paperclip.patch.yml"), "utf8");
      expect(patch).toContain('    provider: "deepseek-official"\n    model: "deepseek-flash"');
      expect(patch).toMatch(/- id: llm-deepseek\n  config:\n    models:\n      - id: "deepseek-flash"\n        name: "DeepSeek-V4.1-Flash"\n        contextWindow: 262144/);
      expect(patch).not.toContain("llm-pi-ai");

      const cooldown = JSON.parse(await fs.readFile(s.cooldownFile, "utf8"));
      expect(cooldown.inferx.reason).toContain("RATE_LIMIT");
      const minutes = (Date.parse(cooldown.inferx.until) - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(14);
      expect(minutes).toBeLessThanOrEqual(15);
    });

    it("goes straight to deepseek-official while InferX cools down, then back to InferX", async () => {
      const s = await withInferx();
      await fs.writeFile(
        s.cooldownFile,
        JSON.stringify({ inferx: { until: new Date(Date.now() + 600_000).toISOString(), reason: "RATE_LIMIT: 429", at: new Date().toISOString() } }),
      );
      const result = await execute(s.ctx);
      expect(result).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
      expect(await s.calls()).toHaveLength(1);
      expect(s.logs.join("")).toContain("InferX is cooling down until");

      await fs.writeFile(
        s.cooldownFile,
        JSON.stringify({ inferx: { until: new Date(Date.now() - 1_000).toISOString(), reason: "old", at: "" } }),
      );
      const again = await execute(s.ctx);
      expect(again).toMatchObject({ provider: "inferx" });
    });

    it("starts fresh on deepseek-official when InferX failed before a session existed, and on connection errors", async () => {
      const s = await withInferx();
      mode(s.ctx, "inferx-unreachable");
      const result = await execute(s.ctx);
      expect(result).toMatchObject({ exitCode: 0, provider: "deepseek" });
      expect(s.logs.join("")).toContain("[dsh] InferX failed (TRANSPORT: Connection error.)");
    });

    it("does not fall back when fallbackProvider is none", async () => {
      const s = await withInferx({ fallbackProvider: "none" });
      mode(s.ctx, "inferx-down");
      const result = await execute(s.ctx);
      expect(result).toMatchObject({ provider: "inferx", errorCode: "rate_limited" });
      expect(await s.calls()).toHaveLength(1);
      await expect(fs.access(s.cooldownFile)).rejects.toThrow();
    });

    it("does not fall back without DEEPSEEK_API_KEY", async () => {
      const s = await withInferx({ env: { FAKE_DSH_RECORD: "", FAKE_DSH_MODE: "inferx-down" } });
      (s.ctx.config as { env: Record<string, string> }).env.FAKE_DSH_RECORD = path.join(path.dirname(s.home), "calls.ndjson");
      const result = await execute(s.ctx);
      expect(result.provider).toBe("inferx");
      expect(await s.calls()).toHaveLength(1);
    });

    it("does not fall back when the task itself stopped (max_steps)", async () => {
      const s = await withInferx();
      mode(s.ctx, "max-steps");
      const result = await execute(s.ctx);
      expect(result.provider).toBe("inferx");
      expect(await s.calls()).toHaveLength(1);
      await expect(fs.access(s.cooldownFile)).rejects.toThrow();
    });
  });

  it("stays on deepseek-official without an InferX key", async () => {
    const s = await setup({ model: "deepseek-flash", mcpServers: undefined, addDirs: undefined });
    const result = await execute(s.ctx);
    expect(result).toMatchObject({ provider: "deepseek", model: "deepseek-flash" });
    const patch = await fs.readFile(path.join(s.home, "paperclip.patch.yml"), "utf8");
    expect(patch).toContain('    provider: "deepseek-official"');
    expect(patch).not.toContain("llm-pi-ai");
  });

  it("runs a Codex agent's config after only adapterType + model change", async () => {
    const s = await setup({
      model: "deepseek-flash",
      modelReasoningEffort: "xhigh",
      engine: "cli",
      extraArgs: ["-c", "model_reasoning_effort=xhigh"],
      addDirs: undefined,
      mcpServers: undefined,
    });
    (s.ctx.runtime as { sessionParams: unknown }).sessionParams = { sessionId: "codex-thread-1", cwd: s.cwd };
    const result = await execute(s.ctx);
    const [call] = await s.calls();
    expect(result.exitCode).toBe(0);
    expect(result.model).toBe("deepseek-flash");
    expect(call.args).not.toContain("-c");
    expect(call.args).not.toContain("--session-id");
    expect(s.logs.join("")).toMatch(/not created by dsh_local/);
  });

  it("refuses remote execution targets", async () => {
    const s = await setup();
    (s.ctx as { executionTarget: unknown }).executionTarget = { kind: "remote", transport: "sandbox", providerKey: "e2b" };
    const result = await execute(s.ctx);
    expect(result.errorCode).toBe("unsupported_execution_target");
  });
});
