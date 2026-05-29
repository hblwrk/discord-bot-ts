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
      assetPromptReferences: [{
        name: "stoploss",
        title: "Stop loss...",
        triggers: ["stoploss"],
        type: "image",
      }, {
        name: "eingepreist",
        response: "Alles, was du dir vorstellen kannst, ist bereits eingepreist.",
        title: "Eingepreist",
        triggers: ["eingepreist"],
        type: "text",
      }, {
        name: "mittagsessen",
        response: "Heute gibt es Suppe.",
        title: "Nicht Trading",
        triggers: ["suppe"],
        type: "text",
      }, {
        name: "margin-long",
        response: "Margin ".repeat(30),
        title: "Margin mit sehr langem Text",
        triggers: ["margin"],
        type: "text",
      }],
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
    expect(prompt).toContain("Marktampel: `Gelb`");
    expect(prompt).toContain("Community-Tropen aus vorhandenen Bot-Texten und Meme-Assets");
    expect(prompt).toContain("image-Asset stoploss - Stop loss...");
    expect(prompt).toContain("text-Asset eingepreist - Eingepreist");
    expect(prompt).toContain("text-Asset margin-long - Margin mit sehr langem Text");
    expect(prompt).toContain("Text-Trope: Margin Margin");
    expect(prompt).toContain("...");
    expect(prompt).not.toContain("Heute gibt es Suppe");
    expect(prompt).toContain("Stilqualitaet");
    expect(prompt).toContain("Variiere Aufbau und Pointe");
    expect(prompt).toContain("Kein Schlagwort-Stapel");
    expect(prompt).toContain("Keine Anlageberatung");
    expect(prompt).toContain("Nutze hoechstens einen Community-Trope");
    expect(prompt).toContain("Return only JSON");
  });

  test("loads image and text asset style references by default", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      content: "`04:00 US/Eastern` ist offen. Marktampel `Gelb`, Casino offen, bitte erst denken und dann klicken.",
    }));

    await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    const prompt = callAiProviderJsonFn.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("Community-Tropen aus vorhandenen Bot-Texten und Meme-Assets");
    expect(prompt).toContain("image-Asset");
    expect(prompt).toContain("text-Asset");
  });

  test("falls back to a deterministic warmup when AI is unavailable", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(null);

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toBe("**Pre-Market Warmup**\nDer US-Aktien-Premarket ist seit `04:00 US/Eastern` offen. Die Marktampel steht auf `Gelb`. Casino ist offen, Spreads sind wach, das Ego hoffentlich noch im Bett. Erst Plan, dann klicken.");
  });

  test("falls back with the fact-derived Marktampel", async () => {
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
    recordMarketDataSnapshot({
      botClientId: "client-nq",
      botName: "Nasdaq",
      botToken: "token",
      decimals: 2,
      id: 1175151,
      lastUpdate: 0,
      name: "nq",
      order: 1,
      suffix: "",
      unit: "PCT",
    }, 18750, 90, 0.48, "investing", new Date("2026-05-07T08:04:00Z"));
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(null);

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toContain("Die Marktampel steht auf `Gruen`.");
    expect(message).toContain("Casino ist offen");
  });

  test("falls back with a red Marktampel when futures and VIX are stressed", async () => {
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
    }, 5225, -28, -0.54, "investing", new Date("2026-05-07T08:04:00Z"));
    recordMarketDataSnapshot({
      botClientId: "client-nq",
      botName: "Nasdaq",
      botToken: "token",
      decimals: 2,
      id: 1175151,
      lastUpdate: 0,
      name: "nq",
      order: 1,
      suffix: "",
      unit: "PCT",
    }, 18750, -120, -0.64, "investing", new Date("2026-05-07T08:04:00Z"));
    recordMarketDataSnapshot({
      botClientId: "client-vix",
      botName: "VIX",
      botToken: "token",
      decimals: 2,
      id: 44336,
      lastUpdate: 0,
      name: "vix",
      order: 3,
      suffix: "",
      unit: "POINTS",
    }, 18.4, 0.5, 2.79, "investing", new Date("2026-05-07T08:04:00Z"));
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(null);

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toContain("`ES -0,54%`");
    expect(message).toContain("Die Marktampel steht auf `Rot`.");
  });

  test("formats VIX snapshot facts for the warmup fallback", async () => {
    recordMarketDataSnapshot({
      botClientId: "client-vix",
      botName: "VIX",
      botToken: "token",
      decimals: 2,
      id: 44336,
      lastUpdate: 0,
      name: "vix",
      order: 3,
      suffix: "",
      unit: "POINTS",
    }, 16.2, -0.5, -2.99, "investing", new Date("2026-05-07T08:04:00Z"));
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(null);

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toContain("`VIX -0,50 Punkte` steht bei `16,20`.");
    expect(message).toContain("Die Marktampel steht auf `Gelb`.");
  });

  test("rejects AI output that is not grounded in the supplied facts", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      content: "Guten Morgen, der Markt macht heute bestimmt irgendwas. Bitte alle maximal dramatisch bleiben.",
    }));

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toContain("`04:00 US/Eastern`");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI premarket warmup rejected: content did not reference a supplied fact.",
    );
  });

  test("retries rejected AI output with validation feedback", async () => {
    const callAiProviderJsonFn = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        content: "Guten Morgen, der Markt macht heute bestimmt irgendwas. Bitte alle maximal dramatisch bleiben.",
      }))
      .mockResolvedValueOnce(JSON.stringify({
        content: "`04:00 US/Eastern` ist offen. Marktampel `Gelb`; erst Plan, dann Klickfinger.",
      }));

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).toBe("`04:00 US/Eastern` ist offen. Marktampel `Gelb`; erst Plan, dann Klickfinger.");
    expect(callAiProviderJsonFn).toHaveBeenCalledTimes(2);
    const retryPrompt = callAiProviderJsonFn.mock.calls[1]?.[0] ?? "";
    expect(retryPrompt).toContain("Previous response failed local validation.");
    expect(retryPrompt).toContain("Fix this validation issue: content did not reference a supplied fact.");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("AI premarket warmup rejected: content did not reference a supplied fact. Retrying with validation feedback:"),
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
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).not.toContain("geht long");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI premarket warmup rejected: content looked like trading advice.",
    );
  });

  test("rejects AI output that leaks asset implementation details", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      content: "`04:00 US/Eastern` und die Asset-Liste sagt Casino.",
    }));

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).not.toContain("Asset-Liste");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI premarket warmup rejected: content mentioned implementation details.",
    );
  });

  test("rejects AI output that stacks meme keywords mechanically", async () => {
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      content: "`04:00 US/Eastern` ist offen. FOMO + 0DTE klingt wieder nach Risikomanagement.",
    }));

    const message = await getPremarketWarmupMessage({
      callAiProviderJsonFn,
      logger,
    }, {
      assetPromptReferences: [],
      referenceTime: new Date("2026-05-07T08:05:00Z"),
    });

    expect(message).not.toContain("FOMO + 0DTE");
    expect(logger.log).toHaveBeenCalledWith(
      "warn",
      "AI premarket warmup rejected: content stacked meme keywords mechanically.",
    );
  });
});
