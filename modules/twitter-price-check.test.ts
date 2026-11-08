import {readFileSync} from "node:fs";
import {describe, expect, test, vi} from "vitest";
import {checkTwitterPriceClaims, priceClaimInPost} from "./twitter-price-check.ts";
import type {TwitterPostContext} from "./twitter-sanity-score.ts";

const id = "2109904488639398014";
const createdAt = "Tue Oct 13 07:10:04 +0000 2026";
const text = "Cerebras $CBRS is now down ~58% since its stock market debut, hitting a new 52-week low amid concerns over its OpenAI relationship and an upcoming lockup expiration. Around 19.4M shares are expected to become eligible for sale on Oct. 14.";
const firstTrade = 1_778_765_400;
// Sanitized complete Yahoo daily chart captured for the post's last completed session.
const fixture = JSON.parse(readFileSync(new URL("./test-fixtures/twitter-cbrs-chart-2026-10-12.json", import.meta.url), "utf8")) as {
  chart: {result: [{meta: {symbol: string; longName: string; currency: string; instrumentType: string;
    exchangeTimezoneName: string; firstTradeDate: number}; timestamp: number[];
    indicators: {quote: [{open: number[]; high: number[]; low: number[]; close: number[]}]};
    events?: {splits: Record<string, unknown>}}]; error: null};
};

function post(changes: Partial<TwitterPostContext> = {}): TwitterPostContext {
  return {text, quotedText: "It opened at $350 on day one.", media: [], externalLinks: [],
    authorJoined: "", defaultAvatar: false, authorWebsite: "", createdAt, ...changes};
}

function chart(options: {symbol?: string; instrumentType?: string; lastClose?: number; lastLow?: number;
  firstTradeDate?: number; split?: boolean} = {}) {
  const data = structuredClone(fixture);
  const result = data.chart.result[0];
  const quote = result.indicators.quote[0];
  const last = quote.close.length - 1;
  result.meta.symbol = options.symbol ?? "CBRS";
  result.meta.instrumentType = options.instrumentType ?? "EQUITY";
  result.meta.firstTradeDate = options.firstTradeDate ?? firstTrade;
  if (undefined !== options.lastClose) {
    quote.close[last] = options.lastClose;
    quote.high[last] = Math.max(quote.high[last]!, options.lastClose);
  }
  if (undefined !== options.lastLow) quote.low[last] = options.lastLow;
  if (options.split) result.events = {splits: {"2026-08-01": {numerator: 2, denominator: 1}}};
  return data;
}

function dependencies(data = chart()) {
  return {logger: {log: vi.fn()}, nowMs: () => Date.parse("2026-10-13T08:00:00Z"),
    getWithRetryFn: vi.fn().mockResolvedValue({data})};
}

describe("Twitter stock price check", () => {
  test("selects one ticker and objective price claims without using the quoted post as a claim", () => {
    expect(priceClaimInPost(post())).toEqual({ticker: "CBRS", debutDrop: {percent: 58, approximate: true}, newLow: true});
    expect(priceClaimInPost(post({text: "Cerebras $CBRS may issue shares tomorrow."}))).toBeUndefined();
    expect(priceClaimInPost(post({text: "Cerebras $CBRS and $NVDA are down 58% since debut."}))).toBeUndefined();
    expect(priceClaimInPost(post({text: "Cerebras $CBRS is down 58% since IPO."}))).toBeUndefined();
    expect(priceClaimInPost(post({text: "Cerebras $CBRS is down 58% since its first trading day."})))
      .toEqual({ticker: "CBRS", debutDrop: {percent: 58, approximate: false}, newLow: false});
    expect(priceClaimInPost(post({text: "Cerebras $CBRS is down 58% since its debut."})))
      .toEqual({ticker: "CBRS", debutDrop: {percent: 58, approximate: false}, newLow: false});
  });

  test("checks the reported CBRS drop and new low against completed quotes at post time", async () => {
    const deps = dependencies();
    expect(await checkTwitterPriceClaims(post(), id, deps)).toEqual({verdict: "supported",
      sentence: "The quote shows a 58% fall from the debut open.",
      source: "https://finance.yahoo.com/quote/CBRS/history/"});
    expect(deps.getWithRetryFn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^https:\/\/query1\.finance\.yahoo\.com\/v8\/finance\/chart\/CBRS\?period1=\d+&period2=\d+&interval=1d&includePrePost=false&events=splits$/u),
      expect.objectContaining({maxRedirects: 0, maxContentLength: 750_000, httpsAgent: expect.anything()}),
      {maxAttempts: 1, timeoutMs: 6_000},
    );
  });

  test("does not use a quote for a post with missing or inconsistent time", async () => {
    const deps = dependencies();
    const missingTime = post();
    delete missingTime.createdAt;
    expect(await checkTwitterPriceClaims(missingTime, id, deps)).toBeUndefined();
    expect(await checkTwitterPriceClaims(post({createdAt: "Tue Oct 13 08:10:04 +0000 2026"}), id, deps)).toBeUndefined();
    expect(await checkTwitterPriceClaims(post(), "123", deps)).toBeUndefined();
    expect(deps.getWithRetryFn).not.toHaveBeenCalled();
  });

  test("flags a clear numerical mismatch without claiming that other assertions are false", async () => {
    const deps = dependencies(chart({lastClose: 210, lastLow: 160}));
    expect(await checkTwitterPriceClaims(post(), id, deps)).toMatchObject({verdict: "contradicted",
      sentence: "The quote shows a 40% fall from the debut open."});
  });

  test("identifies a false new-low claim even when the debut decline matches", async () => {
    const data = chart();
    const quote = data.chart.result[0].indicators.quote[0];
    quote.low[quote.low.length - 2] = 140;
    expect(await checkTwitterPriceClaims(post(), id, dependencies(data))).toMatchObject({
      verdict: "contradicted", sentence: "The prior 52-week low was lower.",
    });
  });

  test("rejects a ticker mismatch, non-equity, split or missing first trading day", async () => {
    for (const data of [chart({symbol: "CBRE"}), chart({instrumentType: "ETF"}),
      chart({split: true}), chart({firstTradeDate: firstTrade - 86_400})]) {
      expect(await checkTwitterPriceClaims(post(), id, dependencies(data))).toBeUndefined();
    }
  });

  test("omits stale daily history instead of comparing a missing session", async () => {
    const stale = chart();
    stale.chart.result[0].timestamp.pop();
    const bars = stale.chart.result[0].indicators.quote[0];
    bars.open.pop();
    bars.high.pop();
    bars.low.pop();
    bars.close.pop();
    expect(await checkTwitterPriceClaims(post(), id, dependencies(stale))).toBeUndefined();
  });

  test("omits a 52-week-low verdict when historical sessions are missing", async () => {
    const sparse = chart();
    const result = sparse.chart.result[0];
    const keep = result.timestamp.map((_, index) => index).filter(index => index === 0 || index === result.timestamp.length - 1 || index % 5 !== 0);
    result.timestamp = keep.map(index => result.timestamp[index]!);
    const quote = result.indicators.quote[0];
    for (const key of ["open", "high", "low", "close"] as const) quote[key] = keep.map(index => quote[key][index]!);
    expect(await checkTwitterPriceClaims(post(), id, dependencies(sparse))).toBeUndefined();
  });

  test("requires the first trading day for a recently listed stock's low", async () => {
    const missingDebut = chart();
    const result = missingDebut.chart.result[0];
    result.timestamp.shift();
    const quote = result.indicators.quote[0];
    for (const key of ["open", "high", "low", "close"] as const) quote[key].shift();
    expect(await checkTwitterPriceClaims(post({text: "$CBRS hits a new 52-week low."}), id,
      dependencies(missingDebut))).toBeUndefined();
  });

  test("uses only complete minute bars during a live session", async () => {
    const postedMs = Date.parse("2026-10-12T18:02:00Z");
    const postId = ((BigInt(postedMs - 1_288_834_974_657) << 22n) + 1n).toString();
    const marketOpenMs = Date.parse("2026-10-12T13:30:00Z");
    const timestamps = Array.from({length: 272}, (_, index) => (marketOpenMs + index * 60_000) / 1000);
    const minute = {chart: {result: [{meta: {symbol: "CBRS"},
      timestamp: [...timestamps, (postedMs + 60_000) / 1000],
      indicators: {quote: [{open: [...timestamps.map(() => 148), 100], high: [...timestamps.map(() => 149), 101],
        low: [...timestamps.map((_, index) => index === 271 ? 145.75 : 147), 99],
        close: [...timestamps.map((_, index) => index === 271 ? 146.98 : 148), 100]}]},
    }], error: null}};
    const deps = dependencies();
    deps.nowMs = () => postedMs + 60_000;
    deps.getWithRetryFn.mockImplementation(url => Promise.resolve({data: String(url).includes("interval=1m")
      ? minute : chart({lastClose: 100, lastLow: 99})}));
    expect(await checkTwitterPriceClaims(post({createdAt: new Date(postedMs).toUTCString()}), postId, deps))
      .toMatchObject({verdict: "supported", sentence: "The quote shows a 58% fall from the debut open."});
    expect(deps.getWithRetryFn).toHaveBeenCalledTimes(2);
  });

  test("omits a live low when minute history starts partway through the session", async () => {
    const postedMs = Date.parse("2026-10-12T18:02:00Z");
    const postId = ((BigInt(postedMs - 1_288_834_974_657) << 22n) + 1n).toString();
    const minute = {chart: {result: [{meta: {symbol: "CBRS"},
      timestamp: [(postedMs - 120_000) / 1000, (postedMs - 60_000) / 1000],
      indicators: {quote: [{open: [148, 147], high: [149, 148], low: [147, 145.75], close: [147, 146.98]}]},
    }], error: null}};
    const deps = dependencies();
    deps.nowMs = () => postedMs + 60_000;
    deps.getWithRetryFn.mockImplementation(url => Promise.resolve({data: String(url).includes("interval=1m")
      ? minute : chart()}));
    expect(await checkTwitterPriceClaims(post({createdAt: new Date(postedMs).toUTCString()}), postId, deps))
      .toBeUndefined();
  });
});
