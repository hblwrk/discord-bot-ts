const readFileSyncMock = jest.fn();
const yamlLoadMock = jest.fn();
const getFromDracoonMock = jest.fn();
const readSecretMock = jest.fn();
const loggerMock = {
  log: jest.fn(),
};

jest.mock("node:fs", () => ({
  __esModule: true,
  default: {
    readFileSync: readFileSyncMock,
  },
}));

jest.mock("js-yaml", () => ({
  __esModule: true,
  default: {
    load: yamlLoadMock,
  },
}));

jest.mock("./dracoon-downloader.js", () => ({
  getFromDracoon: getFromDracoonMock,
}));

jest.mock("./secrets.js", () => ({
  readSecret: readSecretMock,
}));

jest.mock("./logging.js", () => ({
  getLogger: () => loggerMock,
}));

import {getAssets} from "./assets.js";

describe("getAssets", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readFileSyncMock.mockReturnValue("assets-file");
    yamlLoadMock.mockReturnValue([]);
    readSecretMock.mockReturnValue("dracoon-secret");
  });

  test("skips only failing DRACOON assets and continues loading", async () => {
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

    expect(assets).toHaveLength(1);
    expect(assets[0].name).toBe("asset-ok");
    expect(assets[0].fileContent).toEqual(Buffer.from("ok-buffer"));
    expect(getFromDracoonMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Skipping image asset \"asset-fail\""),
    );
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
