const getMock = jest.fn();
const postMock = jest.fn();
const isAxiosErrorMock = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: {
    get: getMock,
    post: postMock,
    isAxiosError: isAxiosErrorMock,
  },
}));

import {getWithRetry, postWithRetry} from "./http-retry.js";

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

describe("http-retry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    isAxiosErrorMock.mockImplementation(error => true === Boolean(error?.isAxiosError));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("getWithRetry succeeds on first attempt and applies default timeout", async () => {
    getMock.mockResolvedValue({data: {ok: true}});

    const response = await getWithRetry("https://example.com");

    expect(response).toEqual({data: {ok: true}});
    expect(getMock).toHaveBeenCalledWith("https://example.com", {timeout: 10_000});
  });

  test("getWithRetry preserves explicit timeout from request config", async () => {
    getMock.mockResolvedValue({data: {ok: true}});

    await getWithRetry("https://example.com", {timeout: 1_234});

    expect(getMock).toHaveBeenCalledWith("https://example.com", {timeout: 1_234});
  });

  test("getWithRetry retries on retryable status and succeeds", async () => {
    getMock
      .mockRejectedValueOnce(createAxiosError(500))
      .mockResolvedValueOnce({data: {ok: true}});

    const responsePromise = getWithRetry("https://example.com", undefined, {
      maxAttempts: 2,
      retryDelayMs: 10,
    });

    await Promise.resolve();
    expect(getMock).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(10);
    const response = await responsePromise;

    expect(response).toEqual({data: {ok: true}});
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  test("getWithRetry retries when status is unavailable", async () => {
    getMock
      .mockRejectedValueOnce(createAxiosError())
      .mockResolvedValueOnce({data: {ok: true}});

    const responsePromise = getWithRetry("https://example.com", undefined, {
      maxAttempts: 2,
      retryDelayMs: 5,
    });

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(5);

    await expect(responsePromise).resolves.toEqual({data: {ok: true}});
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  test("getWithRetry does not retry non-retryable axios errors", async () => {
    const error = createAxiosError(400);
    getMock.mockRejectedValue(error);

    await expect(getWithRetry("https://example.com", undefined, {
      maxAttempts: 3,
      retryDelayMs: 10,
    })).rejects.toBe(error);

    expect(getMock).toHaveBeenCalledTimes(1);
  });

  test("getWithRetry does not retry non-axios errors", async () => {
    const error = new Error("boom");
    getMock.mockRejectedValue(error);

    await expect(getWithRetry("https://example.com", undefined, {
      maxAttempts: 3,
      retryDelayMs: 10,
    })).rejects.toBe(error);

    expect(getMock).toHaveBeenCalledTimes(1);
  });

  test("postWithRetry succeeds on first attempt", async () => {
    postMock.mockResolvedValue({data: {ok: true}});

    const response = await postWithRetry("https://example.com", {x: 1}, {headers: {a: "b"}});

    expect(response).toEqual({data: {ok: true}});
    expect(postMock).toHaveBeenCalledWith(
      "https://example.com",
      {x: 1},
      {headers: {a: "b"}, timeout: 10_000},
    );
  });

  test("postWithRetry retries on retryable errors and throws last error after max attempts", async () => {
    const firstError = createAxiosError(429);
    const secondError = createAxiosError(503);
    postMock
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError);

    const responsePromise = postWithRetry("https://example.com", {x: 1}, undefined, {
      maxAttempts: 2,
      retryDelayMs: 20,
    });
    const expectation = expect(responsePromise).rejects.toBe(secondError);

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(20);

    await expectation;
    expect(postMock).toHaveBeenCalledTimes(2);
  });
});
