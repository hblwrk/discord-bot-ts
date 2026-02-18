const mockLogger = {
  log: jest.fn(),
};

const mockGetAssets = jest.fn();
const mockReadSecret = jest.fn();
const websocketInstances: any[] = [];
const mockWebSocketConstructor = jest.fn().mockImplementation((urlProvider: (() => string)) => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const wsClient = {
    OPEN: 1,
    readyState: 1,
    addEventListener: jest.fn((eventName: string, handler: (...args: any[]) => unknown) => {
      handlers.set(eventName, handler);
      return wsClient;
    }),
    send: jest.fn(),
    reconnect: jest.fn(),
    url: "function" === typeof urlProvider ? urlProvider() : "wss://streaming.forexpros.com/mock/websocket",
    handlers,
  };

  websocketInstances.push(wsClient);

  return wsClient;
});

const clientInstances: Array<{
  client: any;
  handlers: Map<string, (...args: any[]) => unknown>;
  fetchMember: jest.Mock;
  setNickname: jest.Mock;
}> = [];
const queuedClientIds: string[] = [];

const mockClientConstructor = jest.fn().mockImplementation(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const setNickname = jest.fn().mockResolvedValue(undefined);
  const fetchMember = jest.fn().mockResolvedValue({
    setNickname,
  });
  const clientId = queuedClientIds.shift() ?? "market-bot-client";

  const client = {
    login: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((eventName: string, handler: (...args: any[]) => unknown) => {
      handlers.set(eventName, handler);
      return client;
    }),
    user: {
      id: clientId,
      setPresence: jest.fn(),
    },
    guilds: {
      cache: {
        get: jest.fn(() => ({
          members: {
            fetch: fetchMember,
          },
        })),
      },
    },
  };

  clientInstances.push({client, handlers, fetchMember, setNickname});
  return client;
});

jest.mock("discord.js", () => ({
  Client: mockClientConstructor,
}));

jest.mock("reconnecting-websocket", () => ({
  __esModule: true,
  default: mockWebSocketConstructor,
}));

jest.mock("ws", () => ({
  __esModule: true,
  default: class MockWs {},
}));

jest.mock("./assets.js", () => ({
  getAssets: mockGetAssets,
}));

jest.mock("./logging.js", () => ({
  getLogger: () => mockLogger,
}));

jest.mock("./secrets.js", () => ({
  readSecret: mockReadSecret,
}));

import {updateMarketData} from "./market-data.js";

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("updateMarketData", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    clientInstances.length = 0;
    websocketInstances.length = 0;
    queuedClientIds.length = 0;
    mockReadSecret.mockReturnValue("guild-id");
  });

  test("logs in market-data bot clients and sets default presence on clientReady", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "$",
        unit: "",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();

    expect(mockClientConstructor).toHaveBeenCalledWith({intents: []});
    expect(clientInstances).toHaveLength(1);
    expect(clientInstances[0].client.login).toHaveBeenCalledWith("token-1");

    const readyHandler = clientInstances[0].handlers.get("clientReady");
    expect(readyHandler).toBeDefined();

    readyHandler();

    expect(clientInstances[0].client.user.setPresence).toHaveBeenCalledWith({
      activities: [{name: "Market closed."}],
    });
    expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1);
  });

  test("starts websocket stream once the first market-data bot is ready", async () => {
    queuedClientIds.push("client-1", "client-2");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "",
        unit: "",
        lastUpdate: 0,
      },
      {
        botToken: "token-2",
        botName: "bot-two",
        botClientId: "client-2",
        id: 456,
        decimals: 2,
        order: 2,
        suffix: "",
        unit: "",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();

    const firstReady = clientInstances[0].handlers.get("clientReady");
    const secondReady = clientInstances[1].handlers.get("clientReady");

    firstReady();
    expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1);

    secondReady();
    expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1); // not started twice

    const wsClient = mockWebSocketConstructor.mock.results[0].value;
    expect(wsClient.addEventListener).toHaveBeenCalledWith("open", expect.any(Function));
    expect(wsClient.addEventListener).toHaveBeenCalledWith("close", expect.any(Function));
    expect(wsClient.addEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(wsClient.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });

  test("uses resilient websocket reconnect options and sends subscription payload on open", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "",
        unit: "",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();

    const readyHandler = clientInstances[0].handlers.get("clientReady");
    readyHandler();

    expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1);
    const constructorOptions = mockWebSocketConstructor.mock.calls[0][2];
    expect(constructorOptions.connectionTimeout).toBe(5000);
    expect(constructorOptions.maxRetries).toBe(Number.POSITIVE_INFINITY);
    expect(constructorOptions.minReconnectionDelay).toBe(1000);
    expect(constructorOptions.maxReconnectionDelay).toBe(15_000);

    const wsClient = websocketInstances[0];
    const openHandler = wsClient.handlers.get("open");
    openHandler();

    expect(wsClient.send).toHaveBeenCalledWith(expect.stringContaining("bulk-subscribe"));
    expect(wsClient.send).toHaveBeenCalledWith(expect.stringContaining("pid-123:%%"));
  });

  test("updates nickname and presence from market stream payload", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "$",
        unit: "PCT",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    const readyHandler = clientInstances[0].handlers.get("clientReady");
    readyHandler();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");
    const payload = JSON.stringify({
      pid: 123,
      last_numeric: 100.5,
      pc: 1.2,
      pcp: 1.23,
    });
    const websocketMessage = `a["42::${payload.replaceAll("\"", "\\\"")}"]`;

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledWith("1🟩 100.50$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith({
      activities: [{name: "+1.20 (1.23%)"}],
    });
  });

  test("updates nickname and presence from nested market stream envelope payload", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 1175151,
        decimals: 2,
        order: 1,
        suffix: "$",
        unit: "PCT",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    const readyHandler = clientInstances[0].handlers.get("clientReady");
    readyHandler();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");

    const websocketMessagePayload = {
      message: "pid-1175151::{\"pid\":\"1175151\",\"last_numeric\":24755.8,\"pc\":\"+54.2\",\"pcp\":\"+0.22%\"}",
    };
    const websocketMessage = `a${JSON.stringify([JSON.stringify(websocketMessagePayload)])}`;

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledWith("1🟩 24755.80$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith({
      activities: [{name: "+54.20 (0.22%)"}],
    });
  });

  test("updates nickname and presence when websocket payload is wrapped as a JSON string", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 8849,
        decimals: 2,
        order: 1,
        suffix: "$",
        unit: "PCT",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    const readyHandler = clientInstances[0].handlers.get("clientReady");
    readyHandler();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");

    const websocketMessagePayload = {
      message: "pid-8849::{\"pid\":\"8849\",\"last_numeric\":64.02,\"pc\":\"+1.76\",\"pcp\":\"+2.83%\"}",
    };
    const websocketMessage = JSON.stringify(`a${JSON.stringify([JSON.stringify(websocketMessagePayload)])}`);

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledWith("1🟩 64.02$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith({
      activities: [{name: "+1.76 (2.83%)"}],
    });
  });

  test("updates nickname and presence from websocket envelope objects", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 1175153,
        decimals: 1,
        order: 1,
        suffix: "",
        unit: "PCT",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    const readyHandler = clientInstances[0].handlers.get("clientReady");
    readyHandler();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");

    const websocketMessagePayload = {
      message: "pid-1175153::{\"pid\":\"1175153\",\"last_numeric\":6852.3,\"pc\":\"+9.1\",\"pcp\":\"+0.13%\"}",
    };
    const websocketMessage = `a${JSON.stringify([websocketMessagePayload])}`;

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledWith("1🟩 6852.3");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith({
      activities: [{name: "+9.1 (0.13%)"}],
    });
  });

  test("ignores malformed stream payloads without crashing", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "",
        unit: "PCT",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    clientInstances[0].handlers.get("clientReady")();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");

    messageHandler({
      data: "a[\"this-is-not-json\"]",
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).not.toHaveBeenCalled();
    expect(clientInstances[0].client.user.setPresence).toHaveBeenCalledTimes(1); // default only
  });

  test("logs nickname update failures without rejecting message handler", async () => {
    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "",
        unit: "PCT",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    clientInstances[0].handlers.get("clientReady")();
    clientInstances[0].setNickname.mockRejectedValueOnce(new Error("nick-failed"));

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");
    const payload = JSON.stringify({
      pid: 123,
      last_numeric: 100.0,
      pc: -1.0,
      pcp: -0.5,
    });
    const websocketMessage = `a["42::${payload.replaceAll("\"", "\\\"")}"]`;

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(mockLogger.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error updating market data bot nickname"),
    );
  });

  test("forces reconnect when stream stays stale while socket is open", async () => {
    jest.useFakeTimers();

    queuedClientIds.push("client-1");
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "client-1",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "",
        unit: "PCT",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    clientInstances[0].handlers.get("clientReady")();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");
    messageHandler({data: "o"});
    await flushAsyncWork();

    jest.advanceTimersByTime(360_000);
    expect(wsClient.reconnect).toHaveBeenCalled();
  });
});
