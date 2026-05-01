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

import {getAssets} from "./assets.ts";

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
