import type {Mock, MockedFunction} from "vitest";
import type * as DiscordJs from "discord.js";
import {vi} from "vitest";

const mockLogger = {
  log: vi.fn(),
};

type EventHandler = (...args: unknown[]) => unknown;

type HandlerRegistry = {
  get: (eventName: string) => EventHandler;
  set: (eventName: string, handler: EventHandler) => void;
};

type MockWebSocketClient = {
  OPEN: number;
  readyState: number;
  addEventListener: MockedFunction<(eventName: string, handler: EventHandler) => MockWebSocketClient>;
  send: Mock;
  reconnect: Mock;
  url: string;
  handlers: HandlerRegistry;
};

type MockMarketClient = {
  login: Mock;
  on: MockedFunction<(eventName: string, handler: EventHandler) => MockMarketClient>;
  user: {
    id: string;
    setPresence: Mock;
  };
  guilds: {
    cache: {
      get: Mock;
    };
  };
};

type MockMarketClientInstance = {
  client: MockMarketClient;
  handlers: HandlerRegistry;
  fetchMember: Mock;
  setNickname: Mock;
};

const mockGetAssets = vi.fn();
const mockReadSecret = vi.fn();
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

const mockWebSocketConstructor = vi.fn().mockImplementation((urlProvider: (() => string)) => {
  const handlers = createHandlerRegistry();
  const wsClient = {} as MockWebSocketClient;
  wsClient.OPEN = 1;
  wsClient.readyState = 1;
  wsClient.addEventListener = vi.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return wsClient;
  });
  wsClient.send = vi.fn();
  wsClient.reconnect = vi.fn();
  wsClient.url = "function" === typeof urlProvider ? urlProvider() : "wss://streaming.forexpros.com/mock/websocket";
  wsClient.handlers = handlers;

  websocketInstances.push(wsClient);

  return wsClient;
});

const clientInstances: MockMarketClientInstance[] = [];
const queuedClientIds: string[] = [];

const mockClientConstructor = vi.fn().mockImplementation(() => {
  const handlers = createHandlerRegistry();
  const setNickname = vi.fn().mockResolvedValue(undefined);
  const fetchMember = vi.fn().mockResolvedValue({
    setNickname,
  });
  const clientId = queuedClientIds.shift() ?? "market-bot-client";

  const client = {} as MockMarketClient;
  client.login = vi.fn().mockResolvedValue(undefined);
  client.on = vi.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });
  client.user = {
    id: clientId,
    setPresence: vi.fn(),
  };
  client.guilds = {
    cache: {
      get: vi.fn(() => ({
        members: {
          fetch: fetchMember,
        },
      })),
    },
  };

  clientInstances.push({client, handlers, fetchMember, setNickname});
  return client;
});

vi.mock("discord.js", async importOriginal => ({
  ...(await importOriginal<typeof DiscordJs>()),
  Client: function MockClient(...args: unknown[]) {
    return mockClientConstructor(...args);
  },
}));

vi.mock("reconnecting-websocket", () => ({
  __esModule: true,
  default: function MockWebSocket(...args: [() => string]) {
    return mockWebSocketConstructor(...args);
  },
}));

vi.mock("ws", () => ({
  __esModule: true,
  default: class MockWs {},
}));

vi.mock("../assets.ts", () => ({
  getAssets: (...args: unknown[]) => mockGetAssets(...args),
}));

vi.mock("../logging.ts", () => ({
  getLogger: () => ({
    log: (...args: unknown[]) => mockLogger.log(...args),
  }),
}));

vi.mock("../secrets.ts", () => ({
  readSecret: (...args: unknown[]) => mockReadSecret(...args),
}));

const {updateMarketData} = await import("../market-data.ts");

const marketOpenReferenceTime = new Date("2026-03-12T15:00:00.000Z");
const marketClosedReferenceTime = new Date("2026-03-12T21:00:00.000Z");

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function advanceFakeTime(durationMs: number) {
  await vi.advanceTimersByTimeAsync(durationMs);
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
