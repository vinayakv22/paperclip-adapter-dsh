/**
 * Model provider selection.
 *
 * dsh ships the direct DeepSeek route (`deepseek-official`, key `DEEPSEEK_API_KEY`). Other
 * OpenAI-compatible endpoints are added as routes of the `llm-pi-ai` plugin
 * (`@deepseek-ai/dsh-llm-pi-ai`) through the patch file, and `agent-default-model` points
 * the agent at one of them.
 *
 *   provider: "auto" (default)    InferX when DEEPSEEK_INFERX_API_KEY is set and the model is
 *                                 a Flash model, otherwise deepseek-official
 *   provider: "deepseek-official" DeepSeek's own API
 *   provider: "inferx"            InferX's OpenAI-compatible DeepSeek endpoint
 *   provider: "<name>"            any OpenAI-compatible endpoint: needs baseUrl, apiKeyEnv, model
 */

import {
  DEEPSEEK_KEY_ENV,
  DEEPSEEK_PROVIDER,
  INFERX_BASE_URL,
  INFERX_CONTEXT_WINDOW,
  INFERX_DEFAULT_MODEL,
  INFERX_KEY_ENV,
  INFERX_PROVIDER,
  MIN_MAX_TOKENS,
  isForeignModel,
  resolveDshModel,
} from "../constants.js";

export type ProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
const PROVIDER_APIS: readonly ProviderApi[] = ["openai-completions", "openai-responses", "anthropic-messages"];

export interface ProviderModelSpec {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** One `llm-pi-ai` route, rendered into the patch file. */
export interface ProviderRoute {
  name: string;
  displayName: string;
  api: ProviderApi;
  baseURL: string;
  apiKeyEnv: string;
  models: ProviderModelSpec[];
  compat: Record<string, string | number | boolean>;
}

export interface ResolvedProvider {
  /** Route name dsh dispatches to (`agent-default-model.provider`). */
  provider: string;
  model: string;
  /** Env var that must hold the API key for this route. */
  keyEnv: string;
  /** Extra pi-ai route to mount, or null for the built-in deepseek-official route. */
  route: ProviderRoute | null;
  /** How the provider was chosen, for logs and the environment test. */
  reason: string;
  warnings: string[];
}

const ROUTE_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Official ids and aliases that mean "DeepSeek Flash"; on InferX they map to its Flash model. */
const FLASH_IDS = new Set(["", "inherit", "default", "flash", "deepseek-flash", "deepseek-v4-flash"]);

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

function readCompat(value: unknown, warnings: string[]): Record<string, string | number | boolean> | null {
  let raw = value;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      raw = JSON.parse(raw);
    } catch {
      warnings.push("providerCompat is not valid JSON; ignored.");
      return null;
    }
  }
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("providerCompat must be an object; ignored.");
    return null;
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else warnings.push(`providerCompat.${k} must be a string, number or boolean; ignored.`);
  }
  return out;
}

function modelSpec(
  id: string,
  config: Record<string, unknown>,
  warnings: string[],
  defaults: { name?: string; contextWindow?: number } = {},
): ProviderModelSpec {
  const spec: ProviderModelSpec = { id };
  if (defaults.name) spec.name = defaults.name;
  // The window drives dsh's compaction threshold, so it must not exceed what the endpoint serves.
  const contextWindow = positiveInt(config.contextWindow) ?? defaults.contextWindow;
  if (contextWindow) spec.contextWindow = contextWindow;
  const maxTokens = positiveInt(config.maxTokens);
  if (maxTokens !== undefined && maxTokens < MIN_MAX_TOKENS) {
    warnings.push(
      `maxTokens ${maxTokens} is too small for a reasoning model (reasoning is spent before the answer); using ${MIN_MAX_TOKENS}.`,
    );
    spec.maxTokens = MIN_MAX_TOKENS;
  } else if (maxTokens !== undefined) {
    spec.maxTokens = maxTokens;
  }
  return spec;
}

function official(config: Record<string, unknown>, reason: string, warnings: string[]): ResolvedProvider {
  if (str(config.model) === INFERX_DEFAULT_MODEL) {
    warnings.push(`Model ${INFERX_DEFAULT_MODEL} is served by InferX only; using deepseek-flash on ${DEEPSEEK_PROVIDER}.`);
    return { provider: DEEPSEEK_PROVIDER, model: "deepseek-flash", keyEnv: DEEPSEEK_KEY_ENV, route: null, reason, warnings };
  }
  if (isForeignModel(config.model)) {
    warnings.push(`Model "${String(config.model)}" is not a DeepSeek model; using ${resolveDshModel(config.model)}.`);
  }
  return { provider: DEEPSEEK_PROVIDER, model: resolveDshModel(config.model), keyEnv: DEEPSEEK_KEY_ENV, route: null, reason, warnings };
}

function inferx(config: Record<string, unknown>, reason: string, warnings: string[]): ResolvedProvider {
  const configured = str(config.model);
  let model = configured;
  if (FLASH_IDS.has(configured)) model = INFERX_DEFAULT_MODEL;
  else if (isForeignModel(configured) && !/deepseek/i.test(configured)) {
    warnings.push(`Model "${configured}" is not a DeepSeek model; using ${INFERX_DEFAULT_MODEL}.`);
    model = INFERX_DEFAULT_MODEL;
  }
  const keyEnv = str(config.apiKeyEnv) || INFERX_KEY_ENV;
  const route: ProviderRoute = {
    name: INFERX_PROVIDER,
    displayName: "InferX (DeepSeek)",
    api: "openai-completions",
    baseURL: str(config.baseUrl) || INFERX_BASE_URL,
    apiKeyEnv: keyEnv,
    models: [
      modelSpec(
        model,
        config,
        warnings,
        model === INFERX_DEFAULT_MODEL ? { name: "DeepSeek V4.1 Flash (InferX)", contextWindow: INFERX_CONTEXT_WINDOW } : {},
      ),
    ],
    compat: readCompat(config.providerCompat, warnings) ?? {},
  };
  return { provider: INFERX_PROVIDER, model, keyEnv, route, reason, warnings };
}

/**
 * Picks the provider route and model for a run.
 *
 * @param hasKey reports whether an env var holds a non-empty value in the run environment
 *               (only used for `provider: "auto"`).
 */
export function resolveProvider(config: Record<string, unknown>, hasKey: (name: string) => boolean): ResolvedProvider {
  const warnings: string[] = [];
  const requested = str(config.provider).toLowerCase();

  if (!requested || requested === "auto") {
    const model = str(config.model);
    const flashLike = FLASH_IDS.has(model) || model === INFERX_DEFAULT_MODEL || isForeignModel(model);
    if (hasKey(INFERX_KEY_ENV) && flashLike) return inferx(config, `auto: ${INFERX_KEY_ENV} is set`, warnings);
    const why = !hasKey(INFERX_KEY_ENV)
      ? `auto: ${INFERX_KEY_ENV} is not set`
      : `auto: model "${model}" is not a Flash model InferX serves`;
    return official(config, why, warnings);
  }
  if (requested === DEEPSEEK_PROVIDER || requested === "deepseek") return official(config, "configured", warnings);
  if (requested === INFERX_PROVIDER) return inferx(config, "configured", warnings);

  // Custom OpenAI-compatible route.
  const baseURL = str(config.baseUrl);
  const apiKeyEnv = str(config.apiKeyEnv);
  const model = str(config.model);
  const missing: string[] = [];
  if (!ROUTE_NAME_RE.test(requested)) missing.push(`a provider name matching ${ROUTE_NAME_RE}`);
  if (!/^https?:\/\//i.test(baseURL)) missing.push("baseUrl (http/https)");
  if (!ENV_NAME_RE.test(apiKeyEnv)) missing.push("apiKeyEnv (an env var name)");
  if (!model || model === "inherit" || model === "default") missing.push("model");
  if (missing.length > 0) {
    warnings.push(`Custom provider "${requested}" needs ${missing.join(", ")}; using ${DEEPSEEK_PROVIDER}.`);
    return official(config, "fallback: incomplete custom provider", warnings);
  }
  const apiRaw = str(config.providerApi) || "openai-completions";
  let api: ProviderApi = "openai-completions";
  if ((PROVIDER_APIS as readonly string[]).includes(apiRaw)) api = apiRaw as ProviderApi;
  else warnings.push(`providerApi "${apiRaw}" is not one of ${PROVIDER_APIS.join(", ")}; using openai-completions.`);
  const route: ProviderRoute = {
    name: requested,
    displayName: str(config.providerName) || requested,
    api,
    baseURL,
    apiKeyEnv,
    models: [modelSpec(model, config, warnings)],
    compat: readCompat(config.providerCompat, warnings) ?? {},
  };
  return { provider: requested, model, keyEnv: apiKeyEnv, route, reason: "configured", warnings };
}
