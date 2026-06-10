import {describe, expect, test} from "vitest";
import {
  formatMarketCloseTickerFactsForPrompt,
  getTickerFactValidationIssue,
  type MarketCloseTickerFact,
} from "./market-close-ticker-facts.ts";

type Range = {high: number; low: number};

function equityFact(
  symbol: MarketCloseTickerFact["symbol"],
  changePercent: number,
  range?: Range,
  previousClose = 100,
): MarketCloseTickerFact {
  const change = previousClose * (changePercent / 100);
  const base: MarketCloseTickerFact = {
    close: previousClose + change,
    closeChange: change,
    closeChangePercent: changePercent,
    date: "2026-05-07",
    openToCloseChange: change,
    openToCloseChangePercent: changePercent,
    previousClose,
    sourceSymbol: `marketdata:${symbol.toLowerCase()}#1`,
    symbol,
  };
  if (undefined !== range) {
    return {...base, high: range.high, low: range.low};
  }

  return base;
}

function vixFact(pointsChange: number): MarketCloseTickerFact {
  return {
    close: 18 + pointsChange,
    closeChange: pointsChange,
    closeChangePercent: 0,
    date: "2026-05-07",
    openToCloseChange: pointsChange,
    openToCloseChangePercent: 0,
    previousClose: 18,
    sourceSymbol: "marketdata:vix#8884",
    symbol: "VIX",
  };
}

const neutralText = "Neutraler Überblick zum Handelstag.";

describe("market-close-ticker-facts sentiment validation", () => {
  test("accepts Cash on a quiet, rangebound session", () => {
    const facts = [
      equityFact("ES", 0.05),
      equityFact("NQ", -0.03),
      equityFact("RTY", 0.08),
      vixFact(0.1),
    ];
    expect(getTickerFactValidationIssue(neutralText, "Cash", facts)).toBeUndefined();
  });

  test("rejects Cash when at least two indices trend strongly", () => {
    const facts = [
      equityFact("ES", 0.9),
      equityFact("NQ", 0.85),
      equityFact("RTY", 0.2),
      vixFact(-0.5),
    ];
    expect(getTickerFactValidationIssue(neutralText, "Cash", facts)).toBe(
      "poll answer Cash contradicted ticker facts",
    );
  });

  test("rejects Cash when the intraday range is wide despite small net moves", () => {
    const facts = [
      equityFact("ES", 0.1, {high: 101, low: 99}),
      equityFact("NQ", -0.1, {high: 101, low: 99}),
      equityFact("RTY", 0.05),
      vixFact(0.2),
    ];
    expect(getTickerFactValidationIssue(neutralText, "Cash", facts)).toBe(
      "poll answer Cash contradicted ticker facts",
    );
  });

  test("rejects Cash when the VIX jumps hard", () => {
    const facts = [
      equityFact("ES", 0.05),
      equityFact("NQ", -0.02),
      equityFact("RTY", 0.03),
      vixFact(2),
    ];
    expect(getTickerFactValidationIssue(neutralText, "Cash", facts)).toBe(
      "poll answer Cash contradicted ticker facts",
    );
  });

  test("accepts Chaos when moves, range, or VIX show genuine turbulence", () => {
    const facts = [
      equityFact("ES", 0.3),
      equityFact("NQ", -0.4),
      equityFact("RTY", 0.1, {high: 100, low: 100}, 0),
      vixFact(0.5),
    ];
    expect(getTickerFactValidationIssue(neutralText, "Chaos", facts)).toBeUndefined();
  });

  test("rejects Chaos on a dead-flat, uniform session", () => {
    const facts = [
      equityFact("ES", 0.05),
      equityFact("NQ", -0.03),
      equityFact("RTY", 0.02),
      vixFact(0.2),
    ];
    expect(getTickerFactValidationIssue(neutralText, "Chaos", facts)).toBe(
      "poll answer Chaos contradicted ticker facts",
    );
  });

  test("skips sentiment guards when fewer than two equities are available", () => {
    const facts = [equityFact("ES", 1.5), vixFact(0.1)];
    expect(getTickerFactValidationIssue(neutralText, "Cash", facts)).toBeUndefined();
  });
});

describe("market-close-ticker-facts prompt formatting", () => {
  function snapshotFact(symbol: MarketCloseTickerFact["symbol"], range?: Range): MarketCloseTickerFact {
    return {
      ...equityFact(symbol, 0.2, range, 5200),
      dataSource: "market-data-bot",
      marketDataSource: "investing",
      updatedAt: "2026-05-07T20:09:00Z",
    };
  }

  test("returns an empty string without facts", () => {
    expect(formatMarketCloseTickerFactsForPrompt([])).toBe("");
  });

  test("forbids invented ranges when snapshots carry no intraday high or low", () => {
    const prompt = formatMarketCloseTickerFactsForPrompt([snapshotFact("ES")]);
    expect(prompt).toContain("keine Tageshochs und keine Open/High/Low-Spannen");
    expect(prompt).not.toContain("Intraday-Hoch");
  });

  test("surfaces the session range and relaxes the caveat when high and low are present", () => {
    const prompt = formatMarketCloseTickerFactsForPrompt([snapshotFact("ES", {high: 5240, low: 5180})]);
    expect(prompt).toContain("Intraday-Hoch `5.240,00`");
    expect(prompt).toContain("Intraday-Tief `5.180,00`");
    expect(prompt).toContain("Session-Spanne");
    expect(prompt).not.toContain("keine Tageshochs und keine Open/High/Low-Spannen");
  });
});
