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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
  pollIntervalMs = 5,
): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs;
  while (Date.now() < timeoutAt) {
    if (true === predicate()) {
      return;
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms.`);
}

function createMockClient(userId = "bot-client-id") {
  const emitter = new EventEmitter();
  const client: any = {
    user: {
      id: userId,
    },
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
      hblwrk_gainslosses_thread_ID: "gains-losses-thread",
      hblwrk_channel_MNCAnnouncement_ID: "mnc",
      hblwrk_channel_OtherAnnouncement_ID: "other",
      hblwrk_channel_clownboard_ID: "clownboard",
      discord_client_ID: "bot-client-id",
      discord_guild_ID: "guild-id",
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
  const defineSlashCommands = jest.fn(async () => {
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
      assetRecoveryRetryMs: 10,
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
  test("starts health first and stays not-ready while remote warmup hangs", async () => {
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
    expect(startupState.ready).toBe(false);
    expect(startupState.discordLoggedIn).toBe(true);
    expect(startupState.handlersAttached).toBe(true);
    expect(startupState.remoteWarmupStatus).toBe("warming");
    expect(mocks.runHealthCheck).toHaveBeenCalledTimes(1);
    expect(events.indexOf("health")).toBeLessThan(events.indexOf("generic-assets"));

    genericDeferred.resolve([]);
  });

  test("retries failed warmup tasks and reaches readiness once warmup succeeds", async () => {
    const getTickersMock = jest.fn()
      .mockRejectedValueOnce(new Error("temporary ticker failure"))
      .mockResolvedValueOnce([]);
    const {dependencies, mocks} = createDependencies({
      getTickers: getTickersMock,
      warmupMaxAttempts: 2,
      warmupInitialRetryDelayMs: 1,
      warmupMaxRetryDelayMs: 1,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => "warming" !== runtime.getStartupState().remoteWarmupStatus);

    expect(runtime.getStartupState().ready).toBe(true);
    expect(runtime.getStartupState().remoteWarmupStatus).toBe("ready");
    expect(getTickersMock).toHaveBeenCalledTimes(2);
    expect(mocks.logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        task: "tickers",
        attempt: 1,
        max_attempts: 2,
        error_message: "temporary ticker failure",
        message: "Warmup task failed. Retrying.",
      }),
    );
  });

  test("keeps readiness false when any DRACOON asset download failed", async () => {
    const {dependencies} = createDependencies({
      getGenericAssets: jest.fn(async () => [
        {
          trigger: ["profi"],
          downloadFailed: true,
        },
      ]),
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => "warming" !== runtime.getStartupState().remoteWarmupStatus);

    const snapshot = runtime.getStartupState();
    expect(snapshot.ready).toBe(false);
    expect(snapshot.remoteWarmupStatus).toBe("degraded");
    expect(snapshot.warmupTasks["asset-downloads"]).toBe("failed");
  });

  test("retries failed assets and becomes ready after recovery", async () => {
    let genericAssetsCalls = 0;
    const {dependencies, mocks} = createDependencies({
      getGenericAssets: jest.fn(async () => {
        genericAssetsCalls += 1;
        if (1 === genericAssetsCalls) {
          return [
            {
              trigger: ["profi"],
              downloadFailed: true,
            },
          ];
        }

        return [
          {
            trigger: ["profi"],
            downloadFailed: false,
          },
        ];
      }),
      slashCommandDebounceMs: 5,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready, 1000);
    await waitFor(() => mocks.defineSlashCommands.mock.calls.length === 1, 1000);

    const snapshot = runtime.getStartupState();
    expect(snapshot.remoteWarmupStatus).toBe("ready");
    expect(snapshot.warmupTasks["asset-downloads"]).toBe("success");
    expect(genericAssetsCalls).toBeGreaterThanOrEqual(2);
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
    expect(mocks.startNyseTimers).toHaveBeenCalledWith(
      expect.anything(),
      "nyse",
      "gains-losses-thread",
    );
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

  test("schedules slash command sync once after the bot becomes ready", async () => {
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

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => mocks.defineSlashCommands.mock.calls.length === 1);

    expect(mocks.defineSlashCommands).toHaveBeenCalledTimes(1);
  });

  test("does not schedule slash command sync before generic assets are available", async () => {
    const genericDeferred = createDeferred<any[]>();
    const {dependencies, mocks} = createDependencies({
      getGenericAssets: jest.fn(async () => genericDeferred.promise),
      slashCommandDebounceMs: 5,
    });

    const runtime = await startBot(dependencies);
    await sleep(30);

    expect(runtime.getStartupState().ready).toBe(false);
    expect(mocks.defineSlashCommands).not.toHaveBeenCalled();

    genericDeferred.resolve([]);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => mocks.defineSlashCommands.mock.calls.length === 1);
  });

  test("becomes ready before the background slash command sync completes", async () => {
    const slashSyncDeferred = createDeferred<void>();
    const defineSlashCommandsMock = jest.fn(async () => slashSyncDeferred.promise);
    const {dependencies} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      slashCommandDebounceMs: 5,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 1);

    expect(runtime.getStartupState().remoteWarmupStatus).toBe("ready");
    expect(runtime.getStartupState().ready).toBe(true);

    slashSyncDeferred.resolve();
    await sleep(20);

    expect(runtime.getStartupState().ready).toBe(true);
  });

  test("coalesces repeated slash command sync triggers into one follow-up run", async () => {
    const slashSyncDeferred = createDeferred<void>();
    const defineSlashCommandsMock = jest.fn(async () => slashSyncDeferred.promise);
    let initialSlashSyncHandler: (() => void) | undefined;
    let slashSyncScheduleCount = 0;
    const setTimeoutFn = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const requestedDelay = Number(delay ?? 0);
      if (5 === requestedDelay) {
        slashSyncScheduleCount += 1;
        if (1 === slashSyncScheduleCount) {
          initialSlashSyncHandler = () => {
            handler(...args);
          };
          return {
            unref: jest.fn(),
          } as any;
        }
      }

      return setTimeout(handler as any, requestedDelay, ...args);
    }) as typeof setTimeout;
    const {dependencies} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      setTimeoutFn,
      clearTimeoutFn: clearTimeout,
      slashCommandDebounceMs: 5,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => "function" === typeof initialSlashSyncHandler);

    initialSlashSyncHandler?.();
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 1);

    initialSlashSyncHandler?.();
    await sleep(10);
    expect(defineSlashCommandsMock).toHaveBeenCalledTimes(1);

    slashSyncDeferred.resolve();
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 2);
    await sleep(20);

    expect(defineSlashCommandsMock).toHaveBeenCalledTimes(2);
    expect(runtime.getStartupState().ready).toBe(true);
  });

  test("keeps readiness true when background slash command sync fails", async () => {
    const defineSlashCommandsMock = jest.fn(async () => {
      throw new Error("slash sync failed");
    });
    const {dependencies, mocks} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      slashCommandDebounceMs: 5,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 1);

    expect(runtime.getStartupState().remoteWarmupStatus).toBe("ready");
    expect(runtime.getStartupState().ready).toBe(true);
    expect(mocks.logger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        startup_phase: "phase-b",
        task: "slash-commands",
        error_message: "slash sync failed",
        message: "Automatic slash command sync failed.",
      }),
    );
  });

  test("does not run slash command sync during repeated asset recovery attempts before the bot becomes ready", async () => {
    let genericAssetsCalls = 0;
    const defineSlashCommandsMock = jest.fn(async () => {});
    const {dependencies} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      assetRecoveryRetryMs: 5,
      slashCommandDebounceMs: 5,
      getGenericAssets: jest.fn(async () => {
        genericAssetsCalls += 1;
        if (genericAssetsCalls < 3) {
          return [
            {
              trigger: ["profi"],
              downloadFailed: true,
            },
          ];
        }

        return [
          {
            trigger: ["profi"],
            downloadFailed: false,
          },
        ];
      }),
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready, 1500);
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 1, 1500);

    expect(defineSlashCommandsMock).toHaveBeenCalledTimes(1);
  });

  test("suppresses further slash command sync attempts after a create-limit failure and keeps the bot ready", async () => {
    const createLimitError: any = new Error("Slash command create limit reached.");
    createLimitError.name = "SlashRegistrationCreateLimitError";
    createLimitError.discordErrorMessage = "Max number of daily application command creates has been reached (200)";
    createLimitError.retryAfterMs = 360919;
    const defineSlashCommandsMock = jest.fn(async () => {
      throw createLimitError;
    });
    const observedTimeoutDelays: number[] = [];
    const setTimeoutFn = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const requestedDelay = Number(delay ?? 0);
      observedTimeoutDelays.push(requestedDelay);
      return setTimeout(handler as any, requestedDelay, ...args);
    }) as typeof setTimeout;
    const {dependencies, mocks} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      setTimeoutFn,
      clearTimeoutFn: clearTimeout,
      slashCommandDebounceMs: 5,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 1);
    await sleep(20);

    expect(runtime.getStartupState().remoteWarmupStatus).toBe("ready");
    expect(runtime.getStartupState().ready).toBe(true);
    expect(defineSlashCommandsMock).toHaveBeenCalledTimes(1);
    expect(observedTimeoutDelays).toContain(86_400_000);
    expect(observedTimeoutDelays).not.toContain(360919);
    expect(mocks.logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        task: "slash-commands",
        cooldown_ms: 86_400_000,
        discord_error_message: "Max number of daily application command creates has been reached (200)",
        retry_after_ms: 360919,
        message: "slash-registration:daily-create-limit-suppressed",
      }),
    );
  });

  test("retries slash command sync after the create-limit cooldown expires", async () => {
    const createLimitError: any = new Error("Slash command create limit reached.");
    createLimitError.name = "SlashRegistrationCreateLimitError";
    createLimitError.retryAfterMs = 360919;
    const defineSlashCommandsMock = jest.fn()
      .mockImplementationOnce(async () => {
        throw createLimitError;
      })
      .mockImplementationOnce(async () => {});
    let cooldownHandler: (() => void) | undefined;
    const setTimeoutFn = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const requestedDelay = Number(delay ?? 0);
      if (86_400_000 === requestedDelay) {
        cooldownHandler = () => {
          handler(...args);
        };
        return {
          unref: jest.fn(),
        } as any;
      }

      return setTimeout(handler as any, requestedDelay, ...args);
    }) as typeof setTimeout;
    const {dependencies, mocks} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      setTimeoutFn,
      clearTimeoutFn: clearTimeout,
      slashCommandDebounceMs: 5,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 1);
    expect(cooldownHandler).toBeDefined();

    cooldownHandler?.();
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 2);

    expect(runtime.getStartupState().ready).toBe(true);
    expect(runtime.getStartupState().remoteWarmupStatus).toBe("ready");
    expect(mocks.logger.log).toHaveBeenCalledWith(
      "info",
      expect.objectContaining({
        task: "slash-commands",
        cooldown_ms: 86_400_000,
        message: "slash-registration:cooldown-expired-retry",
      }),
    );
  });

  test("uses retry-after backoff for slash command rate-limit failures", async () => {
    const rateLimitError: any = new Error("Slash command registration rate limited.");
    rateLimitError.name = "SlashRegistrationRateLimitError";
    rateLimitError.discordErrorMessage = "You are being rate limited.";
    rateLimitError.retryAfterMs = 11902;
    const defineSlashCommandsMock = jest.fn()
      .mockImplementationOnce(async () => {
        throw rateLimitError;
      })
      .mockImplementationOnce(async () => {});
    const observedTimeoutDelays: number[] = [];
    const setTimeoutFn = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const requestedDelay = Number(delay ?? 0);
      observedTimeoutDelays.push(requestedDelay);
      const boundedDelay = requestedDelay > 1_000 ? 1 : requestedDelay;
      return setTimeout(handler as any, boundedDelay, ...args);
    }) as typeof setTimeout;
    const {dependencies, mocks} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      setTimeoutFn,
      clearTimeoutFn: clearTimeout,
      slashCommandDebounceMs: 5,
      warmupMaxAttempts: 2,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 2);

    expect(runtime.getStartupState().ready).toBe(true);
    expect(observedTimeoutDelays).toContain(11902);
    expect(mocks.logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        task: "slash-commands",
        discord_error_message: "You are being rate limited.",
        retry_after_ms: 11902,
        retry_in_ms: 11902,
        message: "slash-registration:rate-limited",
      }),
    );
  });

  test("uses Retry-After header backoff for slash command rate-limit failures when retryAfterMs is absent", async () => {
    const rateLimitError: any = new Error("Slash command registration rate limited.");
    rateLimitError.name = "SlashRegistrationRateLimitError";
    rateLimitError.response = {
      headers: {
        "Retry-After": "12",
      },
    };
    const defineSlashCommandsMock = jest.fn()
      .mockImplementationOnce(async () => {
        throw rateLimitError;
      })
      .mockImplementationOnce(async () => {});
    const observedTimeoutDelays: number[] = [];
    const setTimeoutFn = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const requestedDelay = Number(delay ?? 0);
      observedTimeoutDelays.push(requestedDelay);
      const boundedDelay = requestedDelay > 1_000 ? 1 : requestedDelay;
      return setTimeout(handler as any, boundedDelay, ...args);
    }) as typeof setTimeout;
    const {dependencies, mocks} = createDependencies({
      defineSlashCommands: defineSlashCommandsMock,
      setTimeoutFn,
      clearTimeoutFn: clearTimeout,
      slashCommandDebounceMs: 5,
      warmupMaxAttempts: 2,
    });

    const runtime = await startBot(dependencies);
    await waitFor(() => true === runtime.getStartupState().ready);
    await waitFor(() => defineSlashCommandsMock.mock.calls.length === 2);

    expect(runtime.getStartupState().ready).toBe(true);
    expect(observedTimeoutDelays).toContain(12_000);
    expect(mocks.logger.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        task: "slash-commands",
        retry_after_ms: 12_000,
        retry_in_ms: 12_000,
        message: "slash-registration:rate-limited",
      }),
    );
  });

  test("fails startup when logged-in client ID does not match configured client ID", async () => {
    const {client} = createMockClient("different-client-id");
    const {dependencies, mocks} = createDependencies({
      createClient: () => client as any,
      warmupMaxAttempts: 1,
    });

    await expect(startBot(dependencies)).rejects.toThrow("Slash registration target mismatch");
    expect(mocks.logger.log).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({
        startup_phase: "phase-a",
        task: "slash-commands",
        failure_reason: "target_mismatch",
      }),
    );
  });
});
