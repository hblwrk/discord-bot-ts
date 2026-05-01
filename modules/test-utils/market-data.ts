const mockLogger = {
  log: jest.fn(),
};

type EventHandler = (...args: unknown[]) => unknown;

type HandlerRegistry = {
  get: (eventName: string) => EventHandler;
  set: (eventName: string, handler: EventHandler) => void;
};

type MockWebSocketClient = {
  OPEN: number;
  readyState: number;
  addEventListener: jest.MockedFunction<(eventName: string, handler: EventHandler) => MockWebSocketClient>;
  send: jest.Mock;
  reconnect: jest.Mock;
  url: string;
  handlers: HandlerRegistry;
};

type MockMarketClient = {
  login: jest.Mock;
  on: jest.MockedFunction<(eventName: string, handler: EventHandler) => MockMarketClient>;
  user: {
    id: string;
    setPresence: jest.Mock;
  };
  guilds: {
    cache: {
      get: jest.Mock;
    };
  };
};

type MockMarketClientInstance = {
  client: MockMarketClient;
  handlers: HandlerRegistry;
  fetchMember: jest.Mock;
  setNickname: jest.Mock;
};

const mockGetAssets = jest.fn();
const mockReadSecret = jest.fn();
const websocketInstances: MockWebSocketClient[] = [];

function createHandlerRegistry(): HandlerRegistry {
  const handlers = new Map<string, EventHandler>();
  return {
    get: (eventName: string) => {
      const handler = handlers.get(eventName);
      if (!handler) {
        throw new Error(`Missing handler for ${eventName}.`);
      }

      return handler;
    },
    set: (eventName: string, handler: EventHandler) => {
      handlers.set(eventName, handler);
    },
  };
}

const mockWebSocketConstructor = jest.fn().mockImplementation((urlProvider: (() => string)) => {
  const handlers = createHandlerRegistry();
  const wsClient = {} as MockWebSocketClient;
  wsClient.OPEN = 1;
  wsClient.readyState = 1;
  wsClient.addEventListener = jest.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return wsClient;
  });
  wsClient.send = jest.fn();
  wsClient.reconnect = jest.fn();
  wsClient.url = "function" === typeof urlProvider ? urlProvider() : "wss://streaming.forexpros.com/mock/websocket";
  wsClient.handlers = handlers;

  websocketInstances.push(wsClient);

  return wsClient;
});

const clientInstances: MockMarketClientInstance[] = [];
const queuedClientIds: string[] = [];

const mockClientConstructor = jest.fn().mockImplementation(() => {
  const handlers = createHandlerRegistry();
  const setNickname = jest.fn().mockResolvedValue(undefined);
  const fetchMember = jest.fn().mockResolvedValue({
    setNickname,
  });
  const clientId = queuedClientIds.shift() ?? "market-bot-client";

  const client = {} as MockMarketClient;
  client.login = jest.fn().mockResolvedValue(undefined);
  client.on = jest.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });
  client.user = {
    id: clientId,
    setPresence: jest.fn(),
  };
  client.guilds = {
    cache: {
      get: jest.fn(() => ({
        members: {
          fetch: fetchMember,
        },
      })),
    },
  };

  clientInstances.push({client, handlers, fetchMember, setNickname});
  return client;
});

jest.mock("discord.js", () => ({
  Client: function MockClient(...args: unknown[]) {
    return mockClientConstructor(...args);
  },
}));

jest.mock("reconnecting-websocket", () => ({
  __esModule: true,
  default: function MockWebSocket(...args: [() => string]) {
    return mockWebSocketConstructor(...args);
  },
}));

jest.mock("ws", () => ({
  __esModule: true,
  default: class MockWs {},
}));

jest.mock("../assets.js", () => ({
  getAssets: (...args: unknown[]) => mockGetAssets(...args),
}));

jest.mock("../logging.js", () => ({
  getLogger: () => ({
    log: (...args: unknown[]) => mockLogger.log(...args),
  }),
}));

jest.mock("../secrets.js", () => ({
  readSecret: (...args: unknown[]) => mockReadSecret(...args),
}));

import {updateMarketData} from "../market-data.js";

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

function buildPresencePayload(name: string, status: "dnd" | "idle" | "invisible" | "online") {
  return {
    activities: [{name}],
    status,
  };
}


export {
  advanceFakeTime,
  buildPresencePayload,
  buildSocketIoMarketMessage,
  clientInstances,
  flushAsyncWork,
  marketClosedReferenceTime,
  marketOpenReferenceTime,
  mockClientConstructor,
  mockGetAssets,
  mockLogger,
  mockReadSecret,
  mockWebSocketConstructor,
  queuedClientIds,
  updateMarketData,
  websocketInstances,
};
