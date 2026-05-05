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
