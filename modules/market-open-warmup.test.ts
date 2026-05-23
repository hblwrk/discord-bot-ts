import {beforeEach, describe, expect, test, vi} from "vitest";
import {clearMarketDataSnapshots, recordMarketDataSnapshot} from "./market-data-snapshots.ts";
import {getPremarketWarmupMessage} from "./market-open-warmup.ts";

describe("market open warmup", () => {
  const logger = {
    log: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearMarketDataSnapshots();
  });

  test("generates a sarcastic German pre-market warmup from supplied facts", async () => {
    recordMarketDataSnapshot({
      botClientId: "client-es",
      botName: "S&P500",
      botToken: "token",
      decimals: 2,
      id: 1175153,
      lastUpdate: 0,
      name: "es",
      order: 0,
      suffix: "",
      unit: "PCT",
    }, 5225, 25, 0.48, "investing", new Date("2026-05-07T08:04:00Z"));
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      content: "**Pre-Market Warmup**\n`ES +0,48%` ist wach. Euer Ego darf gern noch im Risikomanagement-Praktikum bleiben.",
    }));

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toBe("**Pre-Market Warmup**\n`ES +0,48%` ist wach. Euer Ego darf gern noch im Risikomanagement-Praktikum bleiben.");
    expect(callAiProviderJsonFn).toHaveBeenCalledWith(
      expect.stringContaining("ein bisschen WallStreetBets"),
      expect.objectContaining({
        required: ["content"],
      }),
      expect.objectContaining({
        logger,
      }),
      "premarket warmup",
      undefined,
      {
        timeoutMs: 30_000,
      },
    );
    const prompt = callAiProviderJsonFn.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("`ES`: `+0,48%` bei `5.225,00`");
    expect(prompt).toContain("Keine Anlageberatung");
    expect(prompt).toContain("Return only JSON");
  });

  test("falls back to a deterministic warmup when AI is unavailable", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(null);

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toBe("**Pre-Market Warmup**\nDer US-Aktien-Premarket ist seit `04:00 US/Eastern` offen. Spreads sind wach, das Ego hoffentlich noch im Bett. Erst Plan, dann Mausklick.");
  });

  test("rejects AI output that is not grounded in the supplied facts", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      content: "Guten Morgen, der Markt macht heute bestimmt irgendwas. Bitte alle maximal dramatisch bleiben.",
    }));

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toContain("`04:00 US/Eastern`");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI premarket warmup rejected: content did not reference a supplied fact.",
    );
  });

  test("rejects AI output that looks like trading advice", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      content: "`04:00 US/Eastern` ist offen, also geht long und betet.",
    }));

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).not.toContain("geht long");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI premarket warmup rejected: content looked like trading advice.",
    );
  });
});
