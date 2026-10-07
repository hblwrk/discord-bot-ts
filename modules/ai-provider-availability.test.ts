import {beforeEach, describe, expect, test, vi} from "vitest";
import {callAiProviderJson, clearAiProviderState, isAiProviderAvailable} from "./ai-provider.ts";

const providers = ["gemini", "openai"] as const;

function dependencies(provider: string, minuteLimit = "2", dailyLimit = "10") {
  return {
    logger: {log: vi.fn()}, nowMs: vi.fn(() => 1_000),
    postWithRetryFn: vi.fn().mockResolvedValue({data: {output_text: "{}", candidates: [{content: {parts: [{text: "{}"}]}}]}}),
    readSecretFn: vi.fn((name: string) => name === "ai_provider" ? provider
      : name === `${provider}_api_key` ? "test-key"
      : name === `${provider}_calls_per_minute` ? minuteLimit
      : name === `${provider}_calls_per_day` ? dailyLimit : ""),
  };
}

describe("AI provider availability", () => {
  beforeEach(() => { clearAiProviderState(); });

  test.each(["none", "off", "disabled", " OFF "])("explicit mode '%s' stays disabled even with API keys present", async mode => {
    const deps = dependencies("gemini");
    deps.readSecretFn.mockImplementation(name => name === "ai_provider" ? mode : "test-key");
    expect(isAiProviderAvailable(deps)).toBe(false);
    expect(await callAiProviderJson("prompt", {}, deps, "optional review")).toBeNull();
    expect(deps.postWithRetryFn).not.toHaveBeenCalled();
    expect(deps.logger.log).not.toHaveBeenCalled();
  });

  test.each(providers)("missing %s credentials stays unavailable without falling across providers", provider => {
    const deps = dependencies(provider);
    deps.readSecretFn.mockImplementation(name => name === "ai_provider" ? provider
      : name.endsWith("api_key") && name !== `${provider}_api_key` ? "other-provider-key" : "");
    expect(isAiProviderAvailable(deps)).toBe(false);
    expect(deps.postWithRetryFn).not.toHaveBeenCalled();
    expect(deps.logger.log).not.toHaveBeenCalled();
  });

  test("uses Gemini availability when the provider setting is absent", () => {
    const deps = dependencies("gemini");
    deps.readSecretFn.mockImplementation(name => {
      if (name === "gemini_api_key") return "test-key";
      throw new Error("missing optional configuration");
    });
    expect(isAiProviderAvailable(deps)).toBe(true);
  });

  test("checks the configured provider fallback without logging or consuming calls", () => {
    const deps = dependencies("gemini");
    deps.readSecretFn.mockImplementation(name => name === "ai_provider" ? "unsupported"
      : name === "gemini_api_key" ? "test-key" : "");
    expect(isAiProviderAvailable(deps)).toBe(true);
    expect(deps.logger.log).not.toHaveBeenCalled();
    expect(deps.postWithRetryFn).not.toHaveBeenCalled();
  });

  test.each(providers)("%s availability checks do not reserve calls and recover after the minute window", async provider => {
    const deps = dependencies(provider);
    for (let check = 0; check < 10; check++) expect(isAiProviderAvailable(deps)).toBe(true);
    await callAiProviderJson("prompt", {}, deps, "test");
    expect(isAiProviderAvailable(deps)).toBe(true);
    await callAiProviderJson("prompt", {}, deps, "test");
    expect(isAiProviderAvailable(deps)).toBe(false);
    expect(deps.postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(deps.logger.log).not.toHaveBeenCalled();
    deps.nowMs.mockReturnValue(61_000);
    expect(isAiProviderAvailable(deps)).toBe(true);
  });

  test.each(providers)("%s availability respects daily caps and recovers the rolling window", async provider => {
    const deps = dependencies(provider, "10", "1");
    await callAiProviderJson("prompt", {}, deps, "test");
    deps.nowMs.mockReturnValue(61_000);
    expect(isAiProviderAvailable(deps)).toBe(false);
    expect(deps.logger.log).not.toHaveBeenCalled();
    deps.nowMs.mockReturnValue(86_401_000);
    expect(isAiProviderAvailable(deps)).toBe(true);
  });

  test.each(providers)("%s availability respects provider cooldown without consuming another request", async provider => {
    const deps = dependencies(provider);
    deps.postWithRetryFn.mockRejectedValueOnce({response: {status: 429, headers: {"retry-after": "120"}}});
    await expect(callAiProviderJson("prompt", {}, deps, "test")).rejects.toMatchObject({response: {status: 429}});
    deps.logger.log.mockClear();
    deps.nowMs.mockReturnValue(61_000);
    expect(isAiProviderAvailable(deps)).toBe(false);
    expect(deps.postWithRetryFn).toHaveBeenCalledTimes(1);
    expect(deps.logger.log).not.toHaveBeenCalled();
    deps.nowMs.mockReturnValue(121_000);
    expect(isAiProviderAvailable(deps)).toBe(true);
  });
});
