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

jest.mock("../assets.js", () => ({
  getAssets: mockGetAssets,
}));

jest.mock("../logging.js", () => ({
  getLogger: () => mockLogger,
}));

jest.mock("../secrets.js", () => ({
  readSecret: mockReadSecret,
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
