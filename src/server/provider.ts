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
/** dsh-llm retry policy for one route (dsh-llm `RetryPolicySchema`). */
export interface RetryPolicy {
  mode: "normal" | "always";
  maxRetries?: number;
  retryableCodes?: string[];
  backoff?: { initialDelayMs?: number; maxDelayMs?: number; jitterRatio?: number };
}

/**
 * InferX's free endpoint answers 429 "all replicas at capacity" for a minute or so at a time.
 * dsh's default (5 retries, 0.5 s doubling to 10 s, about 15 s in total) gives up inside one
 * such window and fails the whole run; this rides out roughly 4.5 minutes.
 */
export const INFERX_RETRY_POLICY: RetryPolicy = {
  mode: "normal",
  maxRetries: 12,
  backoff: { initialDelayMs: 2_000, maxDelayMs: 30_000 },
};
const MAX_DELAY_MS = 600_000;

export interface ProviderRoute {
  name: string;
  displayName: string;
  api: ProviderApi;
  baseURL: string;
  apiKeyEnv: string;
  models: ProviderModelSpec[];
  compat: Record<string, string | number | boolean>;
  /** null: dsh's default retry policy. */
  retryPolicy: RetryPolicy | null;
}

/** One `llm-deepseek` catalog entry (dsh-llm-deepseek `models`); replaces dsh's built-in catalog. */
export interface OfficialModelSpec {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens?: number;
  inputModalities?: string[];
  systemPromptUpdate?: "in-history";
  toolUpdate?: "in-history" | "addition-only";
}

/** dsh's built-in official catalog (dsh 0.2.1), which the adapter overrides per model. */
const OFFICIAL_CONTEXT_WINDOW = 1_048_576;
const OFFICIAL_CATALOG: OfficialModelSpec[] = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    contextWindow: OFFICIAL_CONTEXT_WINDOW,
    inputModalities: ["text", "image"],
    systemPromptUpdate: "in-history",
    toolUpdate: "addition-only",
  },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: OFFICIAL_CONTEXT_WINDOW },
];

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
  /** deepseek-official only: catalog override (explicit context windows), or null for dsh's own. */
  officialModels?: OfficialModelSpec[] | null;
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

/**
 * Reads `providerRetry`: an object or JSON string with dsh's retry policy fields, or "default"
 * for dsh's built-in policy. Absent: `fallback`.
 */
export function readRetryPolicy(value: unknown, warnings: string[], fallback: RetryPolicy | null): RetryPolicy | null {
  let raw = value;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return fallback;
    if (t === "default" || t === "dsh") return null;
    try {
      raw = JSON.parse(t);
    } catch {
      warnings.push("providerRetry is not valid JSON; using the adapter default.");
      return fallback;
    }
  }
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("providerRetry must be an object; using the adapter default.");
    return fallback;
  }
  const r = raw as Record<string, unknown>;
  const bad = (what: string) => {
    warnings.push(`providerRetry.${what}; using the adapter default.`);
    return fallback;
  };
  const mode = r.mode === undefined ? "normal" : r.mode;
  if (mode !== "normal" && mode !== "always") return bad('mode must be "normal" or "always"');
  const out: RetryPolicy = { mode };
  for (const k of Object.keys(r)) {
    if (!["mode", "maxRetries", "retryableCodes", "backoff"].includes(k)) return bad(`${k} is not a retry policy field`);
  }
  if (r.maxRetries !== undefined) {
    if (!Number.isSafeInteger(r.maxRetries) || (r.maxRetries as number) < 0) return bad("maxRetries must be a whole number >= 0");
    out.maxRetries = r.maxRetries as number;
  }
  if (r.retryableCodes !== undefined) {
    if (!Array.isArray(r.retryableCodes) || !r.retryableCodes.every((c) => typeof c === "string" && c.trim())) {
      return bad("retryableCodes must be a list of error codes");
    }
    out.retryableCodes = r.retryableCodes as string[];
  }
  if (r.backoff !== undefined) {
    if (typeof r.backoff !== "object" || r.backoff === null || Array.isArray(r.backoff)) return bad("backoff must be an object");
    const b = r.backoff as Record<string, unknown>;
    const backoff: NonNullable<RetryPolicy["backoff"]> = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === "initialDelayMs" || k === "maxDelayMs") {
        if (typeof v !== "number" || !(v >= 0) || v > MAX_DELAY_MS) return bad(`backoff.${k} must be 0..${MAX_DELAY_MS} ms`);
        backoff[k] = v;
      } else if (k === "jitterRatio") {
        if (typeof v !== "number" || !(v >= 0 && v <= 1)) return bad("backoff.jitterRatio must be between 0 and 1");
        backoff.jitterRatio = v;
      } else return bad(`backoff.${k} is not a backoff field`);
    }
    out.backoff = backoff;
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

/**
 * Catalog override for deepseek-official, or null when dsh's built-in catalog is right.
 * `auto` keeps InferX Flash's 262,144-token window on DeepSeek's API too, so compaction behaves
 * the same whichever route a run lands on; a configured contextWindow / maxTokens always applies.
 */
function officialCatalog(
  model: string,
  config: Record<string, unknown>,
  warnings: string[],
  sameWindowAsInferx: boolean,
): OfficialModelSpec[] | null {
  const configured = positiveInt(config.contextWindow);
  const window = configured ?? (sameWindowAsInferx && model === "deepseek-flash" ? INFERX_CONTEXT_WINDOW : undefined);
  const spec = modelSpec(model, config, warnings);
  if (window === undefined && spec.maxTokens === undefined) return null;
  return OFFICIAL_CATALOG.map((entry) => {
    if (entry.id !== model) return { ...entry };
    const out: OfficialModelSpec = { ...entry, contextWindow: window ?? entry.contextWindow };
    if (spec.maxTokens !== undefined) out.maxTokens = spec.maxTokens;
    return out;
  });
}

function official(
  config: Record<string, unknown>,
  reason: string,
  warnings: string[],
  opts: { sameWindowAsInferx?: boolean; model?: string } = {},
): ResolvedProvider {
  let model: string;
  if (opts.model) model = opts.model;
  else if (str(config.model) === INFERX_DEFAULT_MODEL) {
    warnings.push(`Model ${INFERX_DEFAULT_MODEL} is served by InferX only; using deepseek-flash on ${DEEPSEEK_PROVIDER}.`);
    model = "deepseek-flash";
  } else {
    if (isForeignModel(config.model)) {
      warnings.push(`Model "${String(config.model)}" is not a DeepSeek model; using ${resolveDshModel(config.model)}.`);
    }
    model = resolveDshModel(config.model);
  }
  return {
    provider: DEEPSEEK_PROVIDER,
    model,
    keyEnv: DEEPSEEK_KEY_ENV,
    route: null,
    reason,
    warnings,
    officialModels: officialCatalog(model, config, warnings, opts.sameWindowAsInferx === true),
  };
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
    retryPolicy: readRetryPolicy(config.providerRetry, warnings, INFERX_RETRY_POLICY),
  };
  return { provider: INFERX_PROVIDER, model, keyEnv, route, reason, warnings };
}

/**
 * Picks the provider route and model for a run.
 *
 * @param hasKey reports whether an env var holds a non-empty value in the run environment
 *               (only used for `provider: "auto"`).
 */
export interface ProviderCooldownView {
  until: string;
  reason: string;
}

export function resolveProvider(
  config: Record<string, unknown>,
  hasKey: (name: string) => boolean,
  opts: { cooldown?: ProviderCooldownView | null } = {},
): ResolvedProvider {
  const warnings: string[] = [];
  const requested = str(config.provider).toLowerCase();

  if (!requested || requested === "auto") {
    const model = str(config.model);
    const flashLike = FLASH_IDS.has(model) || model === INFERX_DEFAULT_MODEL || isForeignModel(model);
    const sameWindow = { sameWindowAsInferx: true };
    if (hasKey(INFERX_KEY_ENV) && flashLike) {
      if (opts.cooldown && hasKey(DEEPSEEK_KEY_ENV)) {
        return official(
          config,
          `auto: InferX is cooling down until ${opts.cooldown.until} after "${opts.cooldown.reason}"`,
          warnings,
          { ...sameWindow, model: "deepseek-flash" },
        );
      }
      return inferx(config, `auto: ${INFERX_KEY_ENV} is set`, warnings);
    }
    const why = !hasKey(INFERX_KEY_ENV)
      ? `auto: ${INFERX_KEY_ENV} is not set`
      : `auto: model "${model}" is not a Flash model InferX serves`;
    return official(config, why, warnings, sameWindow);
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
    retryPolicy: readRetryPolicy(config.providerRetry, warnings, null),
  };
  return { provider: requested, model, keyEnv: apiKeyEnv, route, reason: "configured", warnings };
}

/**
 * The route a failed run falls back to, or null when there is none. `auto` falls back to
 * deepseek-official (deepseek-flash, InferX's 262,144-token window) unless `fallbackProvider` is
 * "none"; other providers only with `fallbackProvider: "deepseek-official"`. Needs DEEPSEEK_API_KEY.
 */
export function resolveFallback(
  config: Record<string, unknown>,
  primary: ResolvedProvider,
  hasKey: (name: string) => boolean,
): ResolvedProvider | null {
  if (primary.provider === DEEPSEEK_PROVIDER) return null;
  const requested = str(config.provider).toLowerCase();
  const setting = str(config.fallbackProvider).toLowerCase();
  const isAuto = !requested || requested === "auto";
  const enabled = setting === "none" || setting === "off" ? false : setting === DEEPSEEK_PROVIDER || setting === "deepseek" || isAuto;
  if (!enabled || !hasKey(DEEPSEEK_KEY_ENV)) return null;
  const warnings: string[] = [];
  const model = primary.model === INFERX_DEFAULT_MODEL || FLASH_IDS.has(str(config.model)) ? "deepseek-flash" : resolveDshModel(primary.model);
  return official(config, `fallback after ${primary.provider} failed`, warnings, { sameWindowAsInferx: true, model });
}
