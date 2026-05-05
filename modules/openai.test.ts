import {beforeEach, describe, expect, test, vi} from "vitest";
import {callOpenAiJson, clearOpenAiState} from "./openai.ts";

describe("OpenAI client", () => {
  const logger = {
    log: vi.fn(),
  };
  const responseJsonSchema = {
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
      },
    },
    required: ["summary"],
    type: "object",
  };
  const readSecretFn = vi.fn((secretName: string) => {
    if ("openai_api_key" === secretName) {
      return "openai-key";
    }

    if ("openai_model" === secretName) {
      return "gpt-5.4-mini";
    }

    throw new Error(`missing ${secretName}`);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearOpenAiState();
  });

  test("posts Responses API structured output requests with optional file and web search", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        output: [{
          content: [{
            text: "{\"summary\":\"ok\"}",
            type: "output_text",
          }],
        }],
      },
    });

    const result = await callOpenAiJson(
      "Summarize the PDF.",
      responseJsonSchema,
      {
        logger,
        nowMs: () => 1_000,
        postWithRetryFn,
        readSecretFn,
      },
      "MNC summary",
      {
        data: "cGRmLWJ5dGVz",
        filename: "mnc.pdf",
        mimeType: "application/pdf",
      },
      {
        timeoutMs: 45_000,
        useWebSearch: true,
      },
    );

    expect(result).toBe("{\"summary\":\"ok\"}");
    expect(postWithRetryFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        input: [{
          content: [{
            file_data: "data:application/pdf;base64,cGRmLWJ5dGVz",
            filename: "mnc.pdf",
            type: "input_file",
          }, {
            text: "Summarize the PDF.",
            type: "input_text",
          }],
          role: "user",
        }],
        model: "gpt-5.4-mini",
        text: {
          format: {
            name: "bot_response",
            schema: responseJsonSchema,
            strict: true,
            type: "json_schema",
          },
        },
        tool_choice: "required",
        tools: [{
          search_context_size: "low",
          type: "web_search",
        }],
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Authorization": "Bearer openai-key",
          "Content-Type": "application/json",
        }),
      }),
      expect.objectContaining({
        maxAttempts: 1,
        timeoutMs: 45_000,
      }),
    );
  });

  test("uses default model when optional OpenAI secrets are missing", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        output_text: "{\"summary\":\"ok\"}",
      },
    });

    const result = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn: vi.fn((secretName: string) => {
        if ("openai_api_key" === secretName) {
          return "openai-key";
        }

        throw new Error(`missing ${secretName}`);
      }),
    }, "test task");

    expect(result).toBe("{\"summary\":\"ok\"}");
    expect(postWithRetryFn).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        model: "gpt-5.4-mini",
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  test("uses higher default OpenAI local call caps", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        output_text: "{\"summary\":\"ok\"}",
      },
    });
    const defaultCapReadSecretFn = vi.fn((secretName: string) => {
      if ("openai_api_key" === secretName) {
        return "openai-key";
      }

      throw new Error(`missing ${secretName}`);
    });

    for (let callIndex = 0; callIndex < 20; callIndex += 1) {
      await callOpenAiJson("prompt", responseJsonSchema, {
        logger,
        nowMs: () => 1_000,
        postWithRetryFn,
        readSecretFn: defaultCapReadSecretFn,
      }, "test task");
    }
    const perMinuteSkippedResult = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn: defaultCapReadSecretFn,
    }, "test task");

    expect(perMinuteSkippedResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(20);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping OpenAI test task: local 20/minute rate limit is exhausted.",
    );

    clearOpenAiState();
    postWithRetryFn.mockClear();
    logger.log.mockClear();

    for (let callIndex = 0; callIndex < 200; callIndex += 1) {
      await callOpenAiJson("prompt", responseJsonSchema, {
        logger,
        nowMs: () => 1_000 + (callIndex * 61_000),
        postWithRetryFn,
        readSecretFn: defaultCapReadSecretFn,
      }, "test task");
    }
    const perDaySkippedResult = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000 + (200 * 61_000),
      postWithRetryFn,
      readSecretFn: defaultCapReadSecretFn,
    }, "test task");

    expect(perDaySkippedResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(200);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping OpenAI test task: local 200/day rate limit is exhausted.",
    );
  });

  test("returns null when the OpenAI API key is missing", async () => {
    const postWithRetryFn = vi.fn();

    const result = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      postWithRetryFn,
      readSecretFn: vi.fn(() => {
        throw new Error("missing secret");
      }),
    }, "test task");

    expect(result).toBeNull();
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });

  test("uses default inline filenames by MIME type", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        output_text: "{\"summary\":\"ok\"}",
      },
    });

    await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    }, "PDF task", {
      data: "cGRm",
      mimeType: "application/pdf",
    });
    clearOpenAiState();
    await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 2_000,
      postWithRetryFn,
      readSecretFn,
    }, "binary task", {
      data: "Ymlu",
      mimeType: "application/octet-stream",
    });

    const pdfRequestBody = postWithRetryFn.mock.calls[0]?.[1] as {input?: {content?: {filename?: string}[]}[]};
    const binaryRequestBody = postWithRetryFn.mock.calls[1]?.[1] as {input?: {content?: {filename?: string}[]}[]};
    expect(pdfRequestBody.input?.[0]?.content?.[0]?.filename).toBe("attachment.pdf");
    expect(binaryRequestBody.input?.[0]?.content?.[0]?.filename).toBe("attachment.bin");
  });

  test("caps OpenAI calls with the local per-minute limiter", async () => {
    const limitedReadSecretFn = vi.fn((secretName: string) => {
      if ("openai_api_key" === secretName) {
        return "openai-key";
      }

      if ("openai_calls_per_minute" === secretName) {
        return "1";
      }

      throw new Error(`missing ${secretName}`);
    });
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        output_text: "{\"summary\":\"ok\"}",
      },
    });

    await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");
    const skippedResult = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");

    expect(skippedResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping OpenAI test task: local 1/minute rate limit is exhausted.",
    );
  });

  test("caps OpenAI calls with the local per-day limiter", async () => {
    const limitedReadSecretFn = vi.fn((secretName: string) => {
      if ("openai_api_key" === secretName) {
        return "openai-key";
      }

      if ("openai_calls_per_day" === secretName) {
        return "2";
      }

      if ("openai_calls_per_minute" === secretName) {
        return "10";
      }

      throw new Error(`missing ${secretName}`);
    });
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        output_text: "{\"summary\":\"ok\"}",
      },
    });

    await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");
    await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 62_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");
    const skippedResult = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 123_000,
      postWithRetryFn,
      readSecretFn: limitedReadSecretFn,
    }, "test task");

    expect(skippedResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping OpenAI test task: local 2/day rate limit is exhausted.",
    );
  });

  test("activates a shared cooldown after OpenAI rate limiting", async () => {
    const rateLimitError = {
      response: {
        headers: {
          "retry-after": "30",
        },
        status: 429,
      },
    };
    const postWithRetryFn = vi.fn().mockRejectedValue(rateLimitError);

    await expect(callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(rateLimitError);

    const skippedResult = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 2_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task");

    expect(skippedResult).toBeNull();
    expect(postWithRetryFn).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "OpenAI API returned 429; cooling down OpenAI calls for 30s.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping OpenAI test task: API rate-limit cooldown is active for 29s.",
    );
  });

  test("uses default OpenAI cooldown when rate-limit responses omit retry-after", async () => {
    const rateLimitError = {
      response: {
        headers: {},
        status: 429,
      },
    };
    const postWithRetryFn = vi.fn().mockRejectedValue(rateLimitError);

    await expect(callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 10_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(rateLimitError);

    const skippedResult = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 69_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task");

    expect(skippedResult).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "OpenAI API returned 429; cooling down OpenAI calls for 60s.",
    );
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping OpenAI test task: API rate-limit cooldown is active for 1s.",
    );
  });

  test("does not activate OpenAI cooldown for non-rate-limit failures", async () => {
    const serverError = {
      response: {
        headers: {},
        status: 500,
      },
    };
    const postWithRetryFn = vi.fn()
      .mockRejectedValueOnce(serverError)
      .mockResolvedValueOnce({
        data: {
          output_text: "{\"summary\":\"ok\"}",
        },
      });

    await expect(callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 1_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(serverError);
    const result = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 2_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task");

    expect(result).toBe("{\"summary\":\"ok\"}");
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).not.toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("cooling down"),
    );
  });

  test("parses retry-after date headers and returns null for responses without text", async () => {
    const dateRateLimitError = {
      response: {
        headers: {
          "retry-after": new Date(7_000).toUTCString(),
        },
        status: 429,
      },
    };
    const postWithRetryFn = vi.fn()
      .mockRejectedValueOnce(dateRateLimitError)
      .mockResolvedValueOnce({
        data: {
          output: [{
            content: [{
              text: "ignored",
              type: "tool_call",
            }],
          }],
        },
      });

    await expect(callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 2_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task")).rejects.toBe(dateRateLimitError);
    clearOpenAiState();
    const result = await callOpenAiJson("prompt", responseJsonSchema, {
      logger,
      nowMs: () => 8_000,
      postWithRetryFn,
      readSecretFn,
    }, "test task");

    expect(result).toBeNull();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "OpenAI API returned 429; cooling down OpenAI calls for 5s.",
    );
  });
});
