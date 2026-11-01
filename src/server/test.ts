/**
 * "Test environment" button in the Paperclip agent editor.
 *
 * Checks: dsh resolvable and `dsh --version` runs, Node >= 24.9, the API key for the chosen
 * provider (InferX, deepseek-official or a custom route) is reachable (env binding, host env
 * or a .env file — the value is never read out), and the DSH_HOME root is writable.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { ensureCommandResolvable, ensurePathInEnv, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { ADAPTER_TYPE, DEEPSEEK_KEY_ENV, DSH_MIN_NODE_VERSION, INFERX_PROVIDER } from "../constants.js";
import { readDshConfig } from "./config.js";
import { resolveFallback, resolveProvider } from "./provider.js";
import { readCooldown, readCooldownSec } from "./fallback.js";
import { defaultDshHomesRoot, readSharedDeepseekEnv, resolveDshHome, sharedEnvFile } from "./home.js";

const run = promisify(execFile);

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, "").split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fileHasKey(file: string, key: string): Promise<boolean> {
  try {
    const text = await fs.readFile(file, "utf8");
    return new RegExp(`^\\s*(export\\s+)?${key}\\s*=\\s*\\S`, "m").test(text);
  } catch {
    return false;
  }
}

/** Env value present: a plain string, or a Paperclip secret/binding object. */
function envBindingPresent(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value && typeof value === "object");
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const settings = readDshConfig(config);
  const checks: AdapterEnvironmentCheck[] = [];
  const envConfig = parseObject(config.env);
  const plainEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(envConfig)) if (typeof v === "string") plainEnv[k] = v;
  const env = ensurePathInEnv({ ...process.env, ...plainEnv });
  const cwd = typeof config.cwd === "string" && path.isAbsolute(config.cwd) ? config.cwd : os.homedir();

  if (ctx.executionTarget && (ctx.executionTarget as { kind?: string }).kind && (ctx.executionTarget as { kind?: string }).kind !== "local") {
    checks.push({
      code: "dsh_remote_target",
      level: "error",
      message: "dsh_local only runs on the Paperclip host; remote execution targets are not supported.",
    });
  }

  for (const w of settings.warnings) checks.push({ code: "dsh_config_warning", level: "warn", message: w });

  // 1. dsh on PATH + version
  let dshOk = false;
  try {
    await ensureCommandResolvable(settings.command, cwd, env);
    const { stdout, stderr } = await run(settings.command, ["--version"], { cwd, env, timeout: 20_000 });
    const version = (stdout || stderr).trim().split("\n")[0] ?? "";
    checks.push({ code: "dsh_version", level: "info", message: `dsh ${version || "(version not reported)"}` });
    dshOk = true;
  } catch (err) {
    checks.push({
      code: "dsh_missing",
      level: "error",
      message: `Cannot run "${settings.command} --version".`,
      detail: err instanceof Error ? err.message.slice(0, 400) : String(err),
      hint: "Install with: npm install -g --prefix $HOME/.local @deepseek-ai/dsh, then set the command to the full path if it is not on PATH.",
    });
  }

  // 2. node version (dsh's shebang uses `node` from PATH)
  try {
    const { stdout } = await run("node", ["--version"], { cwd, env, timeout: 10_000 });
    const version = stdout.trim();
    const ok = compareVersions(version, DSH_MIN_NODE_VERSION) >= 0;
    checks.push({
      code: ok ? "node_version" : "node_too_old",
      level: ok ? "info" : "error",
      message: `node ${version}${ok ? "" : ` is older than ${DSH_MIN_NODE_VERSION}, which dsh requires`}`,
    });
  } catch (err) {
    checks.push({
      code: "node_missing",
      level: dshOk ? "warn" : "error",
      message: "Could not run node --version on the run PATH.",
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
    });
  }

  // 3. Provider + its API key — presence only, never the value
  const homesRoot = typeof config.dshHome === "string" && config.dshHome.trim() && !config.dshHome.includes("{agentId}")
    ? resolveDshHome(config, "probe")
    : defaultDshHomesRoot();
  const shared = await readSharedDeepseekEnv();
  if (shared.warning) checks.push({ code: "dsh_shared_env_insecure", level: "warn", message: shared.warning });
  const keySourceOf = (name: string): string | null =>
    envBindingPresent(envConfig[name])
      ? "the agent's environment (Paperclip env/secret binding)"
      : typeof process.env[name] === "string" && process.env[name]!.trim()
        ? "the Paperclip server's environment"
        : shared.env[name]
          ? sharedEnvFile()
          : null;
  const llm = resolveProvider(config, (name) => keySourceOf(name) !== null);
  for (const w of llm.warnings) checks.push({ code: "dsh_provider_warning", level: "warn", message: w });
  let keySource = keySourceOf(llm.keyEnv);
  if (!keySource && !llm.route) {
    // dsh's own DeepSeek route also reads <cwd>/.env and $DSH_HOME/.env.
    if (await fileHasKey(path.join(cwd, ".env"), llm.keyEnv)) keySource = path.join(cwd, ".env");
    else if (await fileHasKey(path.join(homesRoot, ".env"), llm.keyEnv)) keySource = path.join(homesRoot, ".env");
  }
  checks.push({
    code: "dsh_provider",
    level: "info",
    message: `Provider ${llm.provider}${llm.route ? ` (${llm.route.baseURL})` : ""}, model ${llm.model} (${llm.reason}).`,
  });
  checks.push(
    keySource
      ? { code: "deepseek_key", level: "info", message: `${llm.keyEnv} found in ${keySource}.` }
      : {
          code: "deepseek_key_missing",
          level: "error",
          message: `${llm.keyEnv} is not configured for provider ${llm.provider}.`,
          hint: `Bind a Paperclip secret as ${llm.keyEnv} in this agent's environment${
            llm.keyEnv.startsWith("DEEPSEEK_") ? `, or put ${llm.keyEnv}=… in ${sharedEnvFile()} (mode 600) for all dsh_local agents` : ""
          }.`,
        },
  );

  // 3b. fallback to DeepSeek's own API when InferX fails
  if (llm.provider === INFERX_PROVIDER || llm.route) {
    const fallback = resolveFallback(config, llm, (name) => keySourceOf(name) !== null);
    const off = /^(none|off)$/i.test(typeof config.fallbackProvider === "string" ? config.fallbackProvider.trim() : "");
    const cooldownSec = readCooldownSec(config.fallbackCooldownSec);
    if (fallback) {
      const window = fallback.officialModels?.find((m) => m.id === fallback.model)?.contextWindow;
      checks.push({
        code: "dsh_fallback",
        level: "info",
        message: `Fallback: ${fallback.provider}, model ${fallback.model}${window ? `, context window ${window}` : ""} when ${llm.provider} fails (capacity, 5xx, auth, connection); cool-down ${Math.round(cooldownSec / 60)} min.`,
      });
      const active = cooldownSec > 0 ? await readCooldown(llm.provider).catch(() => null) : null;
      if (active) {
        checks.push({
          code: "dsh_fallback_cooldown",
          level: "info",
          message: `${llm.provider} is cooling down until ${active.until} after "${active.reason}"; runs use ${fallback.provider} until then.`,
        });
      }
    } else if (!off && !(typeof config.provider === "string" && config.provider.trim() && config.provider.trim() !== "auto")) {
      checks.push({
        code: "dsh_fallback_unavailable",
        level: "warn",
        message: `No fallback: ${DEEPSEEK_KEY_ENV} is not configured, so a failing ${llm.provider} fails the run.`,
        hint: `Put ${DEEPSEEK_KEY_ENV}=… in ${sharedEnvFile()} (mode 600).`,
      });
    }
  }

  // 4. DSH_HOME root writable
  try {
    await fs.mkdir(homesRoot, { recursive: true, mode: 0o700 });
    const probe = path.join(homesRoot, `.write-probe-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    checks.push({ code: "dsh_home_writable", level: "info", message: `DSH_HOME root ${homesRoot} is writable.` });
  } catch (err) {
    checks.push({
      code: "dsh_home_unwritable",
      level: "error",
      message: `DSH_HOME root ${homesRoot} is not writable.`,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  checks.push({
    code: "dsh_model",
    level: "info",
    message: `Model ${llm.model}, permission mode ${settings.permissionMode}, ${settings.mcpServers.length} MCP server(s).`,
  });

  const status = checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass";
  return { adapterType: ADAPTER_TYPE, status, checks, testedAt: new Date().toISOString() };
}
