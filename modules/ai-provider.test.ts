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
