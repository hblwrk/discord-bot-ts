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

const marketOpenReferenceTime = new Date("2026-03-12T15:00:00.000Z");
const marketClosedReferenceTime = new Date("2026-03-12T21:00:00.000Z");

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function advanceFakeTime(durationMs: number) {
  await jest.advanceTimersByTimeAsync(durationMs);
}

function buildSocketIoMarketMessage(payload: Record<string, unknown>) {
  return `a["42::${JSON.stringify(payload).replaceAll("\"", "\\\"")}"]`;
}

function buildPresencePayload(name: string, status: "dnd" | "invisible" | "online") {
  return {
    activities: [{name}],
    status,
  };
}

describe("updateMarketData", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(marketOpenReferenceTime);
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

    expect(clientInstances[0].client.user.setPresence).toHaveBeenCalledWith(
      buildPresencePayload("Market closed.", "invisible"),
    );
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
    const websocketMessage = buildSocketIoMarketMessage({
      pid: 123,
      last_numeric: 100.5,
      pc: 1.2,
      pcp: 1.23,
    });

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledWith("1🟩 100.50$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("+1.20 (1.23%)", "online"),
    );
    expect(mockLogger.log).toHaveBeenCalledWith(
      "debug",
      expect.objectContaining({
        message: "market-data:stream-received",
        bot_name: "bot-one",
        bot_client_id: "client-1",
        market_data_pid: 123,
        bot_ready: true,
        nickname: "1🟩 100.50$",
        presence: "+1.20 (1.23%)",
        last_numeric: 100.5,
        price_change: 1.2,
        percentage_change: 1.23,
      }),
    );
    expect(mockLogger.log).toHaveBeenCalledWith(
      "debug",
      expect.objectContaining({
        message: "market-data:update-applied",
        source: "stream-flush",
        bot_name: "bot-one",
        bot_client_id: "client-1",
        market_data_pid: 123,
        nickname: "1🟩 100.50$",
        presence: "+1.20 (1.23%)",
        presence_status: "online",
        last_numeric: 100.5,
        price_change: 1.2,
        percentage_change: 1.23,
      }),
    );
  });

  test("flushes queued market updates after the cooldown even without another tick", async () => {
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
    clientInstances[0].handlers.get("clientReady")();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");

    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 100.5,
        pc: 1.2,
        pcp: 1.23,
      }),
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledTimes(1);
    expect(clientInstances[0].setNickname).toHaveBeenLastCalledWith("1🟩 100.50$");

    await advanceFakeTime(5000);
    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 101.5,
        pc: 2.2,
        pcp: 2.23,
      }),
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledTimes(1);
    expect(clientInstances[0].client.user.setPresence).toHaveBeenCalledTimes(2);

    await advanceFakeTime(9000);
    await flushAsyncWork();
    expect(clientInstances[0].setNickname).toHaveBeenCalledTimes(1);

    await advanceFakeTime(1000);
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledTimes(2);
    expect(clientInstances[0].setNickname).toHaveBeenLastCalledWith("1🟩 101.50$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("+2.20 (2.23%)", "online"),
    );
  });

  test("keeps only the newest queued market update during the cooldown", async () => {
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
    clientInstances[0].handlers.get("clientReady")();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");

    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 100.5,
        pc: 1.2,
        pcp: 1.23,
      }),
    });
    await flushAsyncWork();

    await advanceFakeTime(5000);
    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 101.5,
        pc: 2.2,
        pcp: 2.23,
      }),
    });
    await flushAsyncWork();

    await advanceFakeTime(5000);
    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 102.5,
        pc: 3.2,
        pcp: 3.23,
      }),
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledTimes(1);

    await advanceFakeTime(5000);
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenCalledTimes(2);
    expect(clientInstances[0].setNickname).toHaveBeenLastCalledWith("1🟩 102.50$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("+3.20 (3.23%)", "online"),
    );
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
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("+54.20 (0.22%)", "online"),
    );
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
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("+1.76 (2.83%)", "online"),
    );
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
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("+9.1 (0.13%)", "online"),
    );
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

  test("ignores comment stream payloads without logging parse warnings", async () => {
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
    const commentPayload = {
      message: "cmt-1-5-945629::{\"ID\":\"46266029\",\"commentContent\":\"test\"}",
    };
    const websocketMessage = `a${JSON.stringify([JSON.stringify(commentPayload)])}`;

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).not.toHaveBeenCalled();
    expect(mockLogger.log).not.toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Ignoring unparseable market data payload"),
    );
    expect(mockLogger.log).not.toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error updating market data bot"),
    );
  });

  test("logs warning for unparseable market payloads", async () => {
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
    const marketPayload = {
      message: "pid-123::{\"pid\":\"123\",\"last_numeric\":\"\",\"pc\":\"+1.2\",\"pcp\":\"+1.0%\"}",
    };
    const websocketMessage = `a${JSON.stringify([JSON.stringify(marketPayload)])}`;

    messageHandler({
      data: websocketMessage,
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).not.toHaveBeenCalled();
    expect(mockLogger.log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("Ignoring unparseable market data payload"),
    );
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
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("-1.00 (-0.50%)", "dnd"),
    );
  });

  test("forces reconnect when stream stays stale while socket is open", async () => {
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

    await advanceFakeTime(360_000);
    expect(wsClient.reconnect).toHaveBeenCalled();
  });

  test("sets invisible presence when the market session closes without a new tick", async () => {
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
        marketHours: "us_futures",
        lastUpdate: 0,
      },
    ]);

    await updateMarketData();
    clientInstances[0].handlers.get("clientReady")();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");
    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 100.5,
        pc: 1.2,
        pcp: 1.23,
      }),
    });
    await flushAsyncWork();

    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("+1.20 (1.23%)", "online"),
    );

    jest.setSystemTime(marketClosedReferenceTime);
    await advanceFakeTime(60_000);
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenLastCalledWith("1⬛ 100.50$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("Market closed.", "invisible"),
    );
    expect(mockLogger.log).toHaveBeenCalledWith(
      "debug",
      expect.objectContaining({
        message: "market-data:update-applied",
        source: "market-close-reconciler",
        bot_name: "bot-one",
        bot_client_id: "client-1",
        market_data_pid: 123,
        nickname: "1⬛ 100.50$",
        presence: "Market closed.",
        presence_status: "invisible",
      }),
    );
  });

  test("neutralizes the nickname when a queued update flushes after market close", async () => {
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
        marketHours: "us_futures",
        lastUpdate: 0,
      },
    ]);

    jest.setSystemTime(new Date("2026-03-12T20:59:50.000Z"));
    await updateMarketData();
    clientInstances[0].handlers.get("clientReady")();

    const wsClient = websocketInstances[0];
    const messageHandler = wsClient.handlers.get("message");

    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 100.5,
        pc: 1.2,
        pcp: 1.23,
      }),
    });
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenLastCalledWith("1🟩 100.50$");

    await advanceFakeTime(5000);
    messageHandler({
      data: buildSocketIoMarketMessage({
        pid: 123,
        last_numeric: 101.5,
        pc: 2.2,
        pcp: 2.23,
      }),
    });
    await flushAsyncWork();

    await advanceFakeTime(10_000);
    await flushAsyncWork();

    expect(clientInstances[0].setNickname).toHaveBeenLastCalledWith("1⬛ 101.50$");
    expect(clientInstances[0].client.user.setPresence).toHaveBeenLastCalledWith(
      buildPresencePayload("Market closed.", "invisible"),
    );
  });
});
