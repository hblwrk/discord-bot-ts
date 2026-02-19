const formatMock = jest.fn();
const tzMock = jest.fn();
const getWithRetryMock = jest.fn();
const loggerMock = {
  log: jest.fn(),
};

jest.mock("moment-timezone", () => ({
  __esModule: true,
  default: {
    tz: tzMock,
  },
}));

jest.mock("./http-retry.js", () => ({
  getWithRetry: getWithRetryMock,
}));

jest.mock("./logging.js", () => ({
  getLogger: () => loggerMock,
}));

import {getMnc} from "./mnc-downloader.js";

describe("getMnc", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    formatMock.mockReturnValue("01022024");
    tzMock.mockReturnValue({
      format: formatMock,
    });
  });

  test("builds the date-based MNC URL and returns a Buffer", async () => {
    getWithRetryMock.mockResolvedValue({
      data: "pdf-binary",
    });

    const result = await getMnc();

    expect(tzMock).toHaveBeenCalledWith("Europe/Berlin");
    expect(formatMock).toHaveBeenCalledWith("MMDDYYYY");
    expect(getWithRetryMock).toHaveBeenCalledWith(
      "https://share.refinitiv.com/assets/newsletters/Morning_News_Call/MNCGeneric_US_01022024.pdf",
      {
        responseType: "arraybuffer",
      },
    );
    expect(result).toEqual(Buffer.from("pdf-binary", "binary"));
  });

  test("logs and returns undefined when loading fails", async () => {
    getWithRetryMock.mockRejectedValue(new Error("download failed"));

    const result = await getMnc();

    expect(result).toBeUndefined();
    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Loading MNC failed:"),
    );
  });
});
