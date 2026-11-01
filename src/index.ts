/**
 * paperclip-adapter-dsh — run Paperclip agents on DeepSeek Harness (dsh).
 *
 * Paperclip's plugin loader imports this module and calls createServerAdapter().
 */

import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { ADAPTER_LABEL, ADAPTER_TYPE, DSH_MODELS } from "./constants.js";
import {
  execute,
  getConfigSchema,
  listDshSkills,
  sessionCodec,
  syncDshSkills,
  testEnvironment,
} from "./server/index.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;
export const models = DSH_MODELS;

export const agentConfigurationDoc = `# dsh_local agent configuration

Adapter: dsh_local — runs the agent on DeepSeek Harness (\`dsh\`) with the DeepSeek API.

Use when:
- You want a Paperclip agent driven by DeepSeek models through dsh's tools (shell, files, web, skills, subagents).
- You use DeepSeek's own API, the InferX OpenAI-compatible DeepSeek endpoint, or another OpenAI-compatible gateway.

Required:
- An API key for the chosen provider, as an env binding or in ~/.paperclip-dsh/.env (mode 600, DEEPSEEK_* lines only):
  DEEPSEEK_INFERX_API_KEY for InferX, DEEPSEEK_API_KEY for deepseek-official, apiKeyEnv for a custom route.
  Never put a key in other fields.

Provider fields:
- provider (string): auto (default) | inferx | deepseek-official | <custom route name>.
  auto = inferx when DEEPSEEK_INFERX_API_KEY is set and the model is a Flash model, else deepseek-official.
- baseUrl (string): OpenAI-compatible base URL (inferx default https://model.inferx.net/endpoints/v1; required for custom).
- apiKeyEnv (string): env var holding the key (inferx default DEEPSEEK_INFERX_API_KEY; required for custom).
- providerApi (string): openai-completions (default) | openai-responses | anthropic-messages (custom routes).
- providerCompat (JSON object): dsh pi-ai compat switches, e.g. {"thinkingFormat":"deepseek"}.
- contextWindow / maxTokens (number): model capacity hints for the route.

Core fields:
- model (string): deepseek-flash (default) | deepseek-v4-pro | deepseek-v4.1-flash-1017-basic (InferX). Aliases: flash, pro.
  On inferx, deepseek-flash / flash map to deepseek-v4.1-flash-1017-basic.
- permissionMode (string): workspace-write (default) | read-only | danger-full-access, set as DSH_PERMISSION_MODE. Approval requests are always rejected.
- addDirs (string[] or one path per line): not supported by dsh 0.2.x (one writable root per session); listed paths only produce a warning.
- mcpServers (JSON object): name -> { transport: "streamable-http" | "stdio", url, headers, command, args, env }.
  Use \${ENV_NAME} for secrets; they are resolved from the run environment at load time.
- instructionsFilePath (string): agent instructions; copied to $DSH_HOME/AGENTS.md every run.
- promptTemplate / bootstrapPromptTemplate (string): optional overrides of the heartbeat prompt.
- cwd (string): fallback working directory when Paperclip provides no workspace.

Runtime fields:
- command (string): dsh executable, default "dsh".
- dshHome (string): per-agent home, default ~/.paperclip-dsh/agents/{agentId}.
- disableTelemetry (boolean, default true): disables DeepSeek session-log upload.
- timeoutSec (number, default 0 = none), graceSec (number, default 15).
- dshExtraArgs (string[]): extra dsh arguments. Codex's \`extraArgs\` is ignored on purpose.

Codex fallback:
- A Codex agent can switch to dsh_local by changing only adapterType and model. instructionsFilePath,
  cwd, env, timeoutSec, graceSec and promptTemplate carry over; Codex-only keys (modelReasoningEffort,
  engine, extraArgs, a codex/codex-lb command) are ignored; a non-DeepSeek model becomes deepseek-flash.

Notes:
- Runs: DSH_PERMISSION_MODE=<m> dsh --profile headless --patch $DSH_HOME/paperclip.patch.yml --json [--session-id …] -
- The task prompt goes on stdin. Sessions resume with --session-id when cwd and DSH_HOME match; a vanished session retries fresh.
- Usage is reported per run: input = fresh + cache-read + cache-write tokens, cached = cache-read tokens.
`;

export function createServerAdapter(): ServerAdapterModule {
  return {
    type: ADAPTER_TYPE,
    execute,
    testEnvironment,
    models: DSH_MODELS,
    sessionCodec,
    listSkills: listDshSkills,
    syncSkills: syncDshSkills,
    getConfigSchema,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
  };
}

export default createServerAdapter;

export * from "./constants.js";
