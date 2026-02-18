const mockLogger = {
  log: jest.fn(),
};

const mockGetAssets = jest.fn();
const mockReadSecret = jest.fn();
const mockWebSocketConstructor = jest.fn().mockImplementation(() => ({
  addEventListener: jest.fn(),
  send: jest.fn(),
  url: "wss://streaming.forexpros.com/mock/websocket",
}));

const clientInstances: Array<{
  client: any;
  handlers: Map<string, (...args: any[]) => unknown>;
}> = [];

const mockClientConstructor = jest.fn().mockImplementation(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();

  const client = {
    login: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((eventName: string, handler: (...args: any[]) => unknown) => {
      handlers.set(eventName, handler);
      return client;
    }),
    user: {
      id: "market-bot-client",
      setPresence: jest.fn(),
    },
    guilds: {
      cache: {
        get: jest.fn(() => ({
          members: {
            fetch: jest.fn().mockResolvedValue({
              setNickname: jest.fn().mockResolvedValue(undefined),
            }),
          },
        })),
      },
    },
  };

  clientInstances.push({client, handlers});
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

describe("updateMarketData", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clientInstances.length = 0;
    mockReadSecret.mockReturnValue("guild-id");
  });

  test("logs in market-data bot clients and sets default presence on clientReady", async () => {
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "market-bot-client",
        id: 123,
        decimals: 2,
        order: 1,
        suffix: "",
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
  });

  test("starts websocket stream only after all market-data bots emit clientReady", async () => {
    mockGetAssets.mockResolvedValue([
      {
        botToken: "token-1",
        botName: "bot-one",
        botClientId: "market-bot-client",
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
        botClientId: "market-bot-client",
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
    expect(mockWebSocketConstructor).not.toHaveBeenCalled();

    secondReady();
    expect(mockWebSocketConstructor).toHaveBeenCalledTimes(1);

    const wsClient = mockWebSocketConstructor.mock.results[0].value;
    expect(wsClient.addEventListener).toHaveBeenCalledWith("open", expect.any(Function));
    expect(wsClient.addEventListener).toHaveBeenCalledWith("close", expect.any(Function));
    expect(wsClient.addEventListener).toHaveBeenCalledWith("error", expect.any(Function));
    expect(wsClient.addEventListener).toHaveBeenCalledWith("message", expect.any(Function));
  });
});
