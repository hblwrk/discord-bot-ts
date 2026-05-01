import {Client, GatewayIntentBits, Partials} from "discord.js";
import {getGenericAssets, getAssets} from "./assets.ts";
import {clownboard} from "./clownboard.ts";
import {getInteractiveClientCacheFactory} from "./discord-client-options.ts";
import {startEarningsResultWatcher} from "./earnings-results.ts";
import {runHealthCheck} from "./health-check.ts";
import {addInlineResponses} from "./inline-response.ts";
import {getLogger} from "./logging.ts";
import {updateMarketData} from "./market-data.ts";
import {roleManager} from "./role-manager.ts";
import {readSecret} from "./secrets.ts";
import {defineSlashCommands, interactSlashCommands} from "./slash-commands.ts";
import {createStartupState} from "./startup-state.ts";
import {getTickers} from "./tickers.ts";
import {startMncTimers, startNyseTimers, startOtherTimers} from "./timers.ts";
import {addTriggerResponses} from "./trigger-response.ts";
import {runStartupPreflight} from "./startup-preflight.ts";
import {
  type SharedStartupData,
  type StartupDependencies,
  type StartupOptions,
  type StartupRuntime,
} from "./startup-types.ts";
import {warmRemoteData} from "./startup-warmup.ts";

const defaultLoginTimeoutMs = 30_000;
const defaultWarmupMaxAttempts = 4;
const defaultWarmupInitialRetryDelayMs = 500;
const defaultWarmupMaxRetryDelayMs = 15_000;
const defaultSlashCommandDebounceMs = 250;
const defaultAssetRecoveryRetryMs = 60_000;
const defaultAssetRecoveryMaxRetryMs = 30 * 60_000;

function createDiscordClient(): Client {
  const makeCache = getInteractiveClientCacheFactory();

  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    ...(makeCache ? {makeCache} : {}),
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
    ],
  });
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
    startEarningsResultWatcher: options.startEarningsResultWatcher ?? startEarningsResultWatcher,
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
    assetRecoveryRetryMs: options.assetRecoveryRetryMs ?? defaultAssetRecoveryRetryMs,
    assetRecoveryMaxRetryMs: options.assetRecoveryMaxRetryMs ?? defaultAssetRecoveryMaxRetryMs,
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
        reject(error instanceof Error ? error : new Error(String(error)));
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
    calendarReminderAssets: [],
    earningsReminderAssets: [],
    paywallAssets: [],
    tickers: [],
    assetCommands: [],
    assetCommandsWithPrefix: [],
  };
  const environment = dependencies.readSecret("environment").trim();
  const channelNyseId = dependencies.readSecret("hblwrk_channel_NYSEAnnouncement_ID").trim();
  const gainsLossesThreadId = dependencies.readSecret("hblwrk_gainslosses_thread_ID").trim();
  const channelMncId = dependencies.readSecret("hblwrk_channel_MNCAnnouncement_ID").trim();
  const channelOtherId = dependencies.readSecret("hblwrk_channel_OtherAnnouncement_ID").trim();
  const channelClownboardId = dependencies.readSecret("hblwrk_channel_clownboard_ID").trim();
  const roleAssignmentChannelId = dependencies.readSecret("hblwrk_role_assignment_channel_ID").trim();
  const roleAssignmentBrokerMessageId = dependencies.readSecret("hblwrk_role_assignment_broker_message_ID").trim();
  const roleAssignmentSpecialMessageId = dependencies.readSecret("hblwrk_role_assignment_special_message_ID").trim();
  const mutedRoleId = dependencies.readSecret("hblwrk_role_muted_ID").trim();
  const brokerYesRoleId = dependencies.readSecret("hblwrk_role_broker_yes_ID").trim();
  const token = dependencies.readSecret("discord_token").trim();
  const configuredDiscordClientId = dependencies.readSecret("discord_client_ID").trim();
  const configuredDiscordGuildId = dependencies.readSecret("discord_guild_ID").trim();

  const phaseAFinished = startupState.startPhase("phase-a");
  try {
    client.once("clientReady", () => {
      logger.log(
        "info",
        "Logged in.",
      );
    });

    logger.log(
      "info",
      {
        startup_phase: "phase-a",
        task: "slash-commands",
        discord_client_id: configuredDiscordClientId,
        discord_guild_id: configuredDiscordGuildId,
        message: "Slash command registration target configured.",
      },
    );

    await waitForDiscordReady(
      client,
      token,
      dependencies.loginTimeoutMs,
      dependencies.setTimeoutFn,
      dependencies.clearTimeoutFn,
    );
    const loggedInDiscordClientId = client.user?.id?.trim?.() ?? client.user?.id ?? "";
    if (configuredDiscordClientId !== loggedInDiscordClientId) {
      const targetMismatchError = new Error(
        `Slash registration target mismatch: configured client ID "${configuredDiscordClientId}" does not match logged-in client ID "${loggedInDiscordClientId}".`,
      );
      targetMismatchError.name = "SlashRegistrationTargetMismatchError";
      logger.log(
        "error",
        {
          startup_phase: "phase-a",
          task: "slash-commands",
          failure_reason: "target_mismatch",
          configured_discord_client_id: configuredDiscordClientId,
          logged_in_discord_client_id: loggedInDiscordClientId,
          message: "Slash command registration target mismatch detected. Aborting startup.",
        },
      );
      throw targetMismatchError;
    }

    startupState.markDiscordLoggedIn();
    await runStartupPreflight(client, logger, {
      brokerYesRoleId,
      channelClownboardId,
      channelMncId,
      channelNyseId,
      channelOtherId,
      configuredDiscordGuildId,
      mutedRoleId,
      roleAssignmentBrokerMessageId,
      roleAssignmentChannelId,
      roleAssignmentSpecialMessageId,
    });

    dependencies.clownboard(client, channelClownboardId);
    dependencies.startNyseTimers(client, channelNyseId, gainsLossesThreadId);
    dependencies.startMncTimers(client, channelMncId);
    dependencies.startEarningsResultWatcher(client, channelOtherId);
    dependencies.addInlineResponses(client, sharedData.assets, sharedData.assetCommands);
    dependencies.addTriggerResponses(client, sharedData.assets, sharedData.assetCommandsWithPrefix, sharedData.whatIsAssets, sharedData.paywallAssets);
    dependencies.interactSlashCommands(client, sharedData.assets, sharedData.assetCommands, sharedData.whatIsAssets, sharedData.tickers, sharedData.paywallAssets);
    startupState.markHandlersAttached();

    logger.log(
      "info",
      {
        startup_phase: "phase-a",
        message: "Core handlers attached.",
      },
    );
    phaseAFinished();
    logger.log(
      "info",
      "Bot connected. Warmup in progress.",
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
