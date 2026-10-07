import {beforeEach, describe, expect, test, vi} from "vitest";
import {callAiProviderJson, clearAiProviderState} from "./ai-provider.ts";

describe("AI provider facade", () => {
  const logger = {
    log: vi.fn(),
  };
  const responseJsonSchema = {
    properties: {},
    type: "object",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearAiProviderState();
  });

  test.each([
    {profile: "routine" as const, useWebSearch: false, file: undefined, expectedModel: "gpt-6-luna", routine: true},
    {profile: undefined, useWebSearch: false, file: undefined, expectedModel: "gpt-5.4-mini", routine: false},
    {profile: "routine" as const, useWebSearch: true, file: undefined, expectedModel: "gpt-5.4-mini", routine: false},
    {profile: "routine" as const, useWebSearch: false, file: {data: "cGRm", mimeType: "application/pdf"}, expectedModel: "gpt-5.4-mini", routine: false},
  ])("routes $expectedModel with routine=$routine and search=$useWebSearch", async ({profile, useWebSearch, file, expectedModel, routine}) => {
    const postWithRetryFn = vi.fn().mockResolvedValue({data: {output_text: "{}"}});
    await callAiProviderJson("prompt", responseJsonSchema, {
      logger, postWithRetryFn,
      readSecretFn: secret => secret === "ai_provider" ? "openai" : secret === "openai_api_key" ? "test-key" : "",
    }, "test", file, {profile, useWebSearch, timeoutMs: 30_000});
    expect(postWithRetryFn.mock.calls[0]?.[1].model).toBe(expectedModel);
    expect(postWithRetryFn.mock.calls[0]?.[1].reasoning).toEqual(routine ? {effort: "none"} : undefined);
    expect(postWithRetryFn.mock.calls[0]?.[3].timeoutMs).toBe(30_000);
  });

  test("honours separate model overrides while sharing the OpenAI call cap", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({data: {output_text: "{}"}});
    const dependencies = {
      logger, postWithRetryFn, nowMs: () => 1_000,
      readSecretFn: (secret: string) => ({
        ai_provider: "openai", openai_api_key: "test-key", openai_model: "factual-override",
        openai_routine_model: "routine-override", openai_calls_per_minute: "2",
      })[secret] ?? "",
    };
    await callAiProviderJson("prompt", responseJsonSchema, dependencies, "factual");
    await callAiProviderJson("prompt", responseJsonSchema, dependencies, "routine", undefined, {profile: "routine"});
    expect(await callAiProviderJson("prompt", responseJsonSchema, dependencies, "factual")).toBeNull();
    expect(postWithRetryFn.mock.calls.map(call => call[1].model)).toEqual(["factual-override", "routine-override"]);
  });

  test("routine routing preserves Gemini", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({data: {candidates: [{content: {parts: [{text: "{}"}]}}]}});
    const result = await callAiProviderJson("prompt", responseJsonSchema, {
      logger, postWithRetryFn,
      readSecretFn: secret => secret === "ai_provider" ? "gemini" : secret.endsWith("api_key") ? "test-key" : "",
    }, "routine", undefined, {profile: "routine"});
    expect(result).toBe("{}");
    expect(postWithRetryFn.mock.calls[0]?.[0]).toContain("gemini-2.5-flash-lite");
    expect(postWithRetryFn.mock.calls[0]?.[1]).not.toHaveProperty("reasoning");
  });

  test("routine routing respects disabled AI", async () => {
    const postWithRetryFn = vi.fn();
    expect(await callAiProviderJson("prompt", responseJsonSchema, {
      logger, postWithRetryFn,
      readSecretFn: secret => secret === "ai_provider" ? "none" : "test-key",
    }, "routine", undefined, {profile: "routine"})).toBeNull();
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });

  test.each(["gemini", "openai"])("forwards search citation metadata from %s", async provider => {
    const source = "https://reuters.com/world/report";
    const onWebSources = vi.fn();
    const postWithRetryFn = vi.fn().mockResolvedValue({data: provider === "gemini" ? {
      candidates: [{content: {parts: [{text: "{}"}]}, groundingMetadata: {groundingChunks: [
        {web: {uri: source}}, {}, {web: {}},
      ]}}],
    } : {
      output: [{content: [{type: "output_text", text: "{}", annotations: [
        {type: "url_citation", url: source}, {type: "other", url: "ignored"}, {type: "url_citation"},
      ]}, {}]}, {}],
    }});
    await callAiProviderJson("prompt", responseJsonSchema, {
      logger, postWithRetryFn,
      readSecretFn: secret => secret === "ai_provider" ? provider : secret.endsWith("api_key") ? "test-key" : "",
    }, "test", undefined, {useWebSearch: true, onWebSources});
    expect(onWebSources).toHaveBeenCalledExactlyOnceWith([source]);
  });

  test.each(["gemini", "openai"])("reports empty search provenance when %s omits metadata", async provider => {
    const onWebSources = vi.fn();
    await callAiProviderJson("prompt", responseJsonSchema, {
      logger, postWithRetryFn: vi.fn().mockResolvedValue({data: {}}),
      readSecretFn: secret => secret === "ai_provider" ? provider : secret.endsWith("api_key") ? "test-key" : "",
    }, "test", undefined, {useWebSearch: true, onWebSources});
    expect(onWebSources).toHaveBeenCalledExactlyOnceWith([]);
  });

  test.each([false, true])("combines and deduplicates OpenAI annotations and search sources only for web requests: %s", async useWebSearch => {
    const source = "https://reuters.com/world/report";
    const other = "https://apnews.com/article/report";
    const onWebSources = vi.fn();
    const postWithRetryFn = vi.fn().mockResolvedValue({data: {output: [
      {type: "web_search_call", status: "completed", action: {type: "search", sources: [
        {type: "url", url: source}, {type: "url", url: other}, {type: "url", url: other},
      ]}},
      {content: [{type: "output_text", text: "{}", annotations: [{type: "url_citation", url: source}]}]},
    ]}});
    await callAiProviderJson("prompt", responseJsonSchema, {
      logger, postWithRetryFn,
      readSecretFn: secret => secret === "ai_provider" ? "openai" : secret === "openai_api_key" ? "test-key" : "",
    }, "test", undefined, {useWebSearch, onWebSources});
    expect(onWebSources.mock.calls).toEqual(useWebSearch ? [[[source, other]]] : []);
    expect(postWithRetryFn.mock.calls[0]?.[1].include).toEqual(useWebSearch ? ["web_search_call.action.sources"] : undefined);
  });

  test("uses Gemini when no provider is configured", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: "{}",
            }],
          },
        }],
      },
    });

    const result = await callAiProviderJson("prompt", responseJsonSchema, {
      logger,
      postWithRetryFn,
      readSecretFn: vi.fn((secretName: string) => {
        if ("gemini_api_key" === secretName) {
          return "gemini-key";
        }

        throw new Error(`missing ${secretName}`);
      }),
    }, "test task");

    expect(result).toBe("{}");
    expect(postWithRetryFn).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  test("routes to OpenAI when ai_provider is openai", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        output_text: "{}",
      },
    });

    const result = await callAiProviderJson("prompt", responseJsonSchema, {
      logger,
      postWithRetryFn,
      readSecretFn: vi.fn((secretName: string) => {
        if ("ai_provider" === secretName) {
          return "openai";
        }

        if ("openai_api_key" === secretName) {
          return "openai-key";
        }

        throw new Error(`missing ${secretName}`);
      }),
    }, "test task", undefined, {
      timeoutMs: 60_000,
      useWebSearch: true,
    });

    expect(result).toBe("{}");
    expect(postWithRetryFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        tools: [{
          search_context_size: "low",
          type: "web_search",
        }],
      }),
      expect.anything(),
      expect.objectContaining({
        timeoutMs: 60_000,
      }),
    );
  });

  test("falls back to Gemini for unsupported provider names", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: "{}",
            }],
          },
        }],
      },
    });

    const result = await callAiProviderJson("prompt", responseJsonSchema, {
      logger,
      postWithRetryFn,
      readSecretFn: vi.fn((secretName: string) => {
        if ("ai_provider" === secretName) {
          return "anthropic";
        }

        if ("gemini_api_key" === secretName) {
          return "gemini-key";
        }

        throw new Error(`missing ${secretName}`);
      }),
    }, "test task");

    expect(result).toBe("{}");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Unsupported AI provider \"anthropic\"; using Gemini.",
    );
    expect(postWithRetryFn).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
