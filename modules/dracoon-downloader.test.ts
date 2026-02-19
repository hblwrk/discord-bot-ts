const postMock = jest.fn();
const getMock = jest.fn();
const isAxiosErrorMock = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    post: postMock,
    get: getMock,
    isAxiosError: isAxiosErrorMock,
  },
}));

import {getFromDracoon} from "./dracoon-downloader.js";

type MockAxiosError = {
  isAxiosError: boolean;
  response?: {
    status: number;
  };
};

function createAxiosError(status?: number): MockAxiosError {
  if (undefined === status) {
    return {isAxiosError: true};
  }

  return {
    isAxiosError: true,
    response: {
      status,
    },
  };
}

describe("getFromDracoon", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    isAxiosErrorMock.mockImplementation(error => true === Boolean(error?.isAxiosError));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("posts for download URL, fetches binary, and returns a Buffer", async () => {
    postMock.mockResolvedValue({
      data: {
        downloadUrl: "https://download.example/file",
      },
    });
    getMock.mockResolvedValue({
      data: "binary-data",
    });

    const result = await getFromDracoon("secret", "token");

    expect(postMock).toHaveBeenCalledWith(
      "https://dracoon.team/api/v4/public/shares/downloads/token",
      JSON.stringify({password: "secret"}),
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      },
    );
    expect(getMock).toHaveBeenCalledWith("https://download.example/file", {
      responseType: "arraybuffer",
      timeout: 10_000,
    });
    expect(result).toEqual(Buffer.from("binary-data", "binary"));
  });

  test("retries on retryable errors with increasing delay", async () => {
    postMock
      .mockRejectedValueOnce(createAxiosError(429))
      .mockRejectedValueOnce(createAxiosError(500))
      .mockResolvedValueOnce({
        data: {
          downloadUrl: "https://download.example/file",
        },
      });
    getMock.mockResolvedValue({
      data: "ok",
    });

    const resultPromise = getFromDracoon("secret", "token");

    await Promise.resolve();
    expect(postMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(500);
    expect(postMock).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1000);
    await expect(resultPromise).resolves.toEqual(Buffer.from("ok", "binary"));
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  test("does not retry non-retryable errors", async () => {
    const error = createAxiosError(400);
    postMock.mockRejectedValue(error);

    await expect(getFromDracoon("secret", "token")).rejects.toBe(error);
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  test("throws last error after max attempts", async () => {
    const error = createAxiosError(503);
    postMock.mockRejectedValue(error);

    const resultPromise = getFromDracoon("secret", "token");
    const expectation = expect(resultPromise).rejects.toBe(error);

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(500);
    await jest.advanceTimersByTimeAsync(1000);

    await expectation;
    expect(postMock).toHaveBeenCalledTimes(3);
  });
});
