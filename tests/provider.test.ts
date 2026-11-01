import { describe, expect, it } from "vitest";
import { INFERX_RETRY_POLICY, readRetryPolicy, resolveFallback, resolveProvider } from "../src/server/provider.js";

const withKeys = (...names: string[]) => (name: string) => names.includes(name);

describe("resolveProvider", () => {
  it("auto: InferX Flash when DEEPSEEK_INFERX_API_KEY is set", () => {
    for (const model of [undefined, "", "deepseek-flash", "flash", "deepseek-v4-flash", "deepseek-v4.1-flash-1017-basic"]) {
      const r = resolveProvider({ model }, withKeys("DEEPSEEK_INFERX_API_KEY"));
      expect(r).toMatchObject({ provider: "inferx", model: "deepseek-v4.1-flash-1017-basic", keyEnv: "DEEPSEEK_INFERX_API_KEY" });
      expect(r.route).toMatchObject({ name: "inferx", api: "openai-completions", baseURL: "https://model.inferx.net/endpoints/v1" });
      expect(r.route!.models).toEqual([{ id: "deepseek-v4.1-flash-1017-basic", name: "DeepSeek V4.1 Flash (InferX)", contextWindow: 262144 }]);
      expect(r.warnings).toEqual([]);
    }
  });

  it("auto: deepseek-official without the InferX key", () => {
    const r = resolveProvider({ model: "deepseek-flash" }, withKeys("DEEPSEEK_API_KEY"));
    expect(r).toMatchObject({ provider: "deepseek-official", model: "deepseek-flash", keyEnv: "DEEPSEEK_API_KEY", route: null });
    expect(r.reason).toMatch(/DEEPSEEK_INFERX_API_KEY is not set/);
  });

  it("auto: Pro stays on deepseek-official even with an InferX key", () => {
    const r = resolveProvider({ model: "deepseek-v4-pro" }, withKeys("DEEPSEEK_INFERX_API_KEY", "DEEPSEEK_API_KEY"));
    expect(r).toMatchObject({ provider: "deepseek-official", model: "deepseek-v4-pro" });
  });

  it("auto: a Codex model left behind goes to InferX Flash with a warning", () => {
    const r = resolveProvider({ model: "gpt-5.6-luna" }, withKeys("DEEPSEEK_INFERX_API_KEY"));
    expect(r).toMatchObject({ provider: "inferx", model: "deepseek-v4.1-flash-1017-basic" });
    expect(r.warnings.join("\n")).toMatch(/not a DeepSeek model/);
  });

  it("deepseek-official maps the InferX-only model back to deepseek-flash", () => {
    const r = resolveProvider({ provider: "deepseek-official", model: "deepseek-v4.1-flash-1017-basic" }, withKeys());
    expect(r).toMatchObject({ provider: "deepseek-official", model: "deepseek-flash" });
    expect(r.warnings.join("\n")).toMatch(/served by InferX only/);
  });

  it("deepseek-official keeps the Codex fallback model rule", () => {
    const r = resolveProvider({ provider: "deepseek-official", model: "gpt-5.5" }, withKeys());
    expect(r.model).toBe("deepseek-flash");
    expect(r.warnings.join("\n")).toMatch(/not a DeepSeek model/);
  });

  it("inferx: honours baseUrl, apiKeyEnv and a non-default model", () => {
    const r = resolveProvider(
      { provider: "InferX", baseUrl: "https://alt.inferx.example/v1", apiKeyEnv: "MY_IX_KEY", model: "deepseek-v4.1-pro-x" },
      withKeys(),
    );
    expect(r).toMatchObject({ provider: "inferx", model: "deepseek-v4.1-pro-x", keyEnv: "MY_IX_KEY" });
    expect(r.route).toMatchObject({ baseURL: "https://alt.inferx.example/v1", apiKeyEnv: "MY_IX_KEY", models: [{ id: "deepseek-v4.1-pro-x" }] });
  });

  it("custom: a complete OpenAI-compatible route", () => {
    const r = resolveProvider(
      { provider: "acme-gw", baseUrl: "https://gw.example/v1", apiKeyEnv: "ACME_KEY", model: "acme-think", providerApi: "openai-responses", maxTokens: "8192" },
      withKeys(),
    );
    expect(r).toMatchObject({ provider: "acme-gw", model: "acme-think", keyEnv: "ACME_KEY" });
    expect(r.route).toMatchObject({ name: "acme-gw", api: "openai-responses", models: [{ id: "acme-think", maxTokens: 8192 }] });
  });

  it("never writes an output cap below 8192 (reasoning comes out of the same budget)", () => {
    const small = resolveProvider({ provider: "inferx", maxTokens: 20 }, withKeys());
    expect(small.route!.models[0]!.maxTokens).toBe(8192);
    expect(small.warnings.join("\n")).toMatch(/maxTokens 20 is too small/);
    const big = resolveProvider({ provider: "inferx", maxTokens: 16384, contextWindow: 200000 }, withKeys());
    expect(big.route!.models[0]).toMatchObject({ maxTokens: 16384, contextWindow: 200000 });
    expect(big.warnings).toEqual([]);
  });

  it("custom: an incomplete route falls back to deepseek-official", () => {
    const r = resolveProvider({ provider: "acme", baseUrl: "gw.example", model: "acme-think" }, withKeys());
    expect(r).toMatchObject({ provider: "deepseek-official", route: null });
    expect(r.warnings.join("\n")).toMatch(/needs baseUrl .*apiKeyEnv/);
  });
});

describe("retry policy", () => {
  const has = () => true;
  it("gives the InferX route a long retry policy by default", () => {
    const r = resolveProvider({ model: "deepseek-flash" }, has);
    expect(r.route?.retryPolicy).toEqual(INFERX_RETRY_POLICY);
  });
  it("accepts an override, JSON or object, and 'default' for dsh's own", () => {
    expect(resolveProvider({ providerRetry: '{"maxRetries":3,"backoff":{"maxDelayMs":5000}}' }, has).route?.retryPolicy).toEqual({
      mode: "normal",
      maxRetries: 3,
      backoff: { maxDelayMs: 5000 },
    });
    expect(resolveProvider({ providerRetry: { mode: "always" } }, has).route?.retryPolicy).toEqual({ mode: "always" });
    expect(resolveProvider({ providerRetry: "default" }, has).route?.retryPolicy).toBeNull();
  });
  it("falls back to the default on an invalid policy", () => {
    const warnings: string[] = [];
    expect(readRetryPolicy({ maxRetries: -1 }, warnings, INFERX_RETRY_POLICY)).toBe(INFERX_RETRY_POLICY);
    expect(readRetryPolicy({ backoff: { maxDelayMs: 1e9 } }, warnings, null)).toBeNull();
    expect(readRetryPolicy({ retries: 3 }, warnings, null)).toBeNull();
    expect(readRetryPolicy("{oops", warnings, null)).toBeNull();
    expect(warnings).toHaveLength(4);
  });
  it("custom routes keep dsh's default unless set", () => {
    const base = { provider: "acme", baseUrl: "https://x.example/v1", apiKeyEnv: "ACME_KEY", model: "m1" };
    expect(resolveProvider(base, has).route?.retryPolicy).toBeNull();
    expect(resolveProvider({ ...base, providerRetry: { maxRetries: 8 } }, has).route?.retryPolicy).toEqual({ mode: "normal", maxRetries: 8 });
  });
});

describe("deepseek-official catalog and InferX fallback", () => {
  const keys = (...names: string[]) => (n: string) => names.includes(n);
  const flash = (r: { officialModels?: { id: string; contextWindow: number }[] | null }) => r.officialModels?.find((m) => m.id === "deepseek-flash");

  it("auto keeps the 262,144 window on DeepSeek's API; explicit official keeps dsh's catalog", () => {
    const auto = resolveProvider({ model: "deepseek-flash" }, keys("DEEPSEEK_API_KEY"));
    expect(auto.provider).toBe("deepseek-official");
    expect(flash(auto)?.contextWindow).toBe(262_144);
    expect(auto.officialModels?.find((m) => m.id === "deepseek-v4-pro")?.contextWindow).toBe(1_048_576);
    expect(resolveProvider({ provider: "deepseek-official", model: "deepseek-flash" }, keys()).officialModels).toBeNull();
    expect(flash(resolveProvider({ provider: "deepseek-official", contextWindow: 200000 }, keys()))?.contextWindow).toBe(200_000);
  });

  it("auto skips InferX during a cool-down only when DeepSeek's key is there", () => {
    const cooldown = { until: "2026-11-02T00:15:00Z", reason: "RATE_LIMIT: 429" };
    const cooled = resolveProvider({ model: "flash" }, keys("DEEPSEEK_INFERX_API_KEY", "DEEPSEEK_API_KEY"), { cooldown });
    expect(cooled).toMatchObject({ provider: "deepseek-official", model: "deepseek-flash" });
    expect(cooled.reason).toContain("cooling down");
    expect(flash(cooled)?.contextWindow).toBe(262_144);
    expect(resolveProvider({ model: "flash" }, keys("DEEPSEEK_INFERX_API_KEY"), { cooldown }).provider).toBe("inferx");
  });

  it("resolveFallback: auto -> deepseek-flash with the same window, unless off or keyless", () => {
    const both = keys("DEEPSEEK_INFERX_API_KEY", "DEEPSEEK_API_KEY");
    const primary = resolveProvider({ model: "deepseek-flash", maxTokens: 1000 }, both);
    const fb = resolveFallback({ model: "deepseek-flash", maxTokens: 1000 }, primary, both);
    expect(fb).toMatchObject({ provider: "deepseek-official", model: "deepseek-flash" });
    expect(flash(fb!)).toMatchObject({ contextWindow: 262_144, maxTokens: 8192 });
    expect(resolveFallback({ fallbackProvider: "none" }, primary, both)).toBeNull();
    expect(resolveFallback({}, primary, keys("DEEPSEEK_INFERX_API_KEY"))).toBeNull();
    const explicit = resolveProvider({ provider: "inferx" }, both);
    expect(resolveFallback({ provider: "inferx" }, explicit, both)).toBeNull();
    expect(resolveFallback({ provider: "inferx", fallbackProvider: "deepseek-official" }, explicit, both)?.provider).toBe("deepseek-official");
    const official = resolveProvider({ provider: "deepseek-official" }, both);
    expect(resolveFallback({}, official, both)).toBeNull();
  });
});
