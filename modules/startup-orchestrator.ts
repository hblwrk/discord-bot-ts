/* eslint-disable import/extensions */
import {Client, GatewayIntentBits, Partials} from "discord.js";
import {getGenericAssets, getAssets} from "./assets.js";
import {clownboard} from "./clownboard.js";
import {runHealthCheck} from "./health-check.js";
import {addInlineResponses} from "./inline-response.js";
import {getLogger} from "./logging.js";
import {updateMarketData} from "./market-data.js";
import {roleManager} from "./role-manager.js";
import {readSecret} from "./secrets.js";
import {defineSlashCommands, interactSlashCommands} from "./slash-commands.js";
import {createStartupState, type StartupStateSnapshot} from "./startup-state.js";
import {getTickers, type Ticker} from "./tickers.js";
import {startMncTimers, startNyseTimers, startOtherTimers} from "./timers.js";
import {addTriggerResponses} from "./trigger-response.js";

type Logger = {
  level?: string;
  log: (level: string, message: any) => void;
};

type StartupDependencies = {
  logger: Logger;
  createClient: () => Client;
  readSecret: typeof readSecret;
  runHealthCheck: typeof runHealthCheck;
  startNyseTimers: typeof startNyseTimers;
  startMncTimers: typeof startMncTimers;
  startOtherTimers: typeof startOtherTimers;
  updateMarketData: typeof updateMarketData;
  defineSlashCommands: typeof defineSlashCommands;
  interactSlashCommands: typeof interactSlashCommands;
  addInlineResponses: typeof addInlineResponses;
  addTriggerResponses: typeof addTriggerResponses;
  getGenericAssets: typeof getGenericAssets;
  getAssets: typeof getAssets;
  getTickers: typeof getTickers;
  roleManager: typeof roleManager;
  clownboard: typeof clownboard;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  loginTimeoutMs: number;
  warmupMaxAttempts: number;
  warmupInitialRetryDelayMs: number;
  warmupMaxRetryDelayMs: number;
  slashCommandDebounceMs: number;
};

type StartupOptions = Partial<StartupDependencies>;

export type StartupRuntime = {
  client: Client;
  getStartupState: () => StartupStateSnapshot;
};

type SharedStartupData = {
  assets: any[];
  whatIsAssets: any[];
  userAssets: any[];
  roleAssets: any[];
  tickers: Ticker[];
  assetCommands: string[];
  assetCommandsWithPrefix: string[];
};

const defaultLoginTimeoutMs = 30_000;
const defaultWarmupMaxAttempts = 4;
const defaultWarmupInitialRetryDelayMs = 500;
const defaultWarmupMaxRetryDelayMs = 15_000;
const defaultSlashCommandDebounceMs = 250;

type ErrorLogDetails = {
  error_name?: string;
  error_message: string;
  error_stack?: string;
};

function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
    ],
  });
}

function replaceArray<T>(target: T[], nextValues: T[]) {
  target.length = 0;
  target.push(...nextValues);
}

function rebuildAssetCommands(sharedData: SharedStartupData) {
  sharedData.assetCommands.length = 0;
  sharedData.assetCommandsWithPrefix.length = 0;
  for (const asset of sharedData.assets) {
    for (const trigger of asset.trigger) {
      sharedData.assetCommands.push(trigger.replaceAll(" ", "_"));
      sharedData.assetCommandsWithPrefix.push(`!${trigger}`);
    }
  }
}

function createDependencies(options: StartupOptions): StartupDependencies {
  return {
    logger: options.logger ?? getLogger(),
    createClient: options.createClient ?? createDiscordClient,
    readSecret: options.readSecret ?? readSecret,
    runHealthCheck: options.runHealthCheck ?? runHealthCheck,
    startNyseTimers: options.startNyseTimers ?? startNyseTimers,
    startMncTimers: options.startMncTimers ?? startMncTimers,
    startOtherTimers: options.startOtherTimers ?? startOtherTimers,
    updateMarketData: options.updateMarketData ?? updateMarketData,
    defineSlashCommands: options.defineSlashCommands ?? defineSlashCommands,
    interactSlashCommands: options.interactSlashCommands ?? interactSlashCommands,
    addInlineResponses: options.addInlineResponses ?? addInlineResponses,
    addTriggerResponses: options.addTriggerResponses ?? addTriggerResponses,
    getGenericAssets: options.getGenericAssets ?? getGenericAssets,
    getAssets: options.getAssets ?? getAssets,
    getTickers: options.getTickers ?? getTickers,
    roleManager: options.roleManager ?? roleManager,
    clownboard: options.clownboard ?? clownboard,
    setTimeoutFn: options.setTimeoutFn ?? setTimeout,
    clearTimeoutFn: options.clearTimeoutFn ?? clearTimeout,
    loginTimeoutMs: options.loginTimeoutMs ?? defaultLoginTimeoutMs,
    warmupMaxAttempts: options.warmupMaxAttempts ?? defaultWarmupMaxAttempts,
    warmupInitialRetryDelayMs: options.warmupInitialRetryDelayMs ?? defaultWarmupInitialRetryDelayMs,
    warmupMaxRetryDelayMs: options.warmupMaxRetryDelayMs ?? defaultWarmupMaxRetryDelayMs,
    slashCommandDebounceMs: options.slashCommandDebounceMs ?? defaultSlashCommandDebounceMs,
  };
}

function waitWithTimer(delayMs: number, setTimeoutFn: typeof setTimeout): Promise<void> {
  return new Promise(resolve => {
    setTimeoutFn(resolve, delayMs);
  });
}

function toErrorLogDetails(error: unknown): ErrorLogDetails {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack,
    };
  }

  return {
    error_message: String(error),
  };
}

async function waitForDiscordReady(
  client: Client,
  token: string,
  timeoutMs: number,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeoutHandle = setTimeoutFn(() => {
      if (false === settled) {
        settled = true;
        reject(new Error(`Timed out waiting for clientReady after ${timeoutMs}ms.`));
      }
    }, timeoutMs);

    client.once("clientReady", () => {
      if (false === settled) {
        settled = true;
        clearTimeoutFn(timeoutHandle);
        resolve();
      }
    });

    client.login(token).catch(error => {
      if (false === settled) {
        settled = true;
        clearTimeoutFn(timeoutHandle);
        reject(error);
      }
    });
  });
}

export async function startBot(options: StartupOptions = {}): Promise<StartupRuntime> {
  const dependencies = createDependencies(options);
  const logger = dependencies.logger;
  const startupState = createStartupState(logger);
  const getStartupState = () => startupState.getSnapshot();

  dependencies.runHealthCheck(getStartupState);
  logger.log(
    "info",
    {
      startup_phase: "health",
      message: "Health-check endpoint started.",
    },
  );

  const client = dependencies.createClient();
  const sharedData: SharedStartupData = {
    assets: [],
    whatIsAssets: [],
    userAssets: [],
    roleAssets: [],
    tickers: [],
    assetCommands: [],
    assetCommandsWithPrefix: [],
  };
  const environment = dependencies.readSecret("environment").trim();
  const channelNyseId = dependencies.readSecret("hblwrk_channel_NYSEAnnouncement_ID");
  const gainsLossesThreadId = dependencies.readSecret("hblwrk_gainslosses_thread_ID").trim();
  const channelMncId = dependencies.readSecret("hblwrk_channel_MNCAnnouncement_ID");
  const channelOtherId = dependencies.readSecret("hblwrk_channel_OtherAnnouncement_ID");
  const channelClownboardId = dependencies.readSecret("hblwrk_channel_clownboard_ID");
  const token = dependencies.readSecret("discord_token");

  const phaseAFinished = startupState.startPhase("phase-a");
  try {
    client.once("clientReady", () => {
      logger.log(
        "info",
        "Logged in.",
      );
    });

    dependencies.clownboard(client, channelClownboardId);
    dependencies.startNyseTimers(client, channelNyseId, gainsLossesThreadId);
    dependencies.startMncTimers(client, channelMncId);
    dependencies.addInlineResponses(client, sharedData.assets, sharedData.assetCommands);
    dependencies.addTriggerResponses(client, sharedData.assets, sharedData.assetCommandsWithPrefix, sharedData.whatIsAssets);
    dependencies.interactSlashCommands(client, sharedData.assets, sharedData.assetCommands, sharedData.whatIsAssets, sharedData.tickers);
    startupState.markHandlersAttached();

    logger.log(
      "info",
      {
        startup_phase: "phase-a",
        message: "Core handlers attached.",
      },
    );

    await waitForDiscordReady(
      client,
      token,
      dependencies.loginTimeoutMs,
      dependencies.setTimeoutFn,
      dependencies.clearTimeoutFn,
    );
    startupState.markDiscordLoggedIn();
    phaseAFinished();
    logger.log(
      "info",
      "Bot ready.",
    );
  } catch (error) {
    startupState.setLastError(error);
    phaseAFinished();
    logger.log(
      "error",
      {
        startup_phase: "phase-a",
        message: `Error starting up: ${error}`,
      },
    );
    throw error;
  }

  void warmRemoteData({
    client,
    sharedData,
    dependencies,
    startupState,
    channelOtherId,
    environment,
  });

  return {
    client,
    getStartupState,
  };
}

async function warmRemoteData({
  client,
  sharedData,
  dependencies,
  startupState,
  channelOtherId,
  environment,
}: {
  client: Client;
  sharedData: SharedStartupData;
  dependencies: StartupDependencies;
  startupState: ReturnType<typeof createStartupState>;
  channelOtherId: string;
  environment: string;
}) {
  const logger = dependencies.logger;
  const phaseBFinished = startupState.startPhase("phase-b");
  startupState.setRemoteWarmupStatus("warming");

  let slashCommandDebounceHandle: ReturnType<typeof setTimeout> | undefined;
  let otherTimersStarted = false;
  let genericAssetsLoaded = false;
  let tickersLoaded = false;

  const scheduleSlashCommands = () => {
    if ("undefined" !== typeof slashCommandDebounceHandle) {
      dependencies.clearTimeoutFn(slashCommandDebounceHandle);
    }

    slashCommandDebounceHandle = dependencies.setTimeoutFn(() => {
      slashCommandDebounceHandle = undefined;
      try {
        dependencies.defineSlashCommands(sharedData.assets, sharedData.whatIsAssets, sharedData.userAssets);
      } catch (error) {
        startupState.setLastError(error);
        logger.log(
          "error",
          {
            startup_phase: "phase-b",
            task: "slash-commands",
            message: `Failed to define slash commands: ${error}`,
          },
        );
      }
    }, dependencies.slashCommandDebounceMs);
    (slashCommandDebounceHandle as any).unref?.();
  };

  const tryStartOtherTimers = () => {
    if (true === otherTimersStarted) {
      return;
    }

    if (false === genericAssetsLoaded || false === tickersLoaded) {
      return;
    }

    dependencies.startOtherTimers(client, channelOtherId, sharedData.assets, sharedData.tickers);
    otherTimersStarted = true;
    logger.log(
      "info",
      {
        startup_phase: "phase-b",
        task: "other-timers",
        message: "Other timers started.",
      },
    );
  };

  const runWarmupTaskWithRetry = async <T>(task: string, callback: () => Promise<T>) => {
    startupState.markWarmupTask(task, "running");
    let lastError: unknown;

    for (let attempt = 1; attempt <= dependencies.warmupMaxAttempts; attempt++) {
      try {
        const result = await callback();
        startupState.markWarmupTask(task, "success");
        return result;
      } catch (error: unknown) {
        lastError = error;
        startupState.setLastError(error);
        const errorDetails = toErrorLogDetails(error);
        if (attempt === dependencies.warmupMaxAttempts) {
          logger.log(
            "error",
            {
              startup_phase: "phase-b",
              degraded: true,
              task,
              attempt,
              max_attempts: dependencies.warmupMaxAttempts,
              ...errorDetails,
              message: "Warmup task failed after maximum retries.",
            },
          );
          break;
        }

        const retryInMs = Math.min(
          dependencies.warmupInitialRetryDelayMs * (2 ** (attempt - 1)),
          dependencies.warmupMaxRetryDelayMs,
        );
        logger.log(
          "warn",
          {
            startup_phase: "phase-b",
            degraded: true,
            task,
            attempt,
            max_attempts: dependencies.warmupMaxAttempts,
            retry_in_ms: retryInMs,
            ...errorDetails,
            message: "Warmup task failed. Retrying.",
          },
        );
        await waitWithTimer(retryInMs, dependencies.setTimeoutFn);
      }
    }

    startupState.markWarmupTask(task, "failed");
    throw lastError;
  };

  try {
    const warmupTasks: Promise<void>[] = [];

    warmupTasks.push((async () => {
      const genericAssets = await runWarmupTaskWithRetry("generic-assets", async () => dependencies.getGenericAssets());
      replaceArray(sharedData.assets, genericAssets);
      rebuildAssetCommands(sharedData);
      genericAssetsLoaded = true;
      tryStartOtherTimers();
      scheduleSlashCommands();
      logger.log(
        "info",
        `Loaded and cached ${sharedData.assets.length} generic assets.`,
      );
    })());

    warmupTasks.push((async () => {
      const tickers = await runWarmupTaskWithRetry("tickers", async () => dependencies.getTickers("all"));
      replaceArray(sharedData.tickers, tickers);
      tickersLoaded = true;
      tryStartOtherTimers();
      logger.log(
        "info",
        `Loaded and cached ${sharedData.tickers.length} tickers.`,
      );
    })());

    warmupTasks.push((async () => {
      const whatIsAssets = await runWarmupTaskWithRetry("whatis-assets", async () => dependencies.getAssets("whatis"));
      replaceArray(sharedData.whatIsAssets, whatIsAssets);
      scheduleSlashCommands();
      logger.log(
        "info",
        `Loaded and cached ${sharedData.whatIsAssets.length} whatis assets.`,
      );
    })());

    warmupTasks.push((async () => {
      const userAssets = await runWarmupTaskWithRetry("user-assets", async () => dependencies.getAssets("user"));
      replaceArray(sharedData.userAssets, userAssets);
      scheduleSlashCommands();
      logger.log(
        "info",
        `Loaded and cached ${sharedData.userAssets.length} user assets.`,
      );
    })());

    warmupTasks.push((async () => {
      const roleAssets = await runWarmupTaskWithRetry("role-assets", async () => dependencies.getAssets("role"));
      replaceArray(sharedData.roleAssets, roleAssets);
      logger.log(
        "info",
        `Loaded and cached ${sharedData.roleAssets.length} role assets.`,
      );
      await runWarmupTaskWithRetry("role-manager", async () => dependencies.roleManager(client, sharedData.roleAssets));
    })());

    if ("production" === environment) {
      warmupTasks.push((async () => {
        await runWarmupTaskWithRetry("market-data", async () => dependencies.updateMarketData());
      })());
    }

    const warmupResults = await Promise.allSettled(warmupTasks);
    const hasWarmupFailure = warmupResults.some(result => "rejected" === result.status);

    if (false === otherTimersStarted) {
      logger.log(
        "warn",
        {
          startup_phase: "phase-b",
          degraded: true,
          task: "other-timers",
          message: "Skipping other timers because required warmup data is unavailable.",
        },
      );
    }

    if (hasWarmupFailure) {
      startupState.setRemoteWarmupStatus("degraded");
      logger.log(
        "warn",
        {
          startup_phase: "phase-b",
          degraded: true,
          message: "Startup warmup completed in degraded mode.",
        },
      );
    } else {
      startupState.setRemoteWarmupStatus("ready");
      logger.log(
        "info",
        {
          startup_phase: "phase-b",
          degraded: false,
          message: "Startup warmup completed.",
        },
      );
    }
  } catch (error) {
    startupState.setLastError(error);
    startupState.setRemoteWarmupStatus("degraded");
    logger.log(
      "error",
      {
        startup_phase: "phase-b",
        degraded: true,
        message: `Unexpected warmup failure: ${error}`,
      },
    );
  } finally {
    phaseBFinished();
  }
}
