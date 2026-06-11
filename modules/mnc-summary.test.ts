import {Buffer} from "node:buffer";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearAiProviderState} from "./ai-provider.ts";
import {getMncSummary, renderMncSummary, type MncSummaryFields} from "./mnc-summary.ts";

const validFields: MncSummaryFields = {
  marketSetup: [
    "Futures firm ahead of payrolls.",
    "Yields ease as risk appetite improves.",
  ],
  stocksInFocus: [
    "Apple `AAPL` rose on upgrades.",
    "Tesla `TSLA` slipped premarket.",
    "Nvidia `NVDA` led chip gains.",
    "Boeing `BA` climbed on a delivery beat.",
  ],
  watchlist: [
    "Watch the jobs report this morning.",
  ],
};

const validSummaryExpected = [
  "- Futures firm ahead of payrolls.",
  "- Yields ease as risk appetite improves.",
  "",
  "**Stocks in focus**",
  "- Apple `AAPL` rose on upgrades.",
  "- Tesla `TSLA` slipped premarket.",
  "- Nvidia `NVDA` led chip gains.",
  "- Boeing `BA` climbed on a delivery beat.",
  "",
  "**Watchlist**",
  "- Watch the jobs report this morning.",
].join("\n");

function geminiResponse(fields: unknown) {
  return {
    data: {
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify(fields),
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

  test("renders the structured summary and sends the PDF inline with the structured schema", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue(geminiResponse(validFields));

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
        generationConfig: expect.objectContaining({
          responseJsonSchema: expect.objectContaining({
            required: ["marketSetup", "stocksInFocus", "watchlist"],
          }),
        }),
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
              text: expect.stringContaining("three string arrays"),
            }),
          ]),
        })],
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  test("strips stray bullet markers and collapses multi-line entries, dropping non-strings", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue(geminiResponse({
      marketSetup: ["- Futures firm ahead of payrolls.", "* Yields ease\nas risk appetite improves."],
      stocksInFocus: ["• Apple `AAPL` rose on upgrades.", "Tesla `TSLA` slipped premarket.", 42, ""],
      watchlist: ["Watch the jobs report this morning."],
    }));

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBe([
      "- Futures firm ahead of payrolls.",
      "- Yields ease as risk appetite improves.",
      "",
      "**Stocks in focus**",
      "- Apple `AAPL` rose on upgrades.",
      "- Tesla `TSLA` slipped premarket.",
      "",
      "**Watchlist**",
      "- Watch the jobs report this morning.",
    ].join("\n"));
  });

  test("retries once and posts after a first attempt with an empty section", async () => {
    const postWithRetryFn = vi.fn()
      .mockResolvedValueOnce(geminiResponse({
        marketSetup: ["Futures firm ahead of payrolls."],
        stocksInFocus: [],
        watchlist: ["Watch the jobs report this morning."],
      }))
      .mockResolvedValue(geminiResponse(validFields));

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBe(validSummaryExpected);
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        message: expect.stringContaining("a required section is empty"),
        stocks_in_focus_count: 0,
      }),
    );
  });

  test("discards and logs section counts when a section stays empty on every attempt", async () => {
    const postWithRetryFn = vi.fn().mockResolvedValue(geminiResponse({
      marketSetup: ["Futures firm ahead of payrolls."],
      stocksInFocus: ["Apple `AAPL` rose on upgrades."],
      watchlist: [],
    }));

    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn,
      readSecretFn,
    });

    expect(summary).toBeUndefined();
    expect(postWithRetryFn).toHaveBeenCalledTimes(2);
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        message: expect.stringContaining("a required section is empty"),
        market_setup_count: 1,
        stocks_in_focus_count: 1,
        watchlist_count: 0,
      }),
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

  test("returns no summary for AI JSON arrays", async () => {
    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue(geminiResponse([])),
      readSecretFn,
    });

    expect(summary).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI MNC summary returned invalid JSON.",
    );
  });

  test("discards an object that contains none of the expected sections", async () => {
    const summary = await getMncSummary(Buffer.from("pdf-bytes"), {
      logger,
      postWithRetryFn: vi.fn().mockResolvedValue(geminiResponse({summaryMarkdown: "- a\n- b"})),
      readSecretFn,
    });

    expect(summary).toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        market_setup_count: 0,
        stocks_in_focus_count: 0,
        watchlist_count: 0,
      }),
    );
  });
});

describe("MNC summary rendering", () => {
  test("renders the canonical headings and bullets from structured fields", () => {
    expect(renderMncSummary(validFields)).toBe(validSummaryExpected);
  });

  test("normalizes common AI Markdown rendering glitches", () => {
    const summary = renderMncSummary({
      marketSetup: [
        "U.S. futures opened firmer while easing geopolitical तनाव and AI optimism lifted risk appetite.",
        "Gold jumped more than `3%`.",
      ],
      stocksInFocus: [
        "Walt Disney `DIS` beat Q2 EPS/revenue estimates at `$$1.57` / `$$25.2B`, with ~`12%` FY26 EPS growth.",
        "Super Micro Computer `SMCI` forecast Q4 revenue of `$$11B`-`$$12.5B` and adjusted EPS of `65c`-`79c`.",
        "PayPal `PYPL` reported Q1 revenue of `$$8.35B`, targeting `$$1.5B` of savings over `2`-`3` years.",
        "Arm `ARM` guided Q1 revenue to `- $1.26B` vs `- $1.25B` est.",
      ],
      watchlist: [
        "All eyes on `ADP` April payrolls (`99K` expected).",
      ],
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
      "",
      "**Watchlist**",
      "- All eyes on `ADP` April payrolls (`99K` expected).",
    ].join("\n"));
  });

  test("leaves non-metric inline-code pairs untouched", () => {
    const summary = renderMncSummary({
      marketSetup: ["Rotation from `tech`-`energy` continues."],
      stocksInFocus: ["Apple `AAPL` rose on upgrades."],
      watchlist: ["Watch the jobs report this morning."],
    });

    expect(summary).toContain("`tech`-`energy`");
  });

  test("keeps explicit negative metrics on loss bullets", () => {
    const summary = renderMncSummary({
      marketSetup: ["Risk-off tone as yields climb."],
      stocksInFocus: ["Cheniere `LNG` swung to a `-$3.5B` Q1 loss after a `-$4.8B` derivative hit."],
      watchlist: ["Watch energy headlines."],
    });

    expect(summary).toContain("`-$3.5B`");
    expect(summary).toContain("`-$4.8B`");
  });

  test("drops trailing stock/watchlist bullets to fit, keeping every section", () => {
    const longBullet = (prefix: string) => `${prefix} ${"with enough text to push the rendered summary past the Discord budget when every bullet is present. ".repeat(2)}`;
    const summary = renderMncSummary({
      marketSetup: [longBullet("Market is firmer"), longBullet("Yields drift lower")],
      stocksInFocus: Array.from({length: 7}, (_value, index) => longBullet(`Company ${index} moved premarket`)),
      watchlist: [longBullet("Watch Treasury supply"), longBullet("Also monitor energy headlines")],
    });

    expect(summary.length).toBeLessThanOrEqual(1_930);
    expect(summary).toContain("**Stocks in focus**");
    expect(summary).toContain("**Watchlist**");
    expect(summary).not.toContain("\n...");
  });

  test("hard-truncates after a heading boundary when compaction cannot help", () => {
    const hugeStock = (label: string) => `${label} ${"with a great deal of detail that on its own already overflows the entire Discord message budget several times over. ".repeat(15)}`;
    const summary = renderMncSummary({
      marketSetup: ["Market is cautious ahead of CPI.", "Yields tick higher into the print."],
      stocksInFocus: Array.from({length: 4}, (_value, index) => hugeStock(`Company ${index}`)),
      watchlist: ["Watch the CPI release."],
    });

    expect(summary.length).toBeLessThanOrEqual(1_930);
    expect(summary).toMatch(/\n\.\.\.$/);
    // Accumulation stops at the section heading, which is popped as dangling.
    expect(summary).not.toMatch(/\*\*Stocks in focus\*\*$/);
    expect(summary).toContain("- Market is cautious ahead of CPI.");
  });

  test("hard-truncates a single oversized bullet with no usable line break", () => {
    const summary = renderMncSummary({
      marketSetup: ["A long uninterrupted market-setup sentence without section breaks. ".repeat(40)],
      stocksInFocus: ["Apple `AAPL` rose on upgrades."],
      watchlist: ["Watch the jobs report this morning."],
    });

    expect(summary.length).toBeLessThanOrEqual(1_930);
    expect(summary).toMatch(/\n\.\.\.$/);
  });
});
