import {Buffer} from "node:buffer";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {formatMncSummary, getMncSummary, isStructurallyValidMncSummary} from "./mnc-summary.ts";

const validSummaryMarkdown = [
  "**Morning News Call - TL;DR**",
  "- Futures firm ahead of payrolls.",
  "- Yields ease as risk appetite improves.",
  "",
  "**Stocks in focus**",
  "- Apple `AAPL` rose on upgrades.",
  "- Tesla `TSLA` slipped premarket.",
  "- Nvidia `NVDA` led chip gains.",
  "",
  "**Watchlist**",
  "- Watch the jobs report this morning.",
].join("\n");

const validSummaryExpected = [
  "- Futures firm ahead of payrolls.",
  "- Yields ease as risk appetite improves.",
  "",
  "**Stocks in focus**",
  "- Apple `AAPL` rose on upgrades.",
  "- Tesla `TSLA` slipped premarket.",
  "- Nvidia `NVDA` led chip gains.",
  "",
  "**Watchlist**",
  "- Watch the jobs report this morning.",
].join("\n");

// Reproduces the production incident: the model lost the deal value, leaked a
// self-correction into the answer, and never produced the section headings.
const malformedSummaryMarkdown = [
  "**Morning News Call - TL;DR**",
  "- Futures firm ahead of payrolls.",
  "- Berkshire Hathaway: agreed to buy Taylor Morrison Home for -? Wait",
].join("\n");

function geminiResponse(summaryMarkdown: string) {
  return {
    data: {
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({summaryMarkdown}),
          }],
        },
      }],
    },
  };
}

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
    const postWithRetryFn = vi.fn().mockResolvedValue(geminiResponse(validSummaryMarkdown));

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBe(validSummaryExpected);
    expect(postWithRetryFn).toHaveBeenCalledTimes(1);
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

  test("retries once and posts a valid summary after a malformed first attempt", async () => {
    const postWithRetryFn = vi.fn()
      .mockResolvedValueOnce(geminiResponse(malformedSummaryMarkdown))
      .mockResolvedValue(geminiResponse(validSummaryMarkdown));

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBe(validSummaryExpected);
    expect(summary).not.toContain("Wait");
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Discarding malformed AI MNC summary"),
    );
  });

  test("discards the summary when every attempt is malformed", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue(geminiResponse(malformedSummaryMarkdown));

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBeUndefined();
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Discarding malformed AI MNC summary"),
    );
  });

  test("rejects summaries with too few bullets even when both headings are present", async () => {
    const thinSummaryMarkdown = [
      "**Morning News Call - TL;DR**",
      "- Futures firm ahead of payrolls.",
      "",
      "**Stocks in focus**",
      "- Apple `AAPL` rose on upgrades.",
      "- Tesla `TSLA` slipped premarket.",
      "",
      "**Watchlist**",
      "- Watch the jobs report this morning.",
    ].join("\n");
    const postWithRetryFn = vi.fn().mockResolvedValue(geminiResponse(thinSummaryMarkdown));

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBeUndefined();
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
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

describe("MNC summary structural validation", () => {
  const validBody = [
    "- Futures firm ahead of payrolls.",
    "- Yields ease as risk appetite improves.",
    "",
    "**Stocks in focus**",
    "- Apple `AAPL` rose on upgrades.",
    "- Tesla `TSLA` slipped premarket.",
    "",
    "**Watchlist**",
    "- Watch the jobs report this morning.",
  ].join("\n");

  test("accepts a summary with both section headings and enough bullets", () => {
    expect(isStructurallyValidMncSummary(validBody)).toBe(true);
  });

  test("rejects a summary missing the stocks heading", () => {
    const body = validBody.replace("**Stocks in focus**\n", "");
    expect(isStructurallyValidMncSummary(body)).toBe(false);
  });

  test("rejects a summary missing the watchlist heading", () => {
    const body = validBody.replace("**Watchlist**\n", "");
    expect(isStructurallyValidMncSummary(body)).toBe(false);
  });

  test("rejects a summary with too few bullets", () => {
    const body = [
      "- Futures firm ahead of payrolls.",
      "",
      "**Stocks in focus**",
      "- Apple `AAPL` rose on upgrades.",
      "",
      "**Watchlist**",
      "- Watch the jobs report this morning.",
    ].join("\n");
    expect(isStructurallyValidMncSummary(body)).toBe(false);
  });
});

describe("MNC summary formatting", () => {
  test("normalizes markdown fences and truncates long summaries", () => {
    const longSummary = [
      "```markdown",
      "**Morning News Call - TL;DR**",
      ...Array.from({length: 40}, (_value, index) => `- Market item ${index} with enough text to make the generated summary too long for Discord posting.`),
      "```",
    ].join("\n");

    const summary = formatMncSummary(longSummary);

    expect(summary).not.toContain("```");
    expect(summary).not.toContain("**Morning News Call - TL;DR**");
    expect(summary).not.toContain("📰 **Morning News Call - TL;DR**");
    expect(summary.length).toBeLessThanOrEqual(1_930);
    expect(summary).toContain("\n...");
    expect(summary).not.toContain("\n- ...");
  });

  test("compacts sectioned summaries before falling back to a hard truncation", () => {
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

    const summary = formatMncSummary(longSectionedSummary);

    expect(summary.length).toBeLessThanOrEqual(1_930);
    expect(summary).not.toContain("Morning News Call - TL;DR");
    expect(summary).toContain("**Stocks in focus**");
    expect(summary).toContain("**Watchlist**");
    expect(summary).toContain("Watch Treasury supply");
    expect(summary).not.toContain("\n...");
  });

  test("removes generated Morning News Call headings", () => {
    expect(formatMncSummary("📰 **Morning News Call - TL;DR**\n- Futures firm ahead of payrolls."))
      .toBe("- Futures firm ahead of payrolls.");
  });

  test("normalizes common AI Markdown rendering glitches", () => {
    const summary = formatMncSummary([
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
    ].join("\n"));

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

  test("hard-truncates summaries that cannot be compacted or split by line", () => {
    const summary = formatMncSummary("One very long generated line without section breaks. ".repeat(80));

    expect(summary.length).toBeLessThanOrEqual(1_930);
    expect(summary).toMatch(/\n\.\.\.$/);
  });

  test("falls back to line truncation for malformed section summaries", () => {
    const malformedSectionSummary = [
      "📰 **Morning News Call - TL;DR**",
      "**Stocks in focus**",
      "**Watchlist**",
      "A watchlist paragraph without a bullet. ".repeat(90),
    ].join("\n");

    const summary = formatMncSummary(malformedSectionSummary);

    expect(summary.length).toBeLessThanOrEqual(1_930);
    expect(summary).toContain("\n...");
  });
});
