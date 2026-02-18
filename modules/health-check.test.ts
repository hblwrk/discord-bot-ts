type StartupStateSnapshot = import("./startup-state.js").StartupStateSnapshot;

var mockRouteHandlers: Map<string, (...args: unknown[]) => unknown>;
var mockAppUse: jest.Mock;
var mockRouterUse: jest.Mock;
var mockRouterGet: jest.Mock;
var mockListen: jest.Mock;
var mockCreateServer: jest.Mock;

jest.mock("express", () => {
  mockRouteHandlers = new Map<string, (...args: unknown[]) => unknown>();
  mockAppUse = jest.fn();
  mockRouterUse = jest.fn();
  mockRouterGet = jest.fn((path: string, handler: (...args: unknown[]) => unknown) => {
    mockRouteHandlers.set(path, handler);
  });

  const mockExpress = jest.fn(() => ({
    use: mockAppUse,
  }));
  (mockExpress as any).Router = jest.fn(() => ({
    use: mockRouterUse,
    get: mockRouterGet,
  }));

  return {
    __esModule: true,
    default: mockExpress,
  };
});

jest.mock("node:http", () => {
  mockListen = jest.fn();
  mockCreateServer = jest.fn(() => ({
    listen: mockListen,
  }));

  return {
    __esModule: true,
    default: {
      createServer: mockCreateServer,
    },
  };
});

jest.mock("./secrets.js", () => ({
  readSecret: jest.fn(() => "11312"),
}));

const {runHealthCheck} = require("./health-check.js");
const {readSecret} = require("./secrets.js");
const mockReadSecret = readSecret as jest.MockedFunction<typeof readSecret>;

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

function createResponse() {
  const response = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
    header: jest.fn((key: string, value: string) => {
      response.headers[key] = value;
      return response;
    }),
    status: jest.fn((statusCode: number) => {
      response.statusCode = statusCode;
      return response;
    }),
    send: jest.fn((body: any) => {
      response.body = body;
      return response;
    }),
    json: jest.fn((body: any) => {
      response.body = body;
      return response;
    }),
  };

  return response;
}

describe("runHealthCheck", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteHandlers.clear();
    mockReadSecret.mockReturnValue("11312");
  });

  test("registers liveness endpoint and binds network listener", () => {
    runHealthCheck(() => createState());

    expect(mockReadSecret).toHaveBeenCalledWith("healthcheck_port");
    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    expect(mockListen).toHaveBeenCalledWith(11312, "0.0.0.0");

    const healthHandler = mockRouteHandlers.get("/health");
    expect(healthHandler).toBeDefined();
    const response = createResponse();
    healthHandler?.({}, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("stonks");
  });

  test("falls back to default port when healthcheck secret is missing", () => {
    mockReadSecret.mockImplementation(() => {
      throw new Error("Missing secret \"healthcheck_port\"");
    });

    runHealthCheck(() => createState());

    expect(mockListen).toHaveBeenCalledWith(11312, "0.0.0.0");
  });

  test("returns readiness state depending on discord login and handler attachment", () => {
    let startupState = createState();
    runHealthCheck(() => startupState);

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
    runHealthCheck(() => snapshot);

    const startupHandler = mockRouteHandlers.get("/startup");
    expect(startupHandler).toBeDefined();
    const response = createResponse();
    startupHandler?.({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(snapshot);
  });
});
