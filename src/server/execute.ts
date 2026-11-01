/**
 * Runs one Paperclip heartbeat on DeepSeek Harness:
 *
 *   prepare $DSH_HOME (AGENTS.md, skills, patch) → build env + prompt →
 *   dsh --profile headless … --json - (prompt on stdin) → parse NDJSON → result.
 */

import path from "node:path";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE,
  asString,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  ensureAbsoluteDirectory,
  ensurePathInEnv,
  hydrateFreshSessionHandoff,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  refreshPaperclipWorkspaceEnvForExecution,
  renderTemplate,
  resolveCommandForLogs,
  runChildProcess,
  sanitizeInheritedPaperclipEnv,
  selectInitialCommunicationGuidance,
  selectPaperclipPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import { adapterExecutionTargetIsRemote, readAdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { createProviderStoppedBoundary } from "@paperclipai/adapter-utils/provider-stopped-boundary";
import { ADAPTER_TYPE, INFERX_PROVIDER } from "../constants.js";
import { buildDshArgs, buildDshEnv, readDshConfig } from "./config.js";
import { dshPaths, ensureDshHome, readSharedDeepseekEnv, resolveDshHome, sharedEnvFile, syncAgentsMd, writeIfChanged } from "./home.js";
import { buildDshPatch, collectEnvRefs } from "./patch.js";
import { resolveFallback, resolveProvider, type ResolvedProvider } from "./provider.js";
import { classifyProviderFailure, readCooldown, readCooldownSec, writeCooldown } from "./fallback.js";
import { readIssueHandoff } from "./handoff.js";
import { parseSessionParams, sessionResumeBlocker } from "./session.js";
import { BASH_ENV_SCRIPT, planShellForward, readForwardEnv, renderSandboxNote } from "./shell-env.js";
import { linkRuntimeSkills } from "./skills.js";
import {
  hasDshTerminalEvent,
  isAuthError,
  isBalanceError,
  isDshSuccess,
  isRateLimitError,
  isUnknownSessionError,
  parseDshStream,
  toPaperclipUsage,
  type DshStreamSummary,
} from "./stream.js";

/** Paperclip-facing provider/biller ids: "deepseek" for DeepSeek's own API, else the route name. */
function billingProvider(route: string): string {
  return route === "deepseek-official" ? "deepseek" : route;
}
const TERMINAL_EVENT_GRACE_MS = 2_000;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function renderApiAccessNote(env: Record<string, string>): string {
  if (!nonEmpty(env.PAPERCLIP_API_URL) || !nonEmpty(env.PAPERCLIP_API_KEY)) return "";
  return [
    "Paperclip API access:",
    "Call the Paperclip API with curl from your shell tool. Never print or echo $PAPERCLIP_API_KEY.",
    'Read:  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_URL/api/agents/me"',
    'Write: curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" \\',
    "         -H 'Content-Type: application/json' -d '{...}' \"$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments\"",
    "Every write (POST/PATCH/PUT/DELETE) must carry the X-Paperclip-Run-Id header.",
    "When PAPERCLIP_TASK_ID is unset, use a real issue id from the context above, never a placeholder.",
  ].join("\n");
}

export function renderEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env)
    .filter((k) => k.startsWith("PAPERCLIP_"))
    .sort();
  if (keys.length === 0) return "";
  return `Paperclip runtime: these environment variables are set in your shell: ${keys.join(", ")}.`;
}

function describeFailure(summary: DshStreamSummary, stderr: string, exitCode: number | null): string {
  if (summary.errors.length > 0) return summary.errors[summary.errors.length - 1]!;
  if (summary.hasFinal && summary.finalReason && summary.finalReason !== "completed") {
    return `dsh stopped: ${summary.finalReason}`;
  }
  const tail = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" | ");
  if (tail) return `dsh exited ${exitCode ?? "without a code"}: ${tail.slice(0, 500)}`;
  if (!summary.hasFinal) return `dsh exited ${exitCode ?? "without a code"} before its final event`;
  return `dsh exited ${exitCode ?? "without a code"}`;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, context, onLog, onMeta, onSpawn, authToken } = ctx;
  const config = parseObject(ctx.config);
  const settings = readDshConfig(config);
  const note = (line: string) => onLog("stdout", `[paperclip] ${line}\n`);
  const warn = (line: string) => onLog("stderr", `[paperclip] ${line}\n`);

  const target = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const rawKind = (ctx.executionTarget as { kind?: unknown } | null | undefined)?.kind;
  if (adapterExecutionTargetIsRemote(target) || (typeof rawKind === "string" && rawKind !== "local")) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      errorCode: "unsupported_execution_target",
      errorMessage: "dsh_local runs dsh on the Paperclip host only; remote (SSH/sandbox) execution targets are not supported.",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    };
  }

  for (const w of settings.warnings) await warn(w);

  // ── workspace ────────────────────────────────────────────────────────────────
  const workspace = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspace.cwd, "");
  const workspaceSource = asString(workspace.source, "");
  const configuredCwd = asString(config.cwd, "").trim();
  const preferConfigured = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = preferConfigured ? "" : workspaceCwd;
  const cwd = path.resolve(effectiveWorkspaceCwd || configuredCwd || process.cwd());
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  // ── environment ──────────────────────────────────────────────────────────────
  const envConfig = parseObject(config.env);
  const env: Record<string, string> = { ...buildPaperclipEnv(agent), ...buildRuntimeToolsEnv(ctx.runtimeTools) };
  env.PAPERCLIP_RUN_ID = runId;
  const taskId = nonEmpty(context.taskId) ?? nonEmpty(context.issueId);
  const wakeReason = nonEmpty(context.wakeReason);
  const wakeCommentId = nonEmpty(context.wakeCommentId) ?? nonEmpty(context.commentId);
  const approvalId = nonEmpty(context.approvalId);
  const approvalStatus = nonEmpty(context.approvalStatus);
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  const workMode = readPaperclipIssueWorkModeFromContext(context);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (workMode) env.PAPERCLIP_ISSUE_WORK_MODE = workMode;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  refreshPaperclipWorkspaceEnvForExecution({
    env,
    envConfig,
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceId: asString(workspace.workspaceId, ""),
    workspaceRepoUrl: asString(workspace.repoUrl, ""),
    workspaceRepoRef: asString(workspace.repoRef, ""),
    workspaceHints: Array.isArray(context.paperclipWorkspaces)
      ? context.paperclipWorkspaces.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
      : [],
    agentHome: asString(workspace.agentHome, ""),
    executionTargetIsRemote: false,
    executionCwd: cwd,
  });
  if (authToken) env.PAPERCLIP_API_KEY = authToken;

  const dshHome = resolveDshHome(config, agent.id);
  const paths = dshPaths(dshHome);
  env.DSH_HOME = dshHome;
  if (settings.disableTelemetry) env.DSH_TELEMETRY_MODE = "DISABLED";
  Object.assign(env, buildDshEnv({ permissionMode: settings.permissionMode }));

  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...env })).filter(
      (e): e is [string, string] => typeof e[1] === "string",
    ),
  );

  // ── DSH_HOME: AGENTS.md, skills, patch ───────────────────────────────────────
  await ensureDshHome(dshHome);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const agentsMd = await syncAgentsMd(dshHome, instructionsFilePath);
  if (agentsMd.warning) await warn(`Warning: ${agentsMd.warning}`);
  const skills = await linkRuntimeSkills(config, paths.skills, (line) => note(line));

  // Keys: the agent's own env/secret bindings win; the shared host file fills any DEEPSEEK_*
  // variable still unset (Codex agents swapped to dsh_local carry no DeepSeek binding).
  const shared = await readSharedDeepseekEnv();
  if (shared.warning) await warn(`Warning: ${shared.warning}`);
  const fromShared: string[] = [];
  for (const [k, v] of Object.entries(shared.env)) {
    if (!nonEmpty(runtimeEnv[k])) {
      runtimeEnv[k] = v;
      fromShared.push(k);
    }
  }
  if (fromShared.length > 0) await note(`Using ${fromShared.sort().join(", ")} from ${sharedEnvFile()}.`);

  const hasKey = (name: string) => Boolean(nonEmpty(runtimeEnv[name]));
  const fallbackWarnings: string[] = [];
  const cooldownSec = readCooldownSec(config.fallbackCooldownSec, fallbackWarnings);
  for (const w of fallbackWarnings) await warn(w);
  const fallbackOff = /^(none|off)$/i.test(asString(config.fallbackProvider, "").trim());
  const cooldown = cooldownSec > 0 && !fallbackOff ? await readCooldown(INFERX_PROVIDER).catch(() => null) : null;
  let llm: ResolvedProvider = resolveProvider(config, hasKey, { cooldown });
  const announce = async (l: ResolvedProvider) => {
    for (const w of l.warnings) await warn(w);
    await note(`Provider ${l.provider}, model ${l.model} (${l.reason}).`);
    if (!nonEmpty(runtimeEnv[l.keyEnv])) {
      await warn(
        l.route
          ? `${l.keyEnv} is not set in the run environment; requests to ${l.provider} will fail with MISSING_CREDENTIAL.`
          : `${l.keyEnv} is not in the run environment; dsh will look in <cwd>/.env and $DSH_HOME/.env.`,
      );
    }
  };
  const writePatch = (l: ResolvedProvider) =>
    writeIfChanged(
      paths.patch,
      buildDshPatch({
        model: l.model,
        provider: l.provider,
        route: l.route,
        officialModels: l.officialModels ?? null,
        disableTelemetry: settings.disableTelemetry,
        mcpServers: settings.mcpServers,
      }),
    );
  await announce(llm);
  await writePatch(llm);
  for (const name of collectEnvRefs(settings.mcpServers)) {
    if (!nonEmpty(runtimeEnv[name])) await warn(`MCP config references \${${name}} but it is not set in the run environment.`);
  }

  // dsh scrubs credential-shaped names (…KEY/TOKEN/SECRET/PASSWORD) from its shell tool, so
  // PAPERCLIP_API_KEY would never reach the agent's curl calls; forward them via BASH_ENV.
  const forwardWarnings: string[] = [];
  const forward = planShellForward(
    env,
    readForwardEnv(config.forwardEnv, forwardWarnings),
    paths.bashEnv,
    nonEmpty(runtimeEnv.BASH_ENV) ?? undefined,
    { always: settings.permissionMode === "workspace-write" },
  );
  for (const w of [...forwardWarnings, ...forward.warnings]) await warn(w);
  if (Object.keys(forward.vars).length > 0) {
    await writeIfChanged(paths.bashEnv, BASH_ENV_SCRIPT, 0o644);
    Object.assign(runtimeEnv, forward.vars);
  }
  if (forward.names.length > 0) {
    await note(`Forwarding ${forward.names.join(", ")} to the dsh shell tool via BASH_ENV (dsh scrubs credential-shaped names).`);
  }
  if (!authToken) {
    await warn("No Paperclip run token (PAPERCLIP_API_KEY) for this run; API calls from the agent's shell will be unauthenticated.");
  }

  // ── session ──────────────────────────────────────────────────────────────────
  // Only dsh_local's own session params (they carry dshHome) are resumable; a legacy bare
  // sessionId may belong to another adapter, e.g. Codex before a fallback swap.
  const saved = parseSessionParams(parseObject(runtime?.sessionParams));
  const blocker = saved ? sessionResumeBlocker(saved, { cwd, dshHome }) : null;
  if (saved && blocker) await note(`Not resuming dsh session ${saved.sessionId}: ${blocker}.`);
  const resumeId = saved && !blocker ? saved.sessionId : null;

  // ── prompt ───────────────────────────────────────────────────────────────────
  const promptTemplate = asString(
    config.promptTemplate,
    context.conversationMode === true ? DEFAULT_PAPERCLIP_CONVERSATION_PROMPT_TEMPLATE : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  );
  const bootstrapTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const buildPrompt = (resumed: boolean, issueHandoff = "") => {
    const bootstrap = !resumed && bootstrapTemplate.trim() ? renderTemplate(bootstrapTemplate, templateData).trim() : "";
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
      resumedSession: resumed,
      includeCommunicationGuidance: false,
    });
    const heartbeat =
      (resumed && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
    const handoff = joinPromptSections([asString(context.paperclipSessionHandoffMarkdown, "").trim(), resumed ? "" : issueHandoff]);
    const envNote = renderEnvNote(env);
    const apiNote = renderApiAccessNote(env);
    const sandboxNote = renderSandboxNote(settings.permissionMode);
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
      bootstrap,
      wakePrompt,
      taskContextNote,
      handoff,
      envNote,
      apiNote,
      sandboxNote,
      heartbeat,
    ]);
    return {
      prompt,
      metrics: {
        promptChars: prompt.length,
        instructionsChars: agentsMd.chars,
        bootstrapPromptChars: bootstrap.length,
        wakePromptChars: wakePrompt.length,
        taskContextChars: taskContextNote.length,
        sessionHandoffChars: handoff.length,
        runtimeNoteChars: envNote.length + apiNote.length + sandboxNote.length,
        heartbeatPromptChars: heartbeat.length,
      },
    };
  };

  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const resolvedCommand = await resolveCommandForLogs(settings.command, cwd, runtimeEnv).catch(() => settings.command);

  const attempt = async (sessionId: string | null, extraNote = "") => {
    await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(sessionId) });
    const issueHandoff = sessionId ? "" : await readIssueHandoff(context);
    if (issueHandoff) await note(`Fresh session: prepending the Codex handoff file (${issueHandoff.length} chars).`);
    const built = buildPrompt(Boolean(sessionId), issueHandoff);
    const prompt = extraNote ? joinPromptSections([extraNote, built.prompt]) : built.prompt;
    const metrics = { ...built.metrics, promptChars: prompt.length };
    const args = buildDshArgs({
      patchFile: paths.patch,
      sessionId,
      extraArgs: settings.extraArgs,
    });
    if (onMeta) {
      await onMeta({
        adapterType: ADAPTER_TYPE,
        command: resolvedCommand,
        cwd,
        commandArgs: args,
        commandNotes: [
          `Provider ${llm.provider}, model ${llm.model} via ${paths.patch}; task on stdin (${prompt.length} chars).`,
          `DSH_HOME ${dshHome}${settings.disableTelemetry ? "; session-log upload disabled" : ""}; permission mode ${settings.permissionMode}, approvals rejected.`,
          agentsMd.chars > 0 ? `Agent instructions synced to ${paths.agentsMd} from ${instructionsFilePath}.` : "",
          skills.length > 0 ? `${skills.length} Paperclip skill(s) linked into ${paths.skills}.` : "",
          settings.mcpServers.length > 0 ? `MCP servers: ${settings.mcpServers.map((s) => s.name).join(", ")}.` : "",
          sessionId ? `Resuming dsh session ${sessionId}.` : "Starting a fresh dsh session.",
        ].filter(Boolean),
        env: buildInvocationEnvForLogs(env, {
          runtimeEnv,
          includeRuntimeKeys: ["DSH_HOME", "DSH_TELEMETRY_MODE", "DSH_PERMISSION_MODE"],
          resolvedCommand,
        }),
        prompt,
        promptMetrics: metrics,
        context,
      });
    }
    const stopped = providerStop.beginInvocation();
    const proc = await runChildProcess(runId, settings.command, args, {
      cwd,
      env: runtimeEnv,
      timeoutSec: settings.timeoutSec,
      graceSec: settings.graceSec,
      onLog,
      onSpawn,
      stdin: prompt,
      terminalResultCleanup: {
        graceMs: TERMINAL_EVENT_GRACE_MS,
        hasTerminalResult: ({ stdout }) => hasDshTerminalEvent(stdout),
      },
    });
    stopped();
    return { proc, summary: parseDshStream(proc.stdout) };
  };

  try {
    let run = await attempt(resumeId);
    let retriedFresh = false;
    if (resumeId && !run.proc.timedOut && isUnknownSessionError(run.proc.stdout, run.proc.stderr, run.summary)) {
      await warn(`dsh session ${resumeId} is no longer available; retrying with a fresh session.`);
      retriedFresh = true;
      run = await attempt(null);
    }

    // InferX failed for provider reasons (capacity after retries, 5xx, auth, connection):
    // run this heartbeat once more on DeepSeek's own API and cool InferX down for later runs.
    let fallbackInfo: Record<string, unknown> | null = null;
    const fallback = resolveFallback(config, llm, hasKey);
    const firstReason = fallback
      ? classifyProviderFailure({
          success: !run.proc.timedOut && isDshSuccess(run.proc.exitCode, run.summary),
          timedOut: run.proc.timedOut,
          summary: run.summary,
          stderr: run.proc.stderr,
        })
      : null;
    if (fallback && firstReason) {
      const failed = run;
      const from = llm;
      const label = from.provider === INFERX_PROVIDER ? "InferX" : from.provider;
      await onLog("stdout", `[dsh] ${label} failed (${firstReason}); falling back to ${fallback.provider}\n`);
      const cooled = cooldownSec > 0 ? await writeCooldown(from.provider, firstReason, cooldownSec).catch(() => null) : null;
      if (cooled) await note(`${label} cool-down until ${cooled.until}: runs on this host use ${fallback.provider} until then.`);
      llm = fallback;
      await announce(llm);
      await writePatch(llm);
      // dsh sessions are provider-independent: resume the failed one so finished steps are not
      // repeated; start fresh (same handoff) when it never got a session.
      const failedSession = failed.summary.sessionId ?? (retriedFresh ? null : resumeId);
      const continueNote = [
        `Note: the previous model provider (${label}) failed during this heartbeat (${firstReason}).`,
        `You are now on ${fallback.provider}. Continue the task from where it stopped; check what is already`,
        "done (issue comments, workspace) before repeating any action.",
      ].join(" ");
      let resumedFailed = false;
      if (failedSession) {
        run = await attempt(failedSession, continueNote);
        resumedFailed = true;
        if (!run.proc.timedOut && isUnknownSessionError(run.proc.stdout, run.proc.stderr, run.summary)) {
          await warn(`dsh session ${failedSession} could not be resumed on ${fallback.provider}; starting fresh.`);
          run = await attempt(null);
          resumedFailed = false;
          retriedFresh = true;
        } else retriedFresh = false;
      } else {
        run = await attempt(null);
        retriedFresh = true;
      }
      fallbackInfo = {
        from: from.provider,
        to: fallback.provider,
        reason: firstReason,
        resumedSession: resumedFailed ? failedSession : null,
        failedRun: {
          steps: failed.summary.steps,
          toolCalls: failed.summary.toolCalls,
          usage: toPaperclipUsage(failed.summary.usage),
        },
        cooldownUntil: cooled?.until ?? null,
      };
    }

    const { proc, summary } = run;
    const sessionId = summary.sessionId ?? (retriedFresh ? null : resumeId);
    const sessionParams = sessionId ? { sessionId, cwd, dshHome, model: llm.model } : null;
    const success = !proc.timedOut && isDshSuccess(proc.exitCode, summary);
    const failureText = [...summary.errors, proc.stderr].join("\n");
    const errorCode = proc.timedOut
      ? "timeout"
      : success
        ? null
        : isAuthError(failureText)
          ? "authentication_required"
          : isRateLimitError(failureText)
            ? "rate_limited"
            : isBalanceError(failureText)
              ? "insufficient_balance"
              : "dsh_failed";

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: proc.timedOut,
      errorMessage: success
        ? null
        : proc.timedOut
          ? `Timed out after ${settings.timeoutSec}s`
          : describeFailure(summary, proc.stderr, proc.exitCode),
      errorCode,
      usage: toPaperclipUsage(summary.usage),
      usageBasis: "per_run",
      provider: billingProvider(llm.provider),
      biller: billingProvider(llm.provider),
      billingType: "api",
      model: llm.model,
      sessionId,
      sessionParams,
      sessionDisplayId: sessionId,
      clearSession: retriedFresh && !sessionId,
      summary: summary.text || undefined,
      resultJson: {
        finalReason: summary.finalReason,
        steps: summary.steps,
        toolCalls: summary.toolCalls,
        toolErrors: summary.toolErrors,
        reasoningTokens: summary.usage.reasoningTokens,
        cacheWriteTokens: summary.usage.cacheWriteTokens,
        ...(summary.errors.length > 0 ? { errors: summary.errors } : {}),
        ...(fallbackInfo ? { fallback: fallbackInfo } : {}),
      },
    };
  } finally {
    await providerStop.collectBeforeRestore();
  }
}
