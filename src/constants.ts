/**
 * Adapter identity, model catalog and defaults for the DeepSeek Harness adapter.
 */

export const ADAPTER_TYPE = "dsh_local";
export const ADAPTER_LABEL = "DeepSeek Harness (local)";

/** Default `dsh` executable. Resolved through PATH unless configured. */
export const DEFAULT_DSH_COMMAND = "dsh";

/** dsh profile used for one-shot runs. Built on dsh-base (tools, skills, AGENTS.md, sessions). */
export const DSH_PROFILE = "headless";

/** DeepSeek's own provider id inside dsh, and the env var its key lives in. */
export const DEEPSEEK_PROVIDER = "deepseek-official";
export const DEEPSEEK_KEY_ENV = "DEEPSEEK_API_KEY";

/** InferX: an OpenAI-compatible DeepSeek endpoint, mounted as an llm-pi-ai route. */
export const INFERX_PROVIDER = "inferx";
export const INFERX_BASE_URL = "https://model.inferx.net/endpoints/v1";
export const INFERX_KEY_ENV = "DEEPSEEK_INFERX_API_KEY";
export const INFERX_DEFAULT_MODEL = "deepseek-v4.1-flash-1017-basic";
/** InferX serves that model with a 262,144-token window (dsh assumes 1,048,576 for deepseek-flash). */
export const INFERX_CONTEXT_WINDOW = 262_144;
/**
 * Smallest output cap the adapter writes for a route. DeepSeek Flash spends output tokens on
 * reasoning before answering, so a small cap truncates replies. Unset = dsh's default (32,768).
 */
export const MIN_MAX_TOKENS = 8_192;

/** Values accepted by the `provider` config key (any other lowercase name is a custom route). */
export const PROVIDER_CHOICES = ["auto", INFERX_PROVIDER, DEEPSEEK_PROVIDER] as const;

/** dsh's own default model. */
export const DEFAULT_DSH_MODEL = "deepseek-flash";

/** Minimum Node.js version dsh runs on. */
export const DSH_MIN_NODE_VERSION = "24.9.0";

/** Models shipped in dsh's DeepSeek catalog (packages/llm/llm-deepseek/src/models.ts). */
export const DSH_MODELS = [
  { id: "deepseek-flash", label: "DeepSeek V4.1 Flash (fast, low cost)" },
  { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro (complex, quality-critical work)" },
  { id: "deepseek-v4.1-flash-1017-basic", label: "DeepSeek V4.1 Flash on InferX (provider inferx)" },
];

/** Shorthands and older catalog names that dsh releases have used for the same models. */
export const MODEL_ALIASES: Record<string, string> = {
  flash: "deepseek-flash",
  pro: "deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek-flash",
};

/** dsh's sandbox modes (`DSH_PERMISSION_MODE`, read by the headless profile's sandbox-policy row). */
export const PERMISSION_MODES = ["workspace-write", "read-only", "danger-full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];
export const DEFAULT_PERMISSION_MODE: PermissionMode = "workspace-write";

/** Root for per-agent dsh homes when no `dshHome` is configured: `~/.paperclip-dsh/agents/<agentId>`. */
export const DEFAULT_DSH_HOMES_DIRNAME = ".paperclip-dsh";

/** File names the adapter manages inside each agent's DSH_HOME. */
export const PATCH_FILENAME = "paperclip.patch.yml";
export const AGENTS_MD_FILENAME = "AGENTS.md";
export const SKILLS_DIRNAME = "skills";

/** Marker written at the top of files the adapter owns, so it never deletes a user's own file. */
export const MANAGED_MARKER = "managed by paperclip-adapter-dsh";

export const DEFAULT_GRACE_SEC = 15;
export const DEFAULT_TIMEOUT_SEC = 0;

/**
 * Resolves the configured model to a DeepSeek model id. Anything that is not a DeepSeek
 * model (e.g. a Codex model left in adapterConfig after a fallback swap) maps to the default.
 */
export function resolveDshModel(model: unknown): string {
  const raw = typeof model === "string" ? model.trim() : "";
  if (!raw || raw === "inherit" || raw === "default") return DEFAULT_DSH_MODEL;
  const resolved = MODEL_ALIASES[raw] ?? raw;
  return /^deepseek[-_]/i.test(resolved) ? resolved : DEFAULT_DSH_MODEL;
}

/** True when the configured model was replaced by the default (not a DeepSeek model). */
export function isForeignModel(model: unknown): boolean {
  const raw = typeof model === "string" ? model.trim() : "";
  if (!raw || raw === "inherit" || raw === "default") return false;
  return !/^deepseek[-_]/i.test(MODEL_ALIASES[raw] ?? raw);
}

/**
 * True when `command` plausibly launches dsh: its file name is `dsh` or contains a `dsh`
 * word (`dsh`, `/home/u/.local/bin/dsh`, `dsh.cmd`, `my-dsh-wrapper`). The old process-adapter
 * bridge `dsh-paperclip` speaks a different protocol and is rejected.
 */
export function looksLikeDshCommand(command: string): boolean {
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  if (!base || /^dsh-paperclip(\.|$)/i.test(base)) return false;
  return /(^|[-_.])dsh([-_.]|$)/i.test(base);
}

export function resolvePermissionMode(value: unknown): PermissionMode {
  const raw = typeof value === "string" ? value.trim() : "";
  return (PERMISSION_MODES as readonly string[]).includes(raw) ? (raw as PermissionMode) : DEFAULT_PERMISSION_MODE;
}

/** True when a non-empty `permissionMode` was not one of dsh's modes and fell back to the default. */
export function isUnknownPermissionMode(value: unknown): boolean {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 && !(PERMISSION_MODES as readonly string[]).includes(raw);
}
