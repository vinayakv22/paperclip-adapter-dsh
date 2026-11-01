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
- You pay DeepSeek per token with your own API key.

Required:
- env.DEEPSEEK_API_KEY: bind a Paperclip secret. Never put the key in other fields.

Core fields:
- model (string): deepseek-flash (default) | deepseek-v4-pro. Aliases: flash, pro.
- permissionMode (string): workspace-write (default) | read-only | auto. Approval policy is always "never".
- addDirs (string[] or one path per line): extra writable directories, each passed as --add-dir.
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
- Runs: dsh --profile headless --patch $DSH_HOME/paperclip.patch.yml --json --permission-mode <m> --approval-policy never [--add-dir …] [--session-id …] -
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
