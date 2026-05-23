import {beforeEach, describe, expect, test, vi} from "vitest";
const readFileSyncMock = vi.fn();
const yamlLoadMock = vi.fn();
const getFromDracoonMock = vi.fn();
const readSecretMock = vi.fn();
const loggerMock = {
  log: vi.fn(),
};

vi.mock("node:fs", () => ({
  __esModule: true,
  default: {
    readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
  },
}));

vi.mock("js-yaml", () => ({
  __esModule: true,
  default: {
    load: (...args: unknown[]) => yamlLoadMock(...args),
  },
}));

vi.mock("./dracoon-downloader.ts", () => ({
  getFromDracoon: (...args: unknown[]) => getFromDracoonMock(...args),
}));

vi.mock("./secrets.ts", () => ({
  readSecret: (...args: unknown[]) => readSecretMock(...args),
}));

vi.mock("./logging.ts", () => ({
  getLogger: () => ({
    log: (...args: unknown[]) => loggerMock.log(...args),
  }),
}));

import {
  EmojiAsset,
  getAssetByName,
  getAssetPromptReferences,
  getAssets,
  getGenericAssets,
  getMarketDataAssetConfigs,
  MarketDataAsset,
} from "./assets.ts";

describe("getAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFileSyncMock.mockReturnValue("assets-file");
    yamlLoadMock.mockReturnValue([]);
    readSecretMock.mockReturnValue("dracoon-secret");
  });

  test("keeps failing DRACOON assets as unavailable and logs warning", async () => {
    yamlLoadMock.mockReturnValue([
      {
        fileName: "ok.png",
        location: "dracoon",
        locationId: "ok-id",
        name: "asset-ok",
        title: "ok",
        trigger: ["ok"],
      },
      {
        fileName: "fail.png",
        location: "dracoon",
        locationId: "fail-id",
        name: "asset-fail",
        title: "fail",
        trigger: ["fail"],
      },
    ]);
    getFromDracoonMock
      .mockResolvedValueOnce(Buffer.from("ok-buffer"))
      .mockRejectedValueOnce(new Error("download failed"));

    const assets = await getAssets("image");

    expect(assets).toHaveLength(2);
    const [successfulAsset, failedAsset] = assets;
    expect(successfulAsset).toBeDefined();
    expect(failedAsset).toBeDefined();
    expect(successfulAsset?.name).toBe("asset-ok");
    expect(successfulAsset?.fileContent).toEqual(Buffer.from("ok-buffer"));
    expect(failedAsset?.name).toBe("asset-fail");
    expect(failedAsset?.fileContent).toBeUndefined();
    expect(getFromDracoonMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Failed to download image asset \"asset-fail\""),
    );
  });

  test("loads calendar reminder assets and resolves role references", async () => {
    yamlLoadMock.mockReturnValue([
      {
        name: "us-cpi-1h",
        eventNameSubstrings: ["consumer price index", "cpi"],
        countryFlags: ["🇺🇸"],
        roleIdReference: "hblwrk_role_special_alerts_ID",
        minutesBefore: 60,
      },
    ]);
    readSecretMock.mockImplementation(secretName => {
      if ("hblwrk_role_special_alerts_ID" === secretName) {
        return "role-123";
      }

      return "dracoon-secret";
    });

    const assets = await getAssets("calendarreminder");

    expect(assets).toHaveLength(1);
    const [asset] = assets;
    expect(asset).toBeDefined();
    expect(asset?.name).toBe("us-cpi-1h");
    expect(asset?.eventNameSubstrings).toEqual(["consumer price index", "cpi"]);
    expect(asset?.countryFlags).toEqual(["🇺🇸"]);
    expect(asset?.minutesBefore).toBe(60);
    expect(asset?.roleIdReference).toBe("hblwrk_role_special_alerts_ID");
    expect(asset?.roleId).toBe("role-123");
  });

  test("loads earnings reminder assets and resolves role references", async () => {
    yamlLoadMock.mockReturnValue([
      {
        name: "aapl-earnings",
        tickerSymbols: ["AAPL"],
        roleIdReference: "hblwrk_role_special_alerts_ID",
      },
    ]);
    readSecretMock.mockImplementation(secretName => {
      if ("hblwrk_role_special_alerts_ID" === secretName) {
        return "role-456";
      }

      return "dracoon-secret";
    });

    const assets = await getAssets("earningsreminder");

    expect(assets).toHaveLength(1);
    const [asset] = assets;
    expect(asset).toBeDefined();
    expect(asset?.name).toBe("aapl-earnings");
    expect(asset?.tickerSymbols).toEqual(["AAPL"]);
    expect(asset?.roleIdReference).toBe("hblwrk_role_special_alerts_ID");
    expect(asset?.roleId).toBe("role-456");
  });

  test("loads market-data, role, and paywall assets with secret references resolved", async () => {
    const yamlObjectsByType: Record<string, unknown[]> = {
      marketdata: [{
        botTokenReference: "market_token_ref",
        botClientIdReference: "market_client_ref",
        botName: "SPX",
        id: 1175151,
        suffix: "$",
        unit: "PCT",
        marketHours: "crypto",
        tastytradeStreamerSymbol: "BTC/USD",
        decimals: 2,
        order: 1,
      }],
      role: [{
        triggerReference: "role_trigger_ref",
        idReference: "role_id_ref",
        emoji: "✅",
      }],
      paywall: [{
        name: "default",
        domains: ["*"],
        services: ["archive.today"],
        nofix: false,
        subdomainWildcard: true,
      }],
    };
    readFileSyncMock.mockImplementation(path => String(path));
    yamlLoadMock.mockImplementation(filePath => {
      const match = /assets\/(.+)\.yaml/.exec(String(filePath));
      const type = match?.[1] ?? "";
      return yamlObjectsByType[type] ?? [];
    });
    readSecretMock.mockImplementation(secretName => {
      if ("market_token_ref" === secretName) {
        return "market-token";
      }

      if ("market_client_ref" === secretName) {
        return "market-client-id";
      }

      if ("role_trigger_ref" === secretName) {
        return "role-message-id";
      }

      if ("role_id_ref" === secretName) {
        return "role-id";
      }

      return "dracoon-secret";
    });

    const [marketAsset] = await getAssets("marketdata");
    const [roleAsset] = await getAssets("role");
    const [paywallAsset] = await getAssets("paywall");

    expect(marketAsset?.botToken).toBe("market-token");
    expect(marketAsset?.botClientId).toBe("market-client-id");
    expect(marketAsset?.marketHours).toBe("crypto");
    expect(marketAsset?.tastytradeStreamerSymbol).toBe("BTC/USD");
    expect(roleAsset?.trigger).toEqual(["role-message-id"]);
    expect(roleAsset?.id).toBe("role-id");
    expect(paywallAsset?.name).toBe("default");
    expect(paywallAsset?.domains).toEqual(["*"]);
    expect(paywallAsset?.services).toEqual(["archive.today"]);
    expect(paywallAsset?.subdomainWildcard).toBe(true);
  });

  test("skips market-data assets with missing secrets without dropping valid assets", async () => {
    yamlLoadMock.mockReturnValue([{
      botTokenReference: "es_token_ref",
      botClientIdReference: "es_client_ref",
      botName: "S&P500",
      name: "es",
    }, {
      botTokenReference: "cl_token_ref",
      botClientIdReference: "cl_client_ref",
      botName: "CL/USD",
      name: "cl",
    }]);
    readSecretMock.mockImplementation(secretName => {
      if ("es_token_ref" === secretName) {
        return "es-token";
      }

      if ("es_client_ref" === secretName) {
        return "es-client-id";
      }

      throw new Error(`missing ${secretName}`);
    });

    const assets = await getAssets("marketdata");

    expect(assets).toHaveLength(1);
    expect(assets[0]?.name).toBe("es");
    expect(assets[0]?.botToken).toBe("es-token");
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Skipping market data asset \"cl\""),
    );
  });

  test("logs stable fallback names when skipping market-data assets with missing secrets", async () => {
    yamlLoadMock.mockReturnValue([{
      botTokenReference: "cl_token_ref",
      botClientIdReference: "cl_client_ref",
      botName: "CL/USD",
    }, {
      botTokenReference: "missing_token_ref",
      botClientIdReference: "missing_client_ref",
    }]);
    readSecretMock.mockImplementation(secretName => {
      throw new Error(`missing ${secretName}`);
    });

    const assets = await getAssets("marketdata");

    expect(assets).toEqual([]);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Skipping market data asset \"CL/USD\""),
    );
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Skipping market data asset \"unknown\""),
    );
  });

  test("loads market-data configs without resolving bot secrets", () => {
    yamlLoadMock.mockReturnValue([{
      botTokenReference: "es_token_ref",
      botClientIdReference: "es_client_ref",
      botName: "S&P500",
      id: 1175153,
      name: "es",
    }]);

    const assets = getMarketDataAssetConfigs();

    expect(assets).toHaveLength(1);
    expect(assets[0]?.name).toBe("es");
    expect(assets[0]?.botName).toBe("S&P500");
    expect(readSecretMock).not.toHaveBeenCalled();
  });

  test("loads lightweight prompt references from image and text asset configs", () => {
    const yamlObjectsByType: Record<string, unknown[]> = {
      image: [{
        fileName: "stoploss.png",
        name: "stoploss",
        title: "Stop loss...",
        trigger: ["stoploss"],
      }],
      text: [{
        name: "eingepreist",
        response: "Alles ist eingepreist.",
        title: "Eingepreist",
        trigger: "eingepreist",
      }],
    };
    readFileSyncMock.mockImplementation(path => String(path));
    yamlLoadMock.mockImplementation(filePath => {
      const match = /assets\/(.+)\.yaml/.exec(String(filePath));
      const type = match?.[1] ?? "";
      return yamlObjectsByType[type] ?? [];
    });

    const references = getAssetPromptReferences();

    expect(references).toEqual([{
      name: "stoploss",
      response: undefined,
      title: "Stop loss...",
      triggers: ["stoploss"],
      type: "image",
    }, {
      name: "eingepreist",
      response: "Alles ist eingepreist.",
      title: "Eingepreist",
      triggers: ["eingepreist"],
      type: "text",
    }]);
  });

  test("normalizes loose prompt reference config without resolving Dracoon content", () => {
    const yamlObjectsByType: Record<string, unknown[]> = {
      image: [
        null,
        {
          fileName: "margin.png",
          text: "Margin meme caption",
          title: " ",
          trigger: ["margin", 123],
        },
      ],
      text: [{
        response: " ",
        title: " ",
        trigger: false,
      }],
    };
    readFileSyncMock.mockImplementation(path => String(path));
    yamlLoadMock.mockImplementation(filePath => {
      const match = /assets\/(.+)\.yaml/.exec(String(filePath));
      const type = match?.[1] ?? "";
      return yamlObjectsByType[type] ?? [];
    });

    const references = getAssetPromptReferences();

    expect(references).toEqual([{
      name: "margin.png",
      response: "Margin meme caption",
      title: "",
      triggers: ["margin"],
      type: "image",
    }, {
      name: "unknown",
      response: undefined,
      title: "",
      triggers: [],
      type: "text",
    }]);
    expect(getFromDracoonMock).not.toHaveBeenCalled();
  });

  test("skips unavailable prompt reference files independently", () => {
    readFileSyncMock.mockImplementation(path => {
      if (String(path).includes("image.yaml")) {
        throw new Error("missing image refs");
      }

      return String(path);
    });
    yamlLoadMock.mockReturnValue([{
      name: "eingepreist",
      response: "Alles ist eingepreist.",
      title: "Eingepreist",
      trigger: ["eingepreist"],
    }]);

    const references = getAssetPromptReferences();

    expect(references).toEqual([expect.objectContaining({
      name: "eingepreist",
      type: "text",
    })]);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Error loading image asset prompt references"),
    );
  });

  test("returns empty market-data configs when config loading fails", () => {
    yamlLoadMock.mockImplementation(() => {
      throw new Error("yaml failure");
    });

    const assets = getMarketDataAssetConfigs();

    expect(assets).toEqual([]);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error creating market data asset configs"),
    );
  });

  test("loads whatis assets through the DRACOON image path", async () => {
    yamlLoadMock.mockReturnValue([
      {
        fileName: "faq.png",
        location: "dracoon",
        locationId: "faq-id",
        name: "whatis_faq",
        title: "FAQ",
        trigger: ["faq"],
      },
    ]);
    getFromDracoonMock.mockResolvedValue(Buffer.from("faq-buffer"));

    const assets = await getAssets("whatis");

    expect(assets).toHaveLength(1);
    expect(assets[0]?.name).toBe("whatis_faq");
    expect(assets[0]?.fileContent).toEqual(Buffer.from("faq-buffer"));
    expect(getFromDracoonMock).toHaveBeenCalledWith("dracoon-secret", "faq-id");
  });

  test("ignores unknown asset types", async () => {
    yamlLoadMock.mockReturnValue([{name: "unknown"}]);

    await expect(getAssets("unknown")).resolves.toEqual([]);
  });

  test("normalizes market data streaming config values", () => {
    const marketDataAsset = new MarketDataAsset();

    marketDataAsset.marketHours = "crypto";
    marketDataAsset.tastytradeStreamerSymbol = " BTC/USD ";

    expect(marketDataAsset.marketHours).toBe("crypto");
    expect(marketDataAsset.tastytradeStreamerSymbol).toBe("BTC/USD");

    marketDataAsset.marketHours = "unsupported";

    expect(marketDataAsset.marketHours).toBeUndefined();
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      "Ignoring unsupported market data hours profile: unsupported",
    );
  });

  test("loads generic assets across all generic asset files", async () => {
    const yamlObjectsByType: Record<string, unknown[]> = {
      emoji: [{
        name: "party",
        response: "🎉",
        trigger: "party",
      }],
      image: [{
        fileName: "chart.png",
        location: "local",
        name: "chart",
        trigger: ["chart"],
      }],
      text: [{
        name: "hello",
        response: "hello response",
        title: "hello",
        trigger: ["hello"],
      }],
      user: [{
        name: "alice",
        title: "Alice",
        trigger: ["alice"],
      }],
      userquote: [{
        fileName: "quote.png",
        location: "local",
        name: "quote",
        trigger: [],
        user: "alice",
      }],
    };
    readFileSyncMock.mockImplementation(path => String(path));
    yamlLoadMock.mockImplementation(filePath => {
      const match = /assets\/(.+)\.yaml/.exec(String(filePath));
      const type = match?.[1] ?? "";
      return yamlObjectsByType[type] ?? [];
    });

    const assets = await getGenericAssets();

    expect(assets.map(asset => asset.name)).toEqual([
      "party",
      "chart",
      "hello",
      "alice",
      "quote",
    ]);
    const emojiAsset = assets[0];
    expect(emojiAsset).toBeInstanceOf(EmojiAsset);
    expect(emojiAsset?.trigger).toEqual(["party"]);
    expect(emojiAsset instanceof EmojiAsset ? emojiAsset.response : []).toEqual(["🎉"]);
  });

  test("normalizes trigger and emoji response values from loose asset config", () => {
    const emojiAsset = new EmojiAsset();

    emojiAsset.trigger = ["party", 123, "charts", null];
    emojiAsset.response = ["🎉", false, "📈"];

    expect(emojiAsset.trigger).toEqual(["party", "charts"]);
    expect(emojiAsset.response).toEqual(["🎉", "📈"]);

    emojiAsset.trigger = "single";
    emojiAsset.response = "✅";

    expect(emojiAsset.trigger).toEqual(["single"]);
    expect(emojiAsset.response).toEqual(["✅"]);

    emojiAsset.trigger = false;
    emojiAsset.response = false;

    expect(emojiAsset.trigger).toEqual([]);
    expect(emojiAsset.response).toEqual([]);
  });

  test("finds assets by exact name", () => {
    const matchingAsset = {name: "match"};
    const otherAsset = {name: "other"};

    expect(getAssetByName("match", [otherAsset, matchingAsset])).toBe(matchingAsset);
    expect(getAssetByName("missing", [otherAsset, matchingAsset])).toBeUndefined();
  });

  test("returns empty array when loading assets fails", async () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error("read failure");
    });

    const assets = await getAssets("image");

    expect(assets).toEqual([]);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error creating assets"),
    );
  });
});
