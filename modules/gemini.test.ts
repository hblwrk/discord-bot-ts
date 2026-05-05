import {beforeEach, describe, expect, test, vi} from "vitest";
import {callGeminiJson, clearGeminiState} from "./gemini.ts";

describe("Gemini client", () => {
  const logger = {
    log: vi.fn(),
  };
  const responseJsonSchema = {
    type: "object",
    properties: {},
  };
  const readSecretFn = vi.fn((secretName: string) => {
    if ("gemini_api_key" === secretName) {
      return "gemini-key";
    }

    throw new Error(`missing ${secretName}`);
  });
  const successfulGeminiResponse = {
    data: {
      candidates: [{
        content: {
          parts: [{
            text: "{}",
          }],
        },
      }],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearGeminiState();
  });

  test("activates a shared cooldown after API rate limiting", async () => {
    const rateLimitError = {
      response: {
        headers: {
          "retry-after": "30",
        },
        status: 429,
      },
    };
    const postWithRetryFn = vi.fn().mockRejectedValue(rateLimitError);

    await expect(callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(rateLimitError);

    const skippedResult = await callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 2_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task");

    expect(skippedResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Gemini API returned 429; cooling down Gemini calls for 30s.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping Gemini test task: API rate-limit cooldown is active for 29s.",
    );
  });

  test("uses a default cooldown when rate-limit responses omit retry-after", async () => {
    const rateLimitError = {
      response: {
        headers: {},
        status: 429,
      },
    };
    const postWithRetryFn = vi.fn().mockRejectedValue(rateLimitError);

    await expect(callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 10_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(rateLimitError);

    const skippedResult = await callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 69_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task");

    expect(skippedResult).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Gemini API returned 429; cooling down Gemini calls for 60s.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping Gemini test task: API rate-limit cooldown is active for 1s.",
    );
  });

  test("does not activate cooldown for non-rate-limit failures", async () => {
    const serverError = {
      response: {
        headers: {},
        status: 500,
      },
    };
    const postWithRetryFn = vi.fn()
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce(successfulGeminiResponse);

    await expect(callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(serverError);
    const result = await callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 2_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task");

    expect(result).toBe("{}");
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).not.toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("cooling down"),
    );
  });

  test("caps Gemini calls with the local per-day limiter", async () => {
    const limitedReadSecretFn = vi.fn((secretName: string) => {
      if ("gemini_api_key" === secretName) {
        return "gemini-key";
      }

      if ("gemini_calls_per_day" === secretName) {
        return "2";
      }

      if ("gemini_calls_per_minute" === secretName) {
        return "10";
      }

      throw new Error(`missing ${secretName}`);
    });
    const postWithRetryFn = vi.fn().mockResolvedValue(successfulGeminiResponse);

    await callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");
    await callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 62_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");
    const skippedResult = await callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 123_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");

    expect(skippedResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping Gemini test task: local 2/day rate limit is exhausted.",
    );
  });

  test("allows configured Gemini limits above the conservative defaults", async () => {
    const limitedReadSecretFn = vi.fn((secretName: string) => {
      if ("gemini_api_key" === secretName) {
        return "gemini-key";
      }

      if ("gemini_calls_per_day" === secretName) {
        return "25";
      }

      if ("gemini_calls_per_minute" === secretName) {
        return "11";
      }

      throw new Error(`missing ${secretName}`);
    });
    const postWithRetryFn = vi.fn().mockResolvedValue(successfulGeminiResponse);

    for (let index = 0; index < 11; index++) {
      await callGeminiJson("prompt", responseJsonSchema, {
        logger,
        nowMs: () => 1_000,
        postWithRetryFn,
        readSecretFn: limitedReadSecretFn,
      }, "test task");
    }

    expect(postWithRetryFn).toHaveBeenCalledTimes(11);
    expect(logger.log).not.toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("rate limit is exhausted"),
    );
  });

  test("parses numeric and HTTP-date retry-after headers", async () => {
    const numericRateLimitError = {
      response: {
        headers: {
          "Retry-After": 2,
        },
        status: 429,
      },
    };
    const dateRateLimitError = {
      response: {
        headers: {
          "retry-after": new Date(Date.now() + 5_000).toUTCString(),
        },
        status: 429,
      },
    };
    const postWithRetryFn = vi.fn()
      .mockRejectedValueOnce(numericRateLimitError)
      .mockRejectedValueOnce(dateRateLimitError);

    await expect(callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(numericRateLimitError);
    clearGeminiState();
    await expect(callGeminiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 2_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(dateRateLimitError);

    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Gemini API returned 429; cooling down Gemini calls for 2s.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringMatching(/^Gemini API returned 429; cooling down Gemini calls for [1-5]s\.$/),
    );
  });
});
