import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import {
  DEFAULT_DSH_COMMAND,
  DEFAULT_DSH_MODEL,
  DEFAULT_GRACE_SEC,
  DSH_MODELS,
  INFERX_BASE_URL,
  INFERX_KEY_ENV,
} from "../constants.js";

/**
 * Declarative form for the Paperclip agent editor.
 *
 * `env` is deliberately not a field here: Paperclip's own environment editor owns it,
 * including secret bindings such as DEEPSEEK_API_KEY. A plain textarea would flatten
 * those bindings into a string on save.
 */
export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "model",
        label: "Model",
        type: "combobox",
        default: DEFAULT_DSH_MODEL,
        options: DSH_MODELS.map((m) => ({ value: m.id, label: m.label })),
        hint: "Model id. Aliases: flash, pro. On InferX, deepseek-flash/flash mean deepseek-v4.1-flash-1017-basic.",
        group: "Model",
      },
      {
        key: "provider",
        label: "Provider",
        type: "combobox",
        default: "auto",
        options: [
          { value: "auto", label: `Auto (InferX when ${INFERX_KEY_ENV} is set, else DeepSeek)` },
          { value: "inferx", label: "InferX (OpenAI-compatible DeepSeek endpoint)" },
          { value: "deepseek-official", label: "DeepSeek API (DEEPSEEK_API_KEY)" },
        ],
        hint: "Or type a lowercase name for your own OpenAI-compatible route; it then needs base URL, key variable and model.",
        group: "Model",
      },
      {
        key: "baseUrl",
        label: "Provider base URL",
        type: "text",
        hint: `OpenAI-compatible endpoint. InferX default: ${INFERX_BASE_URL}. Not used for deepseek-official.`,
        group: "Model",
      },
      {
        key: "apiKeyEnv",
        label: "API key variable",
        type: "text",
        hint: `Name of the env var holding the key (never the key itself). InferX default: ${INFERX_KEY_ENV}.`,
        group: "Model",
      },
      {
        key: "permissionMode",
        label: "Permission mode",
        type: "select",
        default: "workspace-write",
        options: [
          { value: "workspace-write", label: "Workspace write (edit files in the workspace)" },
          { value: "read-only", label: "Read only" },
          { value: "danger-full-access", label: "Full access (no file sandbox)" },
        ],
        hint: "Set as DSH_PERMISSION_MODE for dsh's file sandbox. Approval requests are always rejected (no one is there to approve). Network is not sandboxed.",
        group: "Permissions",
      },
      {
        key: "addDirs",
        label: "Extra writable directories",
        type: "textarea",
        hint: "Not supported by dsh 0.2.x (one writable root per session); listed paths only produce a warning. Use Full access if the agent must write outside the workspace.",
        group: "Permissions",
      },
      {
        key: "forwardEnv",
        label: "Credentials for the shell tool",
        type: "textarea",
        hint: "dsh strips env vars named like *KEY*/*TOKEN*/*SECRET*/*PASSWORD* from its shell tool. The run's PAPERCLIP_API_KEY and PAPERCLIP_RUNTIME_TOOLS_TOKEN are always passed through; list other names (one per line, e.g. GH_TOKEN) to pass them too. DEEPSEEK_* keys are never passed.",
        group: "Permissions",
      },
      {
        key: "mcpServers",
        label: "MCP servers (JSON)",
        type: "textarea",
        hint:
          'Object of name → {transport: "streamable-http"|"stdio", url, headers, command, args, env}. ' +
          'Write secrets as ${ENV_NAME}; they are read from the run environment, never stored in the patch file.',
        group: "Tools",
      },
      {
        key: "disableTelemetry",
        label: "Keep sessions local (no DeepSeek session-log upload)",
        type: "toggle",
        default: true,
        hint: "Disables dsh's session-log-deepseek plugin and sets DSH_TELEMETRY_MODE=DISABLED.",
        group: "Privacy",
      },
      {
        key: "command",
        label: "dsh command",
        type: "text",
        default: DEFAULT_DSH_COMMAND,
        hint: "Executable name or absolute path, e.g. /home/paperclip/.local/bin/dsh. A non-dsh command (e.g. a Codex launcher) is ignored in favour of dsh.",
        group: "Runtime",
      },
      {
        key: "dshHome",
        label: "DSH_HOME",
        type: "text",
        hint: "Defaults to ~/.paperclip-dsh/agents/{agentId}. Holds sessions, AGENTS.md, skills and the generated patch.",
        group: "Runtime",
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 0,
        hint: "0 waits until dsh finishes.",
        group: "Runtime",
      },
      {
        key: "graceSec",
        label: "Grace period (seconds)",
        type: "number",
        default: DEFAULT_GRACE_SEC,
        hint: "Time between SIGTERM and SIGKILL on timeout or cancel.",
        group: "Runtime",
      },
      {
        key: "dshExtraArgs",
        label: "Extra dsh arguments",
        type: "textarea",
        hint: "One argument per line, appended before the stdin marker. (Separate from Codex's extraArgs, which dsh ignores.)",
        group: "Runtime",
      },
    ],
  };
}
