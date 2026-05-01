import {beforeEach, describe, expect, test, vi} from "vitest";
const formatMock = vi.fn();
const tzMock = vi.fn();
const getWithRetryMock = vi.fn();
const loggerMock = {
  log: vi.fn(),
};

vi.mock("moment-timezone", () => ({
  __esModule: true,
  default: {
    tz: (...args: unknown[]) => tzMock(...args),
  },
}));

vi.mock("./http-retry.ts", () => ({
  getWithRetry: (...args: unknown[]) => getWithRetryMock(...args),
}));

vi.mock("./logging.ts", () => ({
  getLogger: () => ({
    log: (...args: unknown[]) => loggerMock.log(...args),
  }),
}));

import {getMnc} from "./mnc-downloader.ts";

describe("getMnc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
