import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { execute } from "../src/server/execute.js";

const FAKE_DSH = fileURLToPath(new URL("./fixtures/fake-dsh.mjs", import.meta.url));
const tmp: string[] = [];
afterEach(async () => {
  await Promise.all(tmp.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function setup(extraConfig: Record<string, unknown> = {}, sessionParams: Record<string, unknown> | null = null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-exec-"));
  tmp.push(root);
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
  return { ctx, cwd, home, logs, metas, calls };
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
