import {Buffer} from "node:buffer";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearGeminiState} from "./gemini.ts";
import {getMncSummary} from "./mnc-summary.ts";

describe("MNC Gemini summary", () => {
  const logger = {
    log: vi.fn(),
  };
  const readSecretFn = vi.fn((secretName: string) => {
    if ("gemini_api_key" === secretName) {
      return "gemini-key";
    }

    throw new Error(`missing ${secretName}`);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    clearGeminiState();
  });

  test("summarizes the PDF with inline Gemini PDF data", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summaryMarkdown: "**Morning News Call - TL;DR**\n- Futures firm ahead of payrolls.",
              }),
            }],
          },
        }],
      },
    });

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBe("**Morning News Call - TL;DR**\n- Futures firm ahead of payrolls.");
    expect(postWithRetryFn).toHaveBeenCalledWith(
      expect.stringContaining("gemini-2.5-flash-lite:generateContent"),
      expect.objectContaining({
        contents: [{
          parts: [{
            inline_data: {
              data: Buffer.from("pdf-bytes").toString("base64"),
              mime_type: "application/pdf",
            },
          }, {
            text: expect.stringContaining("otherwise format the company name itself as inline code"),
          }],
        }],
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-goog-api-key": "gemini-key",
        }),
      }),
      expect.any(Object),
    );
  });

  test("stays disabled when the Gemini API key is missing", async () => {
    const postWithRetryFn = vi.fn();

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn: vi.fn(() => {
        throw new Error("missing secret");
      }),
    });

    expect(summary).toBeUndefined();
    expect(postWithRetryFn).not.toHaveBeenCalled();
  });

  test("skips inline summaries for oversized PDFs", async () => {
    const postWithRetryFn = vi.fn();

    const summary = await getMncSummary(Buffer.alloc(14_000_001), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBeUndefined();
    expect(postWithRetryFn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Skipping MNC Gemini summary: PDF is too large for inline Gemini processing.",
    );
  });

  test("normalizes markdown fences and truncates long summaries", async () => {
    const longSummary = [
      "```markdown",
      "**Morning News Call - TL;DR**",
      ...Array.from({length: 40}, (_value, index) => `- Market item ${index} with enough text to make the generated summary too long for Discord posting.`),
      "```",
    ].join("\n");
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summaryMarkdown: longSummary,
              }),
            }],
          },
        }],
      },
    });

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBeDefined();
    expect(summary).not.toContain("```");
    expect(summary!.length).toBeLessThanOrEqual(1_700);
    expect(summary).toContain("\n- ...");
  });

  test("returns no summary for invalid Gemini JSON", async () => {
    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: "{not-json",
              }],
            },
          }],
        },
      }),
      readSecretFn,
    });

    expect(summary).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "Gemini MNC summary returned invalid JSON.",
    );
  });
});
