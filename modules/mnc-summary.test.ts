import {Buffer} from "node:buffer";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {getMncSummary} from "./mnc-summary.ts";

describe("MNC AI summary", () => {
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
    clearAiProviderState();
  });

  test("summarizes the PDF with inline provider PDF data", async () => {
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

    expect(summary).toBe("- Futures firm ahead of payrolls.");
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
            text: expect.stringContaining("start with Company Name `TICKER`"),
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
    expect(postWithRetryFn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        contents: [expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("Do not include a Morning News Call heading"),
            }),
          ]),
        })],
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  test("stays disabled when the active provider API key is missing", async () => {
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
      "Skipping MNC AI summary: PDF is too large for inline provider processing.",
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
    expect(summary).not.toContain("**Morning News Call - TL;DR**");
    expect(summary).not.toContain("📰 **Morning News Call - TL;DR**");
    expect(summary!.length).toBeLessThanOrEqual(1_930);
    expect(summary).toContain("\n...");
    expect(summary).not.toContain("\n- ...");
  });

  test("compacts sectioned summaries before falling back to a hard truncation", async () => {
    const longSectionedSummary = [
      "📰 **Morning News Call - TL;DR**",
      "- Futures are firmer while yields drift lower, with traders waiting for jobs data, services activity, and Fed speakers to reset rate expectations.",
      "- Oil is softer, gold is bid, and the dollar is steady as risk appetite improves without removing the main macro and geopolitical overhangs.",
      "",
      "**Stocks in focus**",
      ...Array.from({length: 7}, (_value, index) => `- Company ${index} \`CMP${index}\` moved premarket after management updated guidance, highlighted margin drivers, and flagged demand trends that could matter for today's sector rotation.`),
      "",
      "**Watchlist**",
      "- Watch Treasury supply, afternoon Fed remarks, and the market reaction to services data for signs that rate-sensitive groups can keep leading.",
      "- Also monitor energy headlines, breadth in megacap technology, and closing auction flows after a busy earnings calendar.",
    ].join("\n");
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summaryMarkdown: longSectionedSummary,
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
    expect(summary!.length).toBeLessThanOrEqual(1_930);
    expect(summary).not.toContain("Morning News Call - TL;DR");
    expect(summary).toContain("**Stocks in focus**");
    expect(summary).toContain("**Watchlist**");
    expect(summary).toContain("Watch Treasury supply");
    expect(summary).not.toContain("\n...");
  });

  test("removes generated Morning News Call headings", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summaryMarkdown: "📰 **Morning News Call - TL;DR**\n- Futures firm ahead of payrolls.",
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

    expect(summary).toBe("- Futures firm ahead of payrolls.");
  });

  test("normalizes common AI Markdown rendering glitches", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summaryMarkdown: [
                  "**Morning News Call - TL;DR**",
                  "- U.S. futures opened firmer while easing geopolitical तनाव and AI optimism lifted risk appetite.",
                  "- Gold jumped more than `3%`.",
                  "",
                  "**Stocks in focus**",
                  "- Walt Disney `DIS` beat Q2 EPS/revenue estimates at `$$1.57` / `$$25.2B`, with ~`12%` FY26 EPS growth.",
                  "- Super Micro Computer `SMCI` forecast Q4 revenue of `$$11B`-`$$12.5B` and adjusted EPS of `65c`-`79c`.",
                  "- PayPal `PYPL` reported Q1 revenue of `$$8.35B`, targeting `$$1.5B` of savings over `2`-`3` years.",
                  "- Arm `ARM` guided Q1 revenue to `- $1.26B` vs `- $1.25B` est.",
                  "- Fortinet `FTNT` raised FY guidance to `-$7.71B`-`$7.87B` revenue and `-$3.10`-`$3.16` EPS.",
                  "- Block `XYZ`: raised full-year gross profit guidance to ` $12.33B` from `$ 12.20B`.",
                  "- CoreWeave `CRWV`: lifted 2026 capex to ` $31B-$35B`; Nvidia `NVDA` is investing up to ` $2.1B`.",
                  "- Cheniere `LNG` swung to a `-$3.5B` Q1 loss after a `-$4.8B` derivative hit.",
                  "",
                  "**Watchlist**",
                  "- All eyes on `ADP` April payrolls (`99K` expected).",
                ].join("\n"),
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

    expect(summary).toBe([
      "- U.S. futures opened firmer while easing geopolitical and AI optimism lifted risk appetite.",
      "- Gold jumped more than `3%`.",
      "",
      "**Stocks in focus**",
      "- Walt Disney `DIS` beat Q2 EPS/revenue estimates at `$1.57` / `$25.2B`, with ~`12%` FY26 EPS growth.",
      "- Super Micro Computer `SMCI` forecast Q4 revenue of `$11B-$12.5B` and adjusted EPS of `65c-79c`.",
      "- PayPal `PYPL` reported Q1 revenue of `$8.35B`, targeting `$1.5B` of savings over `2-3` years.",
      "- Arm `ARM` guided Q1 revenue to `$1.26B` vs `$1.25B` est.",
      "- Fortinet `FTNT` raised FY guidance to `$7.71B-$7.87B` revenue and `$3.10-$3.16` EPS.",
      "- Block `XYZ`: raised full-year gross profit guidance to `$12.33B` from `$12.20B`.",
      "- CoreWeave `CRWV`: lifted 2026 capex to `$31B-$35B`; Nvidia `NVDA` is investing up to `$2.1B`.",
      "- Cheniere `LNG` swung to a `-$3.5B` Q1 loss after a `-$4.8B` derivative hit.",
      "",
      "**Watchlist**",
      "- All eyes on `ADP` April payrolls (`99K` expected).",
    ].join("\n"));
  });

  test("hard-truncates summaries that cannot be compacted or split by line", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summaryMarkdown: "One very long generated line without section breaks. ".repeat(80),
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
    expect(summary!.length).toBeLessThanOrEqual(1_930);
    expect(summary).toMatch(/\n\.\.\.$/);
  });

  test("falls back to line truncation for malformed section summaries", async () => {
    const malformedSectionSummary = [
      "📰 **Morning News Call - TL;DR**",
      "**Stocks in focus**",
      "**Watchlist**",
      "A watchlist paragraph without a bullet. ".repeat(90),
    ].join("\n");
    const postWithRetryFn = vi.fn().mockResolvedValue({
      data: {
        candidates: [{
          content: {
            parts: [{
              text: JSON.stringify({
                summaryMarkdown: malformedSectionSummary,
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
    expect(summary!.length).toBeLessThanOrEqual(1_930);
    expect(summary).toContain("\n...");
  });

  test("returns no summary for invalid AI JSON", async () => {
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
      "AI MNC summary returned invalid JSON.",
    );
  });

  test("returns no summary for missing summaryMarkdown", async () => {
    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({}),
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
      "AI MNC summary response did not contain summaryMarkdown.",
    );
  });

  test("returns no summary for empty normalized summaries", async () => {
    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  summaryMarkdown: "```markdown\n```",
                }),
              }],
            },
          }],
        },
      }),
      readSecretFn,
    });

    expect(summary).toBeUndefined();
  });

  test("returns no summary for AI JSON arrays", async () => {
    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue({
        data: {
          candidates: [{
            content: {
              parts: [{
                text: "[]",
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
      "AI MNC summary returned invalid JSON.",
    );
  });
});
