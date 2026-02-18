import {EventEmitter} from "node:events";
import {startBot} from "./startup-orchestrator.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

function createMockClient() {
  const emitter = new EventEmitter();
  const client: any = {
    on: jest.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      emitter.on(eventName, handler as any);
      return client;
    }),
    once: jest.fn((eventName: string, handler: (...args: unknown[]) => unknown) => {
      emitter.once(eventName, handler as any);
      return client;
    }),
    login: jest.fn(async () => {
      setImmediate(() => {
        emitter.emit("clientReady");
      });

      return "token";
    }),
  };

  return {
    client,
  };
}

function createDependencies(overrides = {}) {
  const {client} = createMockClient();
  const events: string[] = [];
  const logger = {
    level: "info",
    log: jest.fn(),
  };
  const readSecret = jest.fn((secretName: string) => {
    const defaults = {
      environment: "staging",
      discord_token: "token",
      hblwrk_channel_NYSEAnnouncement_ID: "nyse",
      hblwrk_channel_MNCAnnouncement_ID: "mnc",
      hblwrk_channel_OtherAnnouncement_ID: "other",
      hblwrk_channel_clownboard_ID: "clownboard",
    };

    return defaults[secretName] ?? "";
  });
  const runHealthCheck = jest.fn(() => {
    events.push("health");
    return {} as any;
  });
  const addInlineResponses = jest.fn(() => {
    events.push("inline");
  });
  const addTriggerResponses = jest.fn(() => {
    events.push("trigger");
  });
  const interactSlashCommands = jest.fn(() => {
    events.push("slash-interact");
  });
  const clownboard = jest.fn(() => {
    events.push("clownboard");
  });
  const startNyseTimers = jest.fn(() => {
    events.push("nyse");
  });
  const startMncTimers = jest.fn(() => {
    events.push("mnc");
  });
  const startOtherTimers = jest.fn(() => {
    events.push("other-timers");
  });
  const defineSlashCommands = jest.fn(() => {
    events.push("slash-define");
  });
  const roleManager = jest.fn(async () => {
    events.push("role-manager");
  });
  const getGenericAssets = jest.fn(async () => {
    events.push("generic-assets");
    return [];
  });
  const getTickers = jest.fn(async () => {
    events.push("tickers");
    return [];
  });
  const getAssets = jest.fn(async (type: string) => {
    events.push(`${type}-assets`);
    return [];
  });
  const updateMarketData = jest.fn(async () => {
    events.push("market-data");
  });

  return {
    dependencies: {
      logger,
      createClient: () => client,
      readSecret,
      runHealthCheck,
      addInlineResponses,
      addTriggerResponses,
      interactSlashCommands,
      clownboard,
      startNyseTimers,
      startMncTimers,
      startOtherTimers,
      defineSlashCommands,
      roleManager,
      getGenericAssets,
      getTickers,
      getAssets,
      updateMarketData,
      loginTimeoutMs: 200,
      warmupMaxAttempts: 3,
      warmupInitialRetryDelayMs: 1,
      warmupMaxRetryDelayMs: 5,
      slashCommandDebounceMs: 5,
      ...overrides,
    },
    events,
    mocks: {
      logger,
      readSecret,
      runHealthCheck,
      addInlineResponses,
      addTriggerResponses,
      interactSlashCommands,
      clownboard,
      startNyseTimers,
      startMncTimers,
      startOtherTimers,
      defineSlashCommands,
      roleManager,
      getGenericAssets,
      getTickers,
      getAssets,
      updateMarketData,
    },
  };
}

describe("startBot", () => {
  test("starts health first and reaches readiness even when remote warmup hangs", async () => {
    const genericDeferred = createDeferred<any[]>();
    const {dependencies, events, mocks} = createDependencies({
      getGenericAssets: jest.fn(async () => {
        events.push("generic-assets");
        return genericDeferred.promise;
      }),
    });

    const runtime = await startBot(dependencies);
    await sleep(10);

    const startupState = runtime.getStartupState();
    expect(startupState.ready).toBe(true);
    expect(startupState.discordLoggedIn).toBe(true);
    expect(startupState.handlersAttached).toBe(true);
    expect(startupState.remoteWarmupStatus).toBe("warming");
    expect(mocks.runHealthCheck).toHaveBeenCalledTimes(1);
    expect(events.indexOf("health")).toBeLessThan(events.indexOf("generic-assets"));

    genericDeferred.resolve([]);
  });

  test("retries failed warmup tasks without crashing phase A readiness", async () => {
    const getTickersMock = jest.fn()
      .mockRejectedValueOnce(new Error("temporary ticker failure"))
      .mockResolvedValueOnce([]);
    const {dependencies} = createDependencies({
      getTickers: getTickersMock,
      warmupMaxAttempts: 2,
      warmupInitialRetryDelayMs: 1,
      warmupMaxRetryDelayMs: 1,
    });

    const runtime = await startBot(dependencies);
    await sleep(30);

    expect(runtime.getStartupState().ready).toBe(true);
    expect(runtime.getStartupState().remoteWarmupStatus).toBe("ready");
    expect(getTickersMock).toHaveBeenCalledTimes(2);
  });

  test("attaches core handlers exactly once even when warmup retries happen", async () => {
    const getTickersMock = jest.fn()
      .mockRejectedValueOnce(new Error("temporary ticker failure"))
      .mockResolvedValueOnce([]);
    const {dependencies, mocks} = createDependencies({
      getTickers: getTickersMock,
      warmupMaxAttempts: 2,
      warmupInitialRetryDelayMs: 1,
      warmupMaxRetryDelayMs: 1,
    });

    await startBot(dependencies);
    await sleep(30);

    expect(mocks.clownboard).toHaveBeenCalledTimes(1);
    expect(mocks.startNyseTimers).toHaveBeenCalledTimes(1);
    expect(mocks.startMncTimers).toHaveBeenCalledTimes(1);
    expect(mocks.addInlineResponses).toHaveBeenCalledTimes(1);
    expect(mocks.addTriggerResponses).toHaveBeenCalledTimes(1);
    expect(mocks.interactSlashCommands).toHaveBeenCalledTimes(1);
  });

  test("runs startOtherTimers only with both prerequisites and roleManager after role assets load", async () => {
    const {dependencies, mocks} = createDependencies({
      getGenericAssets: jest.fn(async () => {
        throw new Error("generic assets unavailable");
      }),
      warmupMaxAttempts: 1,
    });

    await startBot(dependencies);
    await sleep(30);

    expect(mocks.startOtherTimers).not.toHaveBeenCalled();
    expect(mocks.roleManager).toHaveBeenCalledTimes(1);
  });

  test("re-registers slash commands as warmup data arrives", async () => {
    const getAssetsMock = jest.fn(async (type: string) => {
      if ("whatis" === type) {
        await sleep(20);
      }

      if ("user" === type) {
        await sleep(45);
      }

      return [];
    });
    const {dependencies, mocks} = createDependencies({
      getAssets: getAssetsMock,
      slashCommandDebounceMs: 5,
    });

    await startBot(dependencies);
    await sleep(90);

    expect(mocks.defineSlashCommands.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
