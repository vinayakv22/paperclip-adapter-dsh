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
import { ADAPTER_TYPE } from "../constants.js";
import { buildDshArgs, buildDshEnv, readDshConfig } from "./config.js";
import { dshPaths, ensureDshHome, readSharedDeepseekEnv, resolveDshHome, sharedEnvFile, syncAgentsMd, writeIfChanged } from "./home.js";
import { buildDshPatch, collectEnvRefs } from "./patch.js";
import { parseSessionParams, sessionResumeBlocker } from "./session.js";
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

const PROVIDER = "deepseek";
const BILLER = "deepseek";
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
  await writeIfChanged(
    paths.patch,
    buildDshPatch({ model: settings.model, disableTelemetry: settings.disableTelemetry, mcpServers: settings.mcpServers }),
  );
  for (const name of collectEnvRefs(settings.mcpServers)) {
    if (!nonEmpty(runtimeEnv[name])) await warn(`MCP config references \${${name}} but it is not set in the run environment.`);
  }
  if (!nonEmpty(runtimeEnv.DEEPSEEK_API_KEY)) {
    // Codex agents swapped to dsh_local carry no DeepSeek binding: use the shared key file.
    const shared = await readSharedDeepseekEnv();
    if (shared.warning) await warn(`Warning: ${shared.warning}`);
    for (const [k, v] of Object.entries(shared.env)) if (!nonEmpty(runtimeEnv[k])) runtimeEnv[k] = v;
    if (nonEmpty(runtimeEnv.DEEPSEEK_API_KEY)) await note(`Using DEEPSEEK_API_KEY from ${sharedEnvFile()}.`);
    else await note("DEEPSEEK_API_KEY is not in the run environment; dsh will look in <cwd>/.env and $DSH_HOME/.env.");
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

  const buildPrompt = (resumed: boolean) => {
    const bootstrap = !resumed && bootstrapTemplate.trim() ? renderTemplate(bootstrapTemplate, templateData).trim() : "";
    const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(context, {
      resumedSession: resumed,
      includeCommunicationGuidance: false,
    });
    const heartbeat =
      (resumed && wakePrompt.length > 0) || isPaperclipRecoveryWakePayload(context.paperclipWake)
        ? ""
        : renderTemplate(promptTemplate, templateData);
    const handoff = asString(context.paperclipSessionHandoffMarkdown, "").trim();
    const envNote = renderEnvNote(env);
    const apiNote = renderApiAccessNote(env);
    const prompt = joinPromptSections([
      selectInitialCommunicationGuidance(context, { resumedSession: resumed }),
      bootstrap,
      wakePrompt,
      taskContextNote,
      handoff,
      envNote,
      apiNote,
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
        runtimeNoteChars: envNote.length + apiNote.length,
        heartbeatPromptChars: heartbeat.length,
      },
    };
  };

  const providerStop = createProviderStoppedBoundary(ctx.onProviderStopped);
  const resolvedCommand = await resolveCommandForLogs(settings.command, cwd, runtimeEnv).catch(() => settings.command);

  const attempt = async (sessionId: string | null) => {
    await hydrateFreshSessionHandoff(ctx, { resumedSession: Boolean(sessionId) });
    const { prompt, metrics } = buildPrompt(Boolean(sessionId));
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
          `Model ${settings.model} via ${paths.patch}; task on stdin (${prompt.length} chars).`,
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

    const { proc, summary } = run;
    const sessionId = summary.sessionId ?? (retriedFresh ? null : resumeId);
    const sessionParams = sessionId ? { sessionId, cwd, dshHome, model: settings.model } : null;
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
      provider: PROVIDER,
      biller: BILLER,
      billingType: "api",
      model: settings.model,
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
      },
    };
  } finally {
    await providerStop.collectBeforeRestore();
  }
}
