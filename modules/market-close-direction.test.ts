import {describe, expect, test} from "vitest";
import {getMarketCloseDirectionValidationIssue} from "./market-close-direction.ts";
import {getTickerFactValidationIssue, type MarketCloseTickerFact} from "./market-close-ticker-facts.ts";

function fact(symbol: MarketCloseTickerFact["symbol"], change: number): MarketCloseTickerFact {
  return {
    symbol,
    close: 100 + change,
    previousClose: 100,
    closeChange: change,
    closeChangePercent: change,
    dataSource: "market-data-bot",
    date: "2026-10-08",
    sourceSymbol: "test",
  };
}

const positiveFacts = [fact("ES", 0.60), fact("NQ", 0.51), fact("RTY", 0.47), fact("VIX", -0.49)];

describe("market close direction validation", () => {
  test("rejects the reported recap even though its Risk-on label fits the facts", () => {
    const text = [
      "US-Aktien beendeten den Tag **gemischt bis klar schwächer**: `NQ` fiel am stärksten, `RTY` und `ES` hielten sich relativ besser, aber ohne echte Breite.",
      "Die bot-seitigen Sessionwerte zeigen: `ES` `+0,60%`, `NQ` `+0,51%`, `RTY` `+0,47%` — dazu ein ruhigerer `VIX` bei `17,13` nach `17,62` (`-0,49 Punkte`).",
    ].join("\n");
    expect(getTickerFactValidationIssue(text, "Risk-on", positiveFacts)).toBe(
      "output market direction contradicted ticker facts",
    );
  });

  test.each([
    "`NQ` fiel am stärksten.",
    "`NQ` sank deutlich.",
    "`NQ` verlor an Boden.",
    "`NQ` gab nach.",
    "`NQ` schloss schwächer.",
    "`NQ` beendete den Tag im Minus.",
    "Schwächer schloss `NQ`.",
    "`NQ` closed lower.",
    "`NQ` fell.",
    "`ES` stieg, während `NQ` fiel.",
    "`ES` stieg; `NQ` fiel.",
    "`ES` stieg. `NQ` fiel.",
    "`ES` legte zu: `NQ` fiel.",
    "`ES` und `NQ` fielen.",
    "`ES` fiel\n`NQ` stieg.",
  ])("rejects bearish net claims with positive returns: %s", text => {
    expect(getMarketCloseDirectionValidationIssue(text, positiveFacts)).toMatch(
      /^output direction contradicted ticker facts for (?:ES|NQ)$/u,
    );
  });

  test.each([
    "`ES` stieg.",
    "`ES` schloss höher.",
    "Höher schloss `ES`.",
    "`ES` gewann.",
    "`ES` legte zu.",
    "`ES` rose.",
  ])("rejects bullish net claims with negative returns: %s", text => {
    expect(getMarketCloseDirectionValidationIssue(text, [fact("ES", -0.6)])).toBe(
      "output direction contradicted ticker facts for ES",
    );
  });

  test.each([
    "`ES` und `NQ` stiegen. `RTY` schloss fester, der `VIX` fiel.",
    "`ES` stieg während `VIX` fiel.",
    "`ES` stieg `VIX` fiel.",
    "`ES` `+0,60%`, `NQ` `+0,51%`, `RTY` `+0,47%` — `VIX` fiel.",
    "US-Aktien beendeten den Tag höher.",
    "`NQ` hielt sich relativ schwächer als `ES`.",
    "`NQ` fiel nicht.",
    "`NQ` schloss nicht schwächer.",
    "`NQ` ist nicht gefallen.",
    "`NQ` fiel zwischenzeitlich.",
    "Intraday fiel `NQ` vom Hoch.",
    "`NQ` fiel zunächst.",
    "`NQ` gab vom Tageshoch nach.",
  ])("accepts compatible or explicitly intraday claims: %s", text => {
    expect(getMarketCloseDirectionValidationIssue(text, positiveFacts)).toBeUndefined();
  });

  test("checks closing claims even when the clause mentions intraday action", () => {
    expect(getMarketCloseDirectionValidationIssue("Nach Intraday-Stärke schloss `NQ` tiefer.", positiveFacts)).toBe(
      "output direction contradicted ticker facts for NQ",
    );
  });

  test("keeps grouped subjects attached to their shared direction", () => {
    expect(getMarketCloseDirectionValidationIssue("`ES` und `NQ` stiegen.", [fact("ES", -0.6), fact("NQ", 0.5)])).toBe(
      "output direction contradicted ticker facts for ES",
    );
  });

  test("accepts opposite directions in a mixed market", () => {
    const facts = [fact("ES", 0.6), fact("NQ", -0.5), fact("VIX", 0.4)];
    expect(getMarketCloseDirectionValidationIssue("`ES` stieg, `NQ` fiel, `VIX` stieg.", facts)).toBeUndefined();
    expect(getMarketCloseDirectionValidationIssue("US-Aktien schlossen schwächer.", facts)).toBeUndefined();
  });

  test("validates VIX direction in both directions", () => {
    expect(getMarketCloseDirectionValidationIssue("Der `VIX` stieg.", positiveFacts)).toBe(
      "output direction contradicted ticker facts for VIX",
    );
    expect(getMarketCloseDirectionValidationIssue("Der `VIX` fiel.", [fact("VIX", 0.49)])).toBe(
      "output direction contradicted ticker facts for VIX",
    );
  });

  test("uses daily change by default and open-to-close only for an explicit open baseline", () => {
    const facts = [{...fact("ES", 0.6), openToCloseChangePercent: -0.5}];
    expect(getMarketCloseDirectionValidationIssue("`ES` fiel.", facts)).toBe(
      "output direction contradicted ticker facts for ES",
    );
    expect(getMarketCloseDirectionValidationIssue("`ES` fiel vom Open.", facts)).toBeUndefined();
    expect(getMarketCloseDirectionValidationIssue("`ES` stieg vom Open.", facts)).toBe(
      "output direction contradicted ticker facts for ES",
    );
    expect(getMarketCloseDirectionValidationIssue("`ES` fiel vom Open.", positiveFacts)).toBeUndefined();
  });

  test("does not infer contradictions for tiny moves or missing tickers", () => {
    expect(getMarketCloseDirectionValidationIssue("`ES` fiel.", [fact("ES", 0.05)])).toBeUndefined();
    expect(getMarketCloseDirectionValidationIssue("`NQ` fiel.", [fact("ES", 0.6)])).toBeUndefined();
    expect(getMarketCloseDirectionValidationIssue("US-Aktien schlossen schwächer.", [fact("ES", 0.6)])).toBeUndefined();
    expect(getMarketCloseDirectionValidationIssue("`NQ` fiel.", [])).toBeUndefined();
  });
});
