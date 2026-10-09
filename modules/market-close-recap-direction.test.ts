import {beforeEach, describe, expect, test, vi} from "vitest";
import {callAiProviderJson} from "./ai-provider.ts";
import {getMarketCloseRecap} from "./market-close-recap.ts";
import {type MarketCloseTickerFact} from "./market-close-ticker-facts.ts";

vi.mock("./ai-provider.ts", () => ({callAiProviderJson: vi.fn()}));

const changes: [MarketCloseTickerFact["symbol"], number][] = [
  ["ES", 0.60], ["NQ", 0.51], ["RTY", 0.47], ["VIX", -0.49],
];
const tickerFacts: MarketCloseTickerFact[] = changes.map(([symbol, change]) => ({
  symbol,
  close: 100 + change,
  previousClose: 100,
  closeChange: change,
  closeChangePercent: change,
  dataSource: "market-data-bot",
  date: "2026-10-08",
  sourceSymbol: "test",
}));

const badSummary = "`NQ` fiel am stärksten. Die Bot-Werte: `ES` `+0,60%`, `NQ` `+0,51%`, `RTY` `+0,47%`. Der `VIX` fiel um `0,49 Punkte`.";
const goodSummary = "`ES`, `NQ` und `RTY` legten zu. Der `VIX` fiel um `0,49 Punkte`.";
const response = (summaryMarkdown: string) => JSON.stringify({
  summaryMarkdown,
  sentimentTitle: "Positiver Handelstag",
  winningPollAnswer: "Risk-on",
});

describe("market close recap direction retries", () => {
  beforeEach(() => {
    vi.mocked(callAiProviderJson).mockReset();
  });

  test("retries a contradictory narrative even when numbers and sentiment are consistent", async () => {
    vi.mocked(callAiProviderJson)
      .mockResolvedValueOnce(response(badSummary))
      .mockResolvedValueOnce(response(goodSummary));
    const logger = {log: vi.fn()};
    const recap = await getMarketCloseRecap(undefined, {logger}, {tickerFacts});

    expect(recap?.content).toContain(goodSummary);
    expect(recap?.content).toContain("**🟢 Risk-on**");
    expect(recap?.content).not.toContain("fiel am stärksten");
    expect(callAiProviderJson).toHaveBeenCalledTimes(2);
    expect(vi.mocked(callAiProviderJson).mock.calls[1]?.[0]).toContain(
      "Align the summary and winningPollAnswer with the verified ticker facts: output direction contradicted ticker facts for NQ.",
    );
    expect(vi.mocked(callAiProviderJson).mock.calls[0]?.[0]).toContain("High/Low belegen eine Spanne, aber keinen zeitlichen Verlauf");
  });

  test("suppresses the recap and voter lookups when all attempts contradict facts", async () => {
    vi.mocked(callAiProviderJson).mockResolvedValue(response(badSummary));
    const fetch = vi.fn();
    const logger = {log: vi.fn()};
    const pollMessage = {poll: {answers: [{id: 1, text: "Risk-on", voters: {fetch}}]}};
    const recap = await getMarketCloseRecap(pollMessage, {logger}, {tickerFacts});

    expect(recap).toBeUndefined();
    expect(callAiProviderJson).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenLastCalledWith(
      "warn", "AI market close recap contradicted ticker facts: output direction contradicted ticker facts for NQ.",
    );
  });
});
