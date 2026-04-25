/* eslint-disable import/extensions */
import {Client, GatewayIntentBits, Partials, PermissionFlagsBits} from "discord.js";
import {getGenericAssets, getAssets} from "./assets.js";
import {clownboard} from "./clownboard.js";
import {getDiscordRateLimitRetryAfterMs} from "./discord-retry-after.js";
import {getInteractiveClientCacheFactory} from "./discord-client-options.js";
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
  assetRecoveryRetryMs: number;
  assetRecoveryMaxRetryMs: number;
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
  calendarReminderAssets: any[];
  earningsReminderAssets: any[];
  paywallAssets: any[];
  tickers: Ticker[];
  assetCommands: string[];
  assetCommandsWithPrefix: string[];
};

const defaultLoginTimeoutMs = 30_000;
const defaultWarmupMaxAttempts = 4;
const defaultWarmupInitialRetryDelayMs = 500;
const defaultWarmupMaxRetryDelayMs = 15_000;
const defaultSlashCommandDebounceMs = 250;
const defaultAssetRecoveryRetryMs = 60_000;
const defaultAssetRecoveryMaxRetryMs = 30 * 60_000;
const slashCommandCreateLimitCooldownMs = 24 * 60 * 60_000;

type ErrorLogDetails = {
  discord_error_message?: string;
  error_name?: string;
  error_message: string;
  error_stack?: string;
};

type StartupPreflightFailure = {
  detail: string;
  label: string;
  reference: string;
  requiredPermission?: string;
  scope: "channel" | "config" | "guild" | "message" | "permission" | "role";
};

type StartupPreflightOptions = {
  brokerYesRoleId: string;
  channelClownboardId: string;
  channelMncId: string;
  channelNyseId: string;
  channelOtherId: string;
  configuredDiscordGuildId: string;
  mutedRoleId: string;
  roleAssignmentBrokerMessageId: string;
  roleAssignmentChannelId: string;
  roleAssignmentSpecialMessageId: string;
};

class StartupPreflightError extends Error {
  public readonly failures: StartupPreflightFailure[];

  constructor(failures: StartupPreflightFailure[]) {
    super(`Startup preflight failed with ${failures.length} issue(s).`);
    this.name = "StartupPreflightError";
    this.failures = failures;
  }
}

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
    assetRecoveryRetryMs: options.assetRecoveryRetryMs ?? defaultAssetRecoveryRetryMs,
    assetRecoveryMaxRetryMs: options.assetRecoveryMaxRetryMs ?? defaultAssetRecoveryMaxRetryMs,
  };
}

function waitWithTimer(delayMs: number, setTimeoutFn: typeof setTimeout): Promise<void> {
  return new Promise(resolve => {
    setTimeoutFn(resolve, delayMs);
  });
}

function toErrorLogDetails(error: unknown, options: {includeStack?: boolean;} = {}): ErrorLogDetails {
  const includeStack = false !== options.includeStack;
  if (error instanceof Error) {
    const unknownError = error as Error & {
      discordErrorMessage?: string;
      rawError?: {message?: string;};
    };
    const discordErrorMessage = "string" === typeof unknownError.discordErrorMessage && "" !== unknownError.discordErrorMessage.trim()
      ? unknownError.discordErrorMessage
      : "string" === typeof unknownError.rawError?.message && "" !== unknownError.rawError.message.trim()
        ? unknownError.rawError.message
        : undefined;
    return {
      ...(discordErrorMessage ? {discord_error_message: discordErrorMessage} : {}),
      error_name: error.name,
      error_message: error.message,
      ...(true === includeStack && "string" === typeof error.stack ? {error_stack: error.stack} : {}),
    };
  }

  return {
    error_message: String(error),
  };
}

function isSlashCommandCreateLimitError(error: unknown): boolean {
  return error instanceof Error && "SlashRegistrationCreateLimitError" === error.name;
}

function getSlashCommandRetryAfterMs(error: unknown): number | undefined {
  return getDiscordRateLimitRetryAfterMs(error);
}

function toPermissionName(permission: bigint): string {
  const permissionName = Object.entries(PermissionFlagsBits)
    .find(([, value]) => value === permission)?.[0];
  return permissionName ?? String(permission);
}

async function getClientGuild(client: Client, guildId: string) {
  const cachedGuild = client.guilds.cache.get(guildId);
  if (cachedGuild) {
    return cachedGuild;
  }

  if ("function" !== typeof client.guilds.fetch) {
    return undefined;
  }

  return client.guilds.fetch(guildId).catch(() => undefined);
}

async function getClientChannel(client: Client, channelId: string) {
  const cachedChannel = client.channels.cache.get(channelId);
  if (cachedChannel) {
    return cachedChannel;
  }

  if ("function" !== typeof client.channels.fetch) {
    return undefined;
  }

  return client.channels.fetch(channelId).catch(() => undefined);
}

async function getGuildRole(guild: any, roleId: string) {
  const cachedRole = guild?.roles?.cache?.get?.(roleId);
  if (cachedRole) {
    return cachedRole;
  }

  if ("function" !== typeof guild?.roles?.fetch) {
    return undefined;
  }

  return guild.roles.fetch(roleId).catch(() => undefined);
}

function getChannelPermissions(channel: any, member: any) {
  if ("function" !== typeof channel?.permissionsFor) {
    return undefined;
  }

  return channel.permissionsFor(member);
}

async function runStartupPreflight(
  client: Client,
  logger: Logger,
  options: StartupPreflightOptions,
) {
  const failures: StartupPreflightFailure[] = [];
  let checkedChannels = 0;
  let checkedRoleAssignmentMessages = 0;
  let checkedRoles = 0;

  const addFailure = (failure: StartupPreflightFailure) => {
    failures.push(failure);
  };

  if ("" === options.configuredDiscordGuildId) {
    addFailure({
      scope: "config",
      label: "discord guild",
      reference: "discord_guild_ID",
      detail: "Missing Discord guild ID configuration.",
    });
  }

  const guild = "" !== options.configuredDiscordGuildId
    ? await getClientGuild(client, options.configuredDiscordGuildId)
    : undefined;
  if (!guild) {
    addFailure({
      scope: "guild",
      label: "discord guild",
      reference: options.configuredDiscordGuildId || "discord_guild_ID",
      detail: "Configured Discord guild is unavailable.",
    });
  }

  const botMember = guild
    ? guild.members.me ?? await guild.members.fetchMe?.().catch(() => undefined)
    : undefined;
  if (!botMember) {
    addFailure({
      scope: "guild",
      label: "bot member",
      reference: options.configuredDiscordGuildId || "discord_guild_ID",
      detail: "Unable to resolve the bot member in the configured guild.",
    });
  }

  const checkChannel = async ({
    channelId,
    label,
    requireMessageFetch,
    requireSendCapability,
    requiredPermissions,
  }: {
    channelId: string;
    label: string;
    requireMessageFetch?: boolean;
    requireSendCapability?: boolean;
    requiredPermissions: bigint[];
  }) => {
    if ("" === channelId) {
      addFailure({
        scope: "config",
        label,
        reference: label,
        detail: "Missing configuration for critical channel.",
      });
      return undefined;
    }

    const channel = await getClientChannel(client, channelId);
    if (!channel) {
      addFailure({
        scope: "channel",
        label,
        reference: channelId,
        detail: "Critical channel is unavailable.",
      });
      return undefined;
    }

    checkedChannels += 1;

    if (true === requireSendCapability && "function" !== typeof (channel as any).send) {
      addFailure({
        scope: "channel",
        label,
        reference: channelId,
        detail: "Critical channel is not send-capable.",
      });
    }

    if (true === requireMessageFetch && "function" !== typeof (channel as any).messages?.fetch) {
      addFailure({
        scope: "channel",
        label,
        reference: channelId,
        detail: "Critical channel does not support message fetch operations.",
      });
    }

    if (!botMember) {
      return channel;
    }

    const permissions = getChannelPermissions(channel, botMember);
    if (!permissions || "function" !== typeof permissions.has) {
      addFailure({
        scope: "permission",
        label,
        reference: channelId,
        detail: "Unable to determine channel permissions for the bot member.",
      });
      return channel;
    }

    for (const permission of requiredPermissions) {
      if (true !== permissions.has(permission)) {
        addFailure({
          scope: "permission",
          label,
          reference: channelId,
          requiredPermission: toPermissionName(permission),
          detail: "Missing required channel permission.",
        });
      }
    }

    return channel;
  };

  await checkChannel({
    channelId: options.channelNyseId,
    label: "NYSE announcements",
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ],
  });
  await checkChannel({
    channelId: options.channelMncId,
    label: "MNC announcements",
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
    ],
  });
  await checkChannel({
    channelId: options.channelOtherId,
    label: "Other announcements",
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.AttachFiles,
    ],
  });
  await checkChannel({
    channelId: options.channelClownboardId,
    label: "clownboard",
    requireMessageFetch: true,
    requireSendCapability: true,
    requiredPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  });

  const roleAssignmentConfigured = "" !== options.roleAssignmentChannelId
    && "" !== options.roleAssignmentBrokerMessageId
    && "" !== options.roleAssignmentSpecialMessageId;
  if (roleAssignmentConfigured) {
    const roleAssignmentChannel = await checkChannel({
      channelId: options.roleAssignmentChannelId,
      label: "role assignment",
      requireMessageFetch: true,
      requiredPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
      ],
    });

    if ("function" === typeof (roleAssignmentChannel as any)?.messages?.fetch) {
      const brokerMessage = await roleAssignmentChannel.messages.fetch(options.roleAssignmentBrokerMessageId).catch(() => undefined);
      if (!brokerMessage) {
        addFailure({
          scope: "message",
          label: "role assignment broker message",
          reference: options.roleAssignmentBrokerMessageId,
          detail: "Configured role-assignment broker message is unavailable.",
        });
      } else {
        checkedRoleAssignmentMessages += 1;
      }

      const specialMessage = await roleAssignmentChannel.messages.fetch(options.roleAssignmentSpecialMessageId).catch(() => undefined);
      if (!specialMessage) {
        addFailure({
          scope: "message",
          label: "role assignment special message",
          reference: options.roleAssignmentSpecialMessageId,
          detail: "Configured role-assignment special message is unavailable.",
        });
      } else {
        checkedRoleAssignmentMessages += 1;
      }
    }
  }

  const roleManagementConfigured = [options.brokerYesRoleId, options.mutedRoleId].some(roleId => "" !== roleId)
    || roleAssignmentConfigured;
  const botHighestRolePosition = Number(botMember?.roles?.highest?.position);
  if (roleManagementConfigured) {
    if (true !== botMember?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
      addFailure({
        scope: "permission",
        label: "role management",
        reference: "ManageRoles",
        requiredPermission: "ManageRoles",
        detail: "Bot lacks ManageRoles permission required for role-management features.",
      });
    }

    if (false === Number.isFinite(botHighestRolePosition)) {
      addFailure({
        scope: "role",
        label: "bot highest role",
        reference: "guild.members.me.roles.highest",
        detail: "Unable to determine the bot's highest role position.",
      });
    }
  }

  const checkRole = async (label: string, roleId: string) => {
    if ("" === roleId || !guild) {
      return;
    }

    checkedRoles += 1;
    const role = await getGuildRole(guild, roleId);
    if (!role) {
      addFailure({
        scope: "role",
        label,
        reference: roleId,
        detail: "Configured role is unavailable.",
      });
      return;
    }

    if (true === role.managed) {
      addFailure({
        scope: "role",
        label,
        reference: roleId,
        detail: "Configured role is managed externally and cannot be assigned by the bot.",
      });
    }

    if (true === Number.isFinite(botHighestRolePosition) && botHighestRolePosition <= Number(role.position)) {
      addFailure({
        scope: "role",
        label,
        reference: roleId,
        detail: "Configured role is not below the bot's highest role.",
      });
    }
  };

  await checkRole("muted role", options.mutedRoleId);
  await checkRole("broker yes role", options.brokerYesRoleId);

  if (0 < failures.length) {
    for (const failure of failures) {
      logger.log(
        "error",
        {
          startup_phase: "phase-a",
          task: "preflight",
          preflight_scope: failure.scope,
          preflight_label: failure.label,
          preflight_reference: failure.reference,
          ...(failure.requiredPermission ? {required_permission: failure.requiredPermission} : {}),
          message: failure.detail,
        },
      );
    }

    throw new StartupPreflightError(failures);
  }

  logger.log(
    "info",
    {
      startup_phase: "phase-a",
      task: "preflight",
      guild_id: options.configuredDiscordGuildId,
      checked_channels: checkedChannels,
      checked_roles: checkedRoles,
      checked_role_assignment_messages: checkedRoleAssignmentMessages,
      message: "Startup preflight passed.",
    },
  );
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

  let assetRecoveryRetryHandle: ReturnType<typeof setTimeout> | undefined;
  let slashCommandSyncScheduledHandle: ReturnType<typeof setTimeout> | undefined;
  let slashCommandCreateLimitCooldownHandle: ReturnType<typeof setTimeout> | undefined;
  let assetRecoveryInProgress = false;
  let slashCommandSyncInFlight = false;
  let slashCommandSyncDirty = false;
  let otherTimersStarted = false;
  let genericAssetsLoaded = false;
  let tickersLoaded = false;
  let calendarReminderAssetsLoaded = false;
  let earningsReminderAssetsLoaded = false;
  let slashCommandSyncAttempts = 0;
  let slashCommandCreateLimitRetryAfterMs: number | undefined;
  let slashCommandCreateLimitSuppressedUntilMs: number | undefined;
  let failedGenericAssetDownloads = 0;
  let failedWhatisAssetDownloads = 0;
  let assetRecoveryAttempt = 0;
  let hasTaskFailure = false;
  startupState.markWarmupTask("asset-downloads", "running");

  const tryStartOtherTimers = () => {
    if (true === otherTimersStarted) {
      return;
    }

    if (false === genericAssetsLoaded ||
        false === tickersLoaded ||
        false === calendarReminderAssetsLoaded ||
        false === earningsReminderAssetsLoaded) {
      return;
    }

    dependencies.startOtherTimers(
      client,
      channelOtherId,
      sharedData.assets,
      sharedData.tickers,
      sharedData.calendarReminderAssets,
      sharedData.earningsReminderAssets,
    );
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
        if (attempt === dependencies.warmupMaxAttempts) {
          logger.log(
            "error",
            {
              startup_phase: "phase-b",
              degraded: true,
              task,
              attempt,
              max_attempts: dependencies.warmupMaxAttempts,
              ...toErrorLogDetails(error),
              message: "Warmup task failed after maximum retries.",
            },
          );
          break;
        }

        const exponentialRetryInMs = Math.min(
          dependencies.warmupInitialRetryDelayMs * (2 ** (attempt - 1)),
          dependencies.warmupMaxRetryDelayMs,
        );
        const retryInMs = exponentialRetryInMs;
        logger.log(
          "warn",
          {
            startup_phase: "phase-b",
            degraded: true,
            task,
            attempt,
            max_attempts: dependencies.warmupMaxAttempts,
            retry_in_ms: retryInMs,
            ...toErrorLogDetails(error),
            message: "Warmup task failed. Retrying.",
          },
        );
        await waitWithTimer(retryInMs, dependencies.setTimeoutFn);
      }
    }

    startupState.markWarmupTask(task, "failed");
    throw lastError;
  };

  const getFailedAssetDownloads = () => failedGenericAssetDownloads + failedWhatisAssetDownloads;
  const getAssetRecoveryRetryDelayMs = () => {
    const cappedExponent = Math.min(assetRecoveryAttempt, 16);
    const backoffMs = dependencies.assetRecoveryRetryMs * (2 ** cappedExponent);
    return Math.min(backoffMs, dependencies.assetRecoveryMaxRetryMs);
  };

  const trackAssetDownloadFailures = (task: "generic-assets" | "whatis-assets", assets: any[]) => {
    const failedDownloads = assets.filter(asset => true === (asset as any).downloadFailed).length;
    if ("generic-assets" === task) {
      failedGenericAssetDownloads = failedDownloads;
    } else {
      failedWhatisAssetDownloads = failedDownloads;
    }

    if (0 === failedDownloads) {
      return;
    }

    logger.log(
      "warn",
      {
        startup_phase: "phase-b",
        degraded: true,
        task,
        failed_asset_downloads: failedDownloads,
        message: "Some DRACOON assets could not be downloaded.",
      },
    );
  };

  const clearSlashCommandCreateLimitSuppression = () => {
    slashCommandCreateLimitRetryAfterMs = undefined;
    slashCommandCreateLimitSuppressedUntilMs = undefined;
    if ("undefined" !== typeof slashCommandCreateLimitCooldownHandle) {
      dependencies.clearTimeoutFn(slashCommandCreateLimitCooldownHandle);
      slashCommandCreateLimitCooldownHandle = undefined;
    }
  };

  const isSlashCommandSyncSuppressed = () => {
    if ("number" !== typeof slashCommandCreateLimitSuppressedUntilMs) {
      return false;
    }

    if (Date.now() >= slashCommandCreateLimitSuppressedUntilMs) {
      clearSlashCommandCreateLimitSuppression();
      return false;
    }

    return true;
  };

  const logSlashCommandSyncSuppressed = (message: string) => {
    logger.log(
      "warn",
      {
        startup_phase: "phase-b",
        task: "slash-commands",
        daily_create_limit_reached: true,
        ...(slashCommandCreateLimitSuppressedUntilMs ? {suppressed_until_ms: slashCommandCreateLimitSuppressedUntilMs} : {}),
        ...(slashCommandCreateLimitRetryAfterMs ? {retry_after_ms: slashCommandCreateLimitRetryAfterMs} : {}),
        message,
      },
    );
  };

  const scheduleSlashCommandSync = (message: string, delayMs = dependencies.slashCommandDebounceMs, attempt = 1) => {
    if (false === genericAssetsLoaded || "ready" !== startupState.getSnapshot().remoteWarmupStatus) {
      return;
    }

    if (true === isSlashCommandSyncSuppressed()) {
      logSlashCommandSyncSuppressed("slash-registration:daily-create-limit-suppressed");
      return;
    }

    if (true === slashCommandSyncInFlight) {
      slashCommandSyncDirty = true;
      logger.log(
        "info",
        {
          startup_phase: "phase-b",
          task: "slash-commands",
          delay_ms: delayMs,
          attempt,
          coalesced: true,
          message: "slash-registration:scheduled",
        },
      );
      return;
    }

    if ("undefined" !== typeof slashCommandSyncScheduledHandle) {
      return;
    }

    logger.log(
      "info",
      {
        startup_phase: "phase-b",
        task: "slash-commands",
        delay_ms: delayMs,
        attempt,
        message,
      },
    );

    slashCommandSyncScheduledHandle = dependencies.setTimeoutFn(() => {
      slashCommandSyncScheduledHandle = undefined;
      void runSlashCommandSync(attempt);
    }, delayMs);
    (slashCommandSyncScheduledHandle as any).unref?.();
  };

  const scheduleSlashCommandCreateLimitCooldownRelease = () => {
    if ("undefined" !== typeof slashCommandCreateLimitCooldownHandle) {
      dependencies.clearTimeoutFn(slashCommandCreateLimitCooldownHandle);
      slashCommandCreateLimitCooldownHandle = undefined;
    }

    slashCommandCreateLimitSuppressedUntilMs = Date.now() + slashCommandCreateLimitCooldownMs;
    slashCommandCreateLimitCooldownHandle = dependencies.setTimeoutFn(() => {
      slashCommandCreateLimitCooldownHandle = undefined;
      clearSlashCommandCreateLimitSuppression();
      logger.log(
        "info",
        {
          startup_phase: "phase-b",
          task: "slash-commands",
          cooldown_ms: slashCommandCreateLimitCooldownMs,
          message: "slash-registration:cooldown-expired-retry",
        },
      );
      scheduleSlashCommandSync("slash-registration:scheduled", dependencies.slashCommandDebounceMs, 1);
    }, slashCommandCreateLimitCooldownMs);
    (slashCommandCreateLimitCooldownHandle as any).unref?.();
  };

  const runSlashCommandSync = async (attempt: number) => {
    if (true === slashCommandSyncInFlight) {
      slashCommandSyncDirty = true;
      return;
    }

    if (false === genericAssetsLoaded || "ready" !== startupState.getSnapshot().remoteWarmupStatus) {
      return;
    }

    if (true === isSlashCommandSyncSuppressed()) {
      logSlashCommandSyncSuppressed("slash-registration:daily-create-limit-suppressed");
      return;
    }

    slashCommandSyncInFlight = true;
    slashCommandSyncAttempts += 1;
    let queuedRetryDelayMs: number | undefined;
    let queuedRetryAttempt: number | undefined;

    try {
      await dependencies.defineSlashCommands(sharedData.assets, sharedData.whatIsAssets, sharedData.userAssets);
    } catch (error: unknown) {
      startupState.setLastError(error);

      if (true === isSlashCommandCreateLimitError(error)) {
        slashCommandCreateLimitRetryAfterMs = getSlashCommandRetryAfterMs(error);
        scheduleSlashCommandCreateLimitCooldownRelease();
        logger.log(
          "warn",
          {
            startup_phase: "phase-b",
            task: "slash-commands",
            attempt,
            sync_attempt: slashCommandSyncAttempts,
            cooldown_ms: slashCommandCreateLimitCooldownMs,
            ...(slashCommandCreateLimitSuppressedUntilMs ? {suppressed_until_ms: slashCommandCreateLimitSuppressedUntilMs} : {}),
            ...(slashCommandCreateLimitRetryAfterMs ? {retry_after_ms: slashCommandCreateLimitRetryAfterMs} : {}),
            ...toErrorLogDetails(error, {includeStack: false}),
            message: "slash-registration:daily-create-limit-suppressed",
          },
        );
      } else if (error instanceof Error && "SlashRegistrationRateLimitError" === error.name) {
        const retryAfterMs = getSlashCommandRetryAfterMs(error) ?? 15_000;
        if (attempt < dependencies.warmupMaxAttempts) {
          logger.log(
            "warn",
            {
              startup_phase: "phase-b",
              task: "slash-commands",
              attempt,
              max_attempts: dependencies.warmupMaxAttempts,
              retry_after_ms: retryAfterMs,
              retry_in_ms: retryAfterMs,
              ...toErrorLogDetails(error, {includeStack: false}),
              message: "slash-registration:rate-limited",
            },
          );
          queuedRetryDelayMs = retryAfterMs;
          queuedRetryAttempt = attempt + 1;
        } else {
          logger.log(
            "warn",
            {
              startup_phase: "phase-b",
              task: "slash-commands",
              attempt,
              max_attempts: dependencies.warmupMaxAttempts,
              retry_after_ms: retryAfterMs,
              ...toErrorLogDetails(error, {includeStack: false}),
              message: "slash-registration:rate-limit-retries-exhausted",
            },
          );
        }
      } else {
        logger.log(
          "error",
          {
            startup_phase: "phase-b",
            task: "slash-commands",
            attempt,
            sync_attempt: slashCommandSyncAttempts,
            ...toErrorLogDetails(error),
            message: "Automatic slash command sync failed.",
          },
        );
      }
    } finally {
      slashCommandSyncInFlight = false;

      if ("number" === typeof queuedRetryDelayMs && "number" === typeof queuedRetryAttempt) {
        slashCommandSyncDirty = false;
        scheduleSlashCommandSync("slash-registration:scheduled", queuedRetryDelayMs, queuedRetryAttempt);
        return;
      }

      if (true === slashCommandSyncDirty) {
        slashCommandSyncDirty = false;
        scheduleSlashCommandSync("slash-registration:scheduled");
      }
    }
  };

  const scheduleAssetRecovery = () => {
    if (true === hasTaskFailure || 0 === getFailedAssetDownloads()) {
      return;
    }

    if (true === assetRecoveryInProgress || "undefined" !== typeof assetRecoveryRetryHandle) {
      return;
    }

    const retryInMs = getAssetRecoveryRetryDelayMs();
    assetRecoveryRetryHandle = dependencies.setTimeoutFn(() => {
      assetRecoveryRetryHandle = undefined;
      void recoverFailedAssets();
    }, retryInMs);
    (assetRecoveryRetryHandle as any).unref?.();
  };

  const recoverFailedAssets = async () => {
    if (true === hasTaskFailure || true === assetRecoveryInProgress || 0 === getFailedAssetDownloads()) {
      return;
    }

    assetRecoveryInProgress = true;
    startupState.markWarmupTask("asset-downloads", "running");

    try {
      if (0 < getFailedAssetDownloads()) {
        const [genericAssets, whatIsAssets] = await Promise.all([
          dependencies.getGenericAssets(),
          dependencies.getAssets("whatis"),
        ]);

        replaceArray(sharedData.assets, genericAssets);
        replaceArray(sharedData.whatIsAssets, whatIsAssets);
        trackAssetDownloadFailures("generic-assets", genericAssets);
        trackAssetDownloadFailures("whatis-assets", whatIsAssets);
        rebuildAssetCommands(sharedData);
        genericAssetsLoaded = true;
        tryStartOtherTimers();
      }

      const failedAssetDownloads = getFailedAssetDownloads();
      startupState.markWarmupTask("asset-downloads", 0 === failedAssetDownloads ? "success" : "failed");

      if (0 === failedAssetDownloads) {
        assetRecoveryAttempt = 0;
        startupState.setRemoteWarmupStatus("ready");
        logger.log(
          "info",
          {
            startup_phase: "phase-b",
            task: "asset-recovery",
            degraded: false,
            message: "Recovered previously failed asset downloads.",
          },
        );
        logger.log(
          "info",
          "Bot ready.",
        );
        scheduleSlashCommandSync("slash-registration:scheduled");
      } else {
        assetRecoveryAttempt += 1;
        logger.log(
          "warn",
          {
            startup_phase: "phase-b",
            task: "asset-recovery",
            degraded: true,
            failed_asset_downloads: failedAssetDownloads,
            retry_in_ms: getAssetRecoveryRetryDelayMs(),
            message: "Recovery incomplete. Retrying.",
          },
        );
      }
    } catch (error: unknown) {
      assetRecoveryAttempt += 1;
      startupState.setLastError(error);
      if (0 < getFailedAssetDownloads()) {
        startupState.markWarmupTask("asset-downloads", "failed");
      }
      logger.log(
        "warn",
        {
          startup_phase: "phase-b",
          task: "asset-recovery",
          degraded: true,
          retry_in_ms: getAssetRecoveryRetryDelayMs(),
          ...toErrorLogDetails(error),
          message: "Recovery attempt failed. Retrying.",
        },
      );
    } finally {
      assetRecoveryInProgress = false;
      scheduleAssetRecovery();
    }
  };

  try {
    const warmupTasks: Promise<void>[] = [];

    warmupTasks.push((async () => {
      const genericAssets = await runWarmupTaskWithRetry("generic-assets", async () => dependencies.getGenericAssets());
      replaceArray(sharedData.assets, genericAssets);
      trackAssetDownloadFailures("generic-assets", genericAssets);
      rebuildAssetCommands(sharedData);
      genericAssetsLoaded = true;
      tryStartOtherTimers();
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
      trackAssetDownloadFailures("whatis-assets", whatIsAssets);
      logger.log(
        "info",
        `Loaded and cached ${sharedData.whatIsAssets.length} whatis assets.`,
      );
    })());

    warmupTasks.push((async () => {
      const userAssets = await runWarmupTaskWithRetry("user-assets", async () => dependencies.getAssets("user"));
      replaceArray(sharedData.userAssets, userAssets);
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

    warmupTasks.push((async () => {
      const calendarReminderAssets = await runWarmupTaskWithRetry("calendar-reminder-assets", async () => dependencies.getAssets("calendarreminder"));
      replaceArray(sharedData.calendarReminderAssets, calendarReminderAssets);
      calendarReminderAssetsLoaded = true;
      tryStartOtherTimers();
      logger.log(
        "info",
        `Loaded and cached ${sharedData.calendarReminderAssets.length} calendar reminder assets.`,
      );
    })());

    warmupTasks.push((async () => {
      const earningsReminderAssets = await runWarmupTaskWithRetry("earnings-reminder-assets", async () => dependencies.getAssets("earningsreminder"));
      replaceArray(sharedData.earningsReminderAssets, earningsReminderAssets);
      earningsReminderAssetsLoaded = true;
      tryStartOtherTimers();
      logger.log(
        "info",
        `Loaded and cached ${sharedData.earningsReminderAssets.length} earnings reminder assets.`,
      );
    })());

    warmupTasks.push((async () => {
      const paywallAssets = await runWarmupTaskWithRetry("paywall-assets", async () => dependencies.getAssets("paywall"));
      replaceArray(sharedData.paywallAssets, paywallAssets);
      logger.log(
        "info",
        `Loaded and cached ${sharedData.paywallAssets.length} paywall assets.`,
      );
    })());

    if ("production" === environment) {
      warmupTasks.push((async () => {
        await runWarmupTaskWithRetry("market-data", async () => dependencies.updateMarketData());
      })());
    }

    const warmupResults = await Promise.allSettled(warmupTasks);
    hasTaskFailure = warmupResults.some(result => "rejected" === result.status);
    const failedAssetDownloads = getFailedAssetDownloads();
    startupState.markWarmupTask("asset-downloads", 0 === failedAssetDownloads ? "success" : "failed");
    const hasWarmupFailure = hasTaskFailure || failedAssetDownloads > 0;

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
      scheduleAssetRecovery();
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
      logger.log(
        "info",
        "Bot ready.",
      );
      scheduleSlashCommandSync("slash-registration:scheduled");
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
