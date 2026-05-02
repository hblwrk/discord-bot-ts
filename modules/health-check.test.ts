import type {Mock, MockedFunction} from "vitest";
import type {StartupStateSnapshot} from "./startup-state.ts";
import {runHealthCheck} from "./health-check.ts";
import {afterAll, beforeEach, describe, expect, test, vi} from "vitest";

const {
  mockCreateServer,
  mockExpress,
  mockListen,
  mockLogger,
  mockOn,
  mockRouteHandlers,
} = vi.hoisted(() => {
  const mockRouteHandlers = new Map<string, (...args: unknown[]) => unknown>();
  const mockAppUse = vi.fn();
  const mockRouterUse = vi.fn();
  const mockRouterGet = vi.fn((path: string, handler: (...args: unknown[]) => unknown) => {
    mockRouteHandlers.set(path, handler);
  });
  const mockListen = vi.fn();
  const mockOn = vi.fn();
  const mockCreateServer = vi.fn(() => ({
    on: mockOn,
    listen: mockListen,
  }));
  const mockExpress = vi.fn(() => ({
    use: mockAppUse,
  }));
  (mockExpress as Mock & {Router: Mock}).Router = vi.fn(() => ({
    use: mockRouterUse,
    get: mockRouterGet,
  }));
  const mockLogger = {
    log: vi.fn(),
  };

  return {
    mockCreateServer,
    mockExpress,
    mockListen,
    mockLogger,
    mockOn,
    mockRouteHandlers,
  };
});

vi.mock("express", () => {
  return {
    __esModule: true,
    default: mockExpress,
  };
});

vi.mock("node:http", () => {
  return {
    __esModule: true,
    default: {
      createServer: mockCreateServer,
    },
  };
});

const originalHealthcheckPort = process.env["HEALTHCHECK_PORT"];

function createState(partial: Partial<StartupStateSnapshot> = {}): StartupStateSnapshot {
  return {
    alive: true,
    ready: false,
    discordLoggedIn: false,
    handlersAttached: false,
    remoteWarmupStatus: "idle",
    lastError: null,
    startedAt: "2026-02-18T00:00:00.000Z",
    readyAt: null,
    phaseDurationsMs: {},
    warmupTasks: {},
    ...partial,
  };
}

type TestResponse = {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  header: MockedFunction<(key: string, value: string) => TestResponse>;
  status: MockedFunction<(statusCode: number) => TestResponse>;
  send: MockedFunction<(body: unknown) => TestResponse>;
  json: MockedFunction<(body: unknown) => TestResponse>;
};

function createResponse() {
  const response = {} as TestResponse;
  response.statusCode = 200;
  response.body = undefined;
  response.headers = {};
  response.header = vi.fn((key: string, value: string) => {
    response.headers[key] = value;
    return response;
  });
  response.status = vi.fn((statusCode: number) => {
    response.statusCode = statusCode;
    return response;
  });
  response.send = vi.fn((body: unknown) => {
    response.body = body;
    return response;
  });
  response.json = vi.fn((body: unknown) => {
    response.body = body;
    return response;
  });

  return response;
}

describe("runHealthCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouteHandlers.clear();
    delete process.env["HEALTHCHECK_PORT"];
  });

  afterAll(() => {
    if ("undefined" === typeof originalHealthcheckPort) {
      delete process.env["HEALTHCHECK_PORT"];
      return;
    }

    process.env["HEALTHCHECK_PORT"] = originalHealthcheckPort;
  });

  test("registers liveness endpoint and binds localhost listener", () => {
    runHealthCheck(() => createState(), mockLogger);

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(mockListen).toHaveBeenCalledWith(11312, "127.0.0.1");

    const healthHandler = mockRouteHandlers.get("/health");
    expect(healthHandler).toBeDefined();
    const response = createResponse();
    healthHandler?.({}, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("stonks");
  });

  test("binds listener on default healthcheck port", () => {
    runHealthCheck(() => createState(), mockLogger);

    expect(mockListen).toHaveBeenCalledWith(11312, "127.0.0.1");
  });

  test("binds listener on configured healthcheck port", () => {
    process.env["HEALTHCHECK_PORT"] = "12000";
    runHealthCheck(() => createState(), mockLogger);

    expect(mockListen).toHaveBeenCalledWith(12000, "127.0.0.1");
  });

  test("falls back to default healthcheck port for invalid environment value", () => {
    process.env["HEALTHCHECK_PORT"] = "abc";
    runHealthCheck(() => createState(), mockLogger);

    expect(mockListen).toHaveBeenCalledWith(11312, "127.0.0.1");
  });

  test("returns readiness state depending on discord login and handler attachment", () => {
    let startupState = createState();
    runHealthCheck(() => startupState, mockLogger);

    const readyHandler = mockRouteHandlers.get("/ready");
    expect(readyHandler).toBeDefined();

    const notReadyResponse = createResponse();
    readyHandler?.({}, notReadyResponse);
    expect(notReadyResponse.statusCode).toBe(503);
    expect(notReadyResponse.body).toEqual({
      ready: false,
      discordLoggedIn: false,
      handlersAttached: false,
    });

    startupState = createState({
      ready: true,
      discordLoggedIn: true,
      handlersAttached: true,
      readyAt: "2026-02-18T00:00:05.000Z",
    });
    const readyResponse = createResponse();
    readyHandler?.({}, readyResponse);
    expect(readyResponse.statusCode).toBe(200);
    expect(readyResponse.body).toEqual({
      ready: true,
      discordLoggedIn: true,
      handlersAttached: true,
    });
  });

  test("returns startup diagnostics snapshot", () => {
    const snapshot = createState({
      remoteWarmupStatus: "degraded",
      lastError: "timeout",
      phaseDurationsMs: {
        "phase-a": 1234,
      },
      warmupTasks: {
        tickers: "failed",
      },
    });
    runHealthCheck(() => snapshot, mockLogger);

    const startupHandler = mockRouteHandlers.get("/startup");
    expect(startupHandler).toBeDefined();
    const response = createResponse();
    startupHandler?.({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(snapshot);
  });

  test("logs listener errors when binding fails", () => {
    runHealthCheck(() => createState(), mockLogger);

    const errorHandler = mockOn.mock.calls.find(call => "error" === call[0])?.[1] as ((error: Error) => void) | undefined;
    expect(errorHandler).toEqual(expect.any(Function));

    const bindError = Object.assign(
      new Error("listen EADDRINUSE: address already in use 127.0.0.1:11312"),
      {
        code: "EADDRINUSE",
      },
    );
    errorHandler?.(bindError);

    expect(mockLogger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        startup_phase: "health",
        bind_host: "127.0.0.1",
        bind_port: 11312,
        error_code: "EADDRINUSE",
        error_message: "listen EADDRINUSE: address already in use 127.0.0.1:11312",
        message: "Health-check server failed to bind.",
      }),
    );
  });

  test("normalizes non-Error listener failures", () => {
    runHealthCheck(() => createState(), mockLogger);

    const errorHandler = mockOn.mock.calls.find(call => "error" === call[0])?.[1] as ((error: unknown) => void) | undefined;
    errorHandler?.("plain failure");

    expect(mockLogger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        error_code: "UNKNOWN",
        error_message: "plain failure",
      }),
    );

    const codedError = Object.assign(new Error("numeric code"), {code: 123});
    errorHandler?.(codedError);

    expect(mockLogger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        error_code: "UNKNOWN",
        error_message: "numeric code",
      }),
    );
  });
});
