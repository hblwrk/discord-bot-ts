/* eslint-disable yoda */
/* eslint-disable complexity */
import {AttachmentBuilder, EmbedBuilder, PermissionFlagsBits, REST, Routes, SlashCommandBuilder} from "discord.js";
import validator from "validator";
import {getAssetByName, ImageAsset, TextAsset} from "./assets.js";
import {cryptodice} from "./crypto-dice.js";
import {getDiscordRateLimitRetryAfterMs, toDiscordTimerMs} from "./discord-retry-after.js";
import {google, lmgtfy} from "./lmgtfy.js";
import {getDiscordLogger, getLogger} from "./logging.js";
import {getRandomQuote} from "./random-quote.js";
import {readSecret} from "./secrets.js";
import {
  EARNINGS_MAX_MESSAGE_LENGTH,
  EARNINGS_MAX_MESSAGES_SLASH,
  getEarningsResult,
  getEarningsMessages,
} from "./earnings.js";
import {
  CALENDAR_MAX_MESSAGE_LENGTH,
  CALENDAR_MAX_MESSAGES_SLASH,
  getCalendarEvents,
  getCalendarMessages,
} from "./calendar.js";
import {Ticker} from "./tickers.js";

const logger = getLogger();
const noMentions = {
  parse: [],
};
const noQuoteMessage = "Keine passenden Zitate gefunden.";
const islandboiCooldownMs = 60_000;
const islandboiCooldownByUser = new Map<string, number>();
const islandboiUnmuteTimers = new Map<string, ReturnType<typeof setTimeout>>();
const slashCommandRestTimeoutMs = 120_000;
const slashCommandNameLogLimit = 20;

class SlashRegistrationMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlashRegistrationMismatchError";
  }
}

class SlashRegistrationCreateLimitError extends Error {
  public readonly retryAfterMs: number;
  public readonly discordErrorMessage?: string;

  constructor(message: string, retryAfterMs: number, discordErrorMessage?: string) {
    super(message);
    this.name = "SlashRegistrationCreateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.discordErrorMessage = discordErrorMessage;
  }
}

class SlashRegistrationRateLimitError extends Error {
  public readonly retryAfterMs: number;
  public readonly isGlobal: boolean;
  public readonly discordErrorMessage?: string;

  constructor(message: string, retryAfterMs: number, isGlobal: boolean, discordErrorMessage?: string) {
    super(message);
    this.name = "SlashRegistrationRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.isGlobal = isGlobal;
    this.discordErrorMessage = discordErrorMessage;
  }
}

type SlashRegistrationDiff = {
  expectedCommandNames: string[];
  returnedCommandNames: string[];
  missingCommandNames: string[];
  unexpectedCommandNames: string[];
  changedCommandNames: string[];
  truncated: boolean;
};

type SlashCommandPayloadBuildResult = {
  slashCommands: any[];
  dracoonAssetCommandNames: string[];
  expectedCommandNames: string[];
  assetTriggersTotal: number;
  assetCommandsRegistered: number;
  fixedCommandsRegistered: number;
  skippedEmptyTriggers: number;
  skippedDuplicateNames: number;
  imageDracoonAssetCommandsRegistered: number;
  imageNonDracoonAssetCommandsRegistered: number;
  textAssetCommandsRegistered: number;
};

type CanonicalSlashCommandChoice = {
  name: string;
  value: unknown;
};

type CanonicalSlashCommandOption = {
  type: number;
  name: string;
  description: string;
  required: boolean;
  autocomplete: boolean;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  channel_types: number[];
  choices: CanonicalSlashCommandChoice[];
  options: CanonicalSlashCommandOption[];
};

type CanonicalSlashCommand = {
  type: number;
  name: string;
  description: string;
  options: CanonicalSlashCommandOption[];
};

type RestRateLimitData = {
  global?: boolean;
  hash?: string;
  limit?: number;
  majorParameter?: string;
  method?: string;
  retryAfter?: number;
  route?: string;
  scope?: string;
  sublimitTimeout?: number;
  timeToReset?: number;
  url?: string;
};

function toSlashCommandName(trigger: string): string {
  return trigger
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(" ", "_")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}

function toSlashRegistrationErrorDetails(error: unknown) {
  if (error instanceof Error) {
    const unknownError = error as Error & {
      code?: string | number;
      discordErrorMessage?: string;
      status?: number;
      rawError?: {retry_after?: unknown; global?: boolean; message?: string;};
    };
    const discordErrorMessage = getDiscordErrorMessage(error);
    return {
      error_name: unknownError.name,
      error_message: unknownError.message,
      ...(discordErrorMessage ? {discord_error_message: discordErrorMessage} : {}),
      error_code: unknownError.code,
      error_status: unknownError.status,
      retry_after_ms: getDiscordRateLimitRetryAfterMs(error),
      rate_limit_global: "boolean" === typeof unknownError.rawError?.global
        ? unknownError.rawError.global
        : undefined,
    };
  }

  return {
    error_message: String(error),
  };
}

function toCanonicalSlashCommandChoice(choice: unknown): CanonicalSlashCommandChoice {
  if ("object" !== typeof choice || null === choice) {
    return {
      name: "",
      value: "",
    };
  }

  return {
    name: "string" === typeof (choice as any).name ? (choice as any).name : "",
    value: (choice as any).value,
  };
}

function toCanonicalSlashCommandOption(option: unknown): CanonicalSlashCommandOption {
  if ("object" !== typeof option || null === option) {
    return {
      type: 0,
      name: "",
      description: "",
      required: false,
      autocomplete: false,
      channel_types: [],
      choices: [],
      options: [],
    };
  }

  const rawOption = option as any;
  const canonicalOption: CanonicalSlashCommandOption = {
    type: Number(rawOption.type ?? 0),
    name: "string" === typeof rawOption.name ? rawOption.name : "",
    description: "string" === typeof rawOption.description ? rawOption.description : "",
    required: true === rawOption.required,
    autocomplete: true === rawOption.autocomplete,
    channel_types: Array.isArray(rawOption.channel_types)
      ? rawOption.channel_types.map((channelType: unknown) => Number(channelType))
      : [],
    choices: Array.isArray(rawOption.choices)
      ? rawOption.choices.map(toCanonicalSlashCommandChoice)
      : [],
    options: Array.isArray(rawOption.options)
      ? rawOption.options.map(toCanonicalSlashCommandOption)
      : [],
  };

  if ("number" === typeof rawOption.min_value) {
    canonicalOption.min_value = rawOption.min_value;
  }

  if ("number" === typeof rawOption.max_value) {
    canonicalOption.max_value = rawOption.max_value;
  }

  if ("number" === typeof rawOption.min_length) {
    canonicalOption.min_length = rawOption.min_length;
  }

  if ("number" === typeof rawOption.max_length) {
    canonicalOption.max_length = rawOption.max_length;
  }

  return canonicalOption;
}

function toCanonicalSlashCommand(command: unknown): CanonicalSlashCommand {
  if ("object" !== typeof command || null === command) {
    return {
      type: 1,
      name: "",
      description: "",
      options: [],
    };
  }

  const rawCommand = command as any;
  return {
    type: Number(rawCommand.type ?? 1),
    name: "string" === typeof rawCommand.name ? rawCommand.name : "",
    description: "string" === typeof rawCommand.description ? rawCommand.description : "",
    options: Array.isArray(rawCommand.options)
      ? rawCommand.options.map(toCanonicalSlashCommandOption)
      : [],
  };
}

function normalizeSlashCommandPayload(slashCommands: unknown): CanonicalSlashCommand[] {
  if (false === Array.isArray(slashCommands)) {
    return [];
  }

  return slashCommands
    .map(toCanonicalSlashCommand)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getSlashCommandPayloadHash(slashCommands: unknown): string {
  return JSON.stringify(normalizeSlashCommandPayload(slashCommands));
}

function getSlashCommandNamesFromPayload(slashCommands: unknown): string[] {
  return normalizeSlashCommandPayload(slashCommands)
    .map(command => command.name)
    .filter(commandName => "" !== commandName);
}

function computeSlashRegistrationDiff(expectedSlashCommands: unknown, returnedSlashCommands: unknown): SlashRegistrationDiff {
  const expectedCommands = normalizeSlashCommandPayload(expectedSlashCommands);
  const returnedCommands = normalizeSlashCommandPayload(returnedSlashCommands);
  const expectedCommandNames = expectedCommands.map(command => command.name);
  const returnedCommandNames = returnedCommands.map(command => command.name);
  const expectedCommandHashes = new Map<string, string>();
  const returnedCommandHashes = new Map<string, string>();

  for (const command of expectedCommands) {
    expectedCommandHashes.set(command.name, JSON.stringify(command));
  }

  for (const command of returnedCommands) {
    returnedCommandHashes.set(command.name, JSON.stringify(command));
  }

  const expectedCommandNameSet = new Set(expectedCommandNames);
  const returnedCommandNameSet = new Set(returnedCommandNames);
  const missingCommandNames = expectedCommandNames.filter(commandName => false === returnedCommandNameSet.has(commandName));
  const unexpectedCommandNames = returnedCommandNames.filter(commandName => false === expectedCommandNameSet.has(commandName));
  const changedCommandNames = expectedCommandNames.filter(commandName => {
    return true === returnedCommandNameSet.has(commandName)
      && expectedCommandHashes.get(commandName) !== returnedCommandHashes.get(commandName);
  });

  return {
    expectedCommandNames,
    returnedCommandNames,
    missingCommandNames,
    unexpectedCommandNames,
    changedCommandNames,
    truncated: returnedCommandNames.length < expectedCommandNames.length,
  };
}

function hasSlashRegistrationMismatch(diff: SlashRegistrationDiff): boolean {
  return 0 < diff.missingCommandNames.length
    || 0 < diff.unexpectedCommandNames.length
    || 0 < diff.changedCommandNames.length;
}

function getDiscordErrorMessage(error: unknown): string | undefined {
  if (false === (error instanceof Error)) {
    return undefined;
  }

  const unknownError = error as Error & {
    discordErrorMessage?: string;
    rawError?: {message?: string;};
  };
  if ("string" === typeof unknownError.discordErrorMessage && "" !== unknownError.discordErrorMessage.trim()) {
    return unknownError.discordErrorMessage;
  }

  if ("string" === typeof unknownError.rawError?.message && "" !== unknownError.rawError.message.trim()) {
    return unknownError.rawError.message;
  }

  if ("" !== unknownError.message.trim()) {
    return unknownError.message;
  }

  return undefined;
}

function toSlashRegistrationCreateLimitError(error: unknown): SlashRegistrationCreateLimitError | undefined {
  if (false === (error instanceof Error)) {
    return undefined;
  }

  const unknownError = error as Error & {
    code?: string | number;
    rawError?: {retry_after?: unknown; message?: string;};
  };
  const errorCode = Number(unknownError.code);
  const errorMessage = unknownError.message ?? "";
  const rawErrorMessage = unknownError.rawError?.message ?? "";
  const isDailyCreateLimitError = 30034 === errorCode
    || /daily application command creates/i.test(errorMessage)
    || /daily application command creates/i.test(rawErrorMessage);
  if (false === isDailyCreateLimitError) {
    return undefined;
  }

  const retryAfterMs = getDiscordRateLimitRetryAfterMs(error) ?? 5 * 60_000;
  return new SlashRegistrationCreateLimitError(
    "Slash command create limit reached. Further automatic retries should be suppressed for this process.",
    retryAfterMs,
    getDiscordErrorMessage(error),
  );
}

function toSlashRegistrationRateLimitError(error: unknown): SlashRegistrationRateLimitError | undefined {
  if (false === (error instanceof Error)) {
    return undefined;
  }

  const unknownError = error as Error & {
    status?: number;
    rawError?: {retry_after?: unknown; message?: string; global?: boolean;};
  };
  const errorStatus = Number(unknownError.status);
  const errorMessage = unknownError.message ?? "";
  const rawErrorMessage = unknownError.rawError?.message ?? "";
  const isRateLimitError = 429 === errorStatus
    || /you are being rate limited/i.test(errorMessage)
    || /you are being rate limited/i.test(rawErrorMessage);
  if (false === isRateLimitError) {
    return undefined;
  }

  const retryAfterMs = getDiscordRateLimitRetryAfterMs(error) ?? 15_000;
  const isGlobal = Boolean(unknownError.rawError?.global);
  return new SlashRegistrationRateLimitError(
    "Slash command registration rate limited. Waiting before retry.",
    retryAfterMs,
    isGlobal,
    getDiscordErrorMessage(error),
  );
}

export function buildSlashCommandPayload(assets, whatIsAssets, userAssets): SlashCommandPayloadBuildResult {
  const whatIsAssetsChoices = [];
  for (const asset of whatIsAssets) {
    whatIsAssetsChoices.push({name: asset.title, value: asset.name});
  }

  const userAssetsChoices = [];
  for (const asset of userAssets) {
    userAssetsChoices.push({name: asset.name, value: asset.name});
  }

  const slashCommands = [];
  const seenCommandNames = new Set<string>();
  const dracoonAssetCommandNames = new Set<string>();
  let assetTriggersTotal = 0;
  let skippedEmptyTriggers = 0;
  let skippedDuplicateNames = 0;
  let imageDracoonAssetCommandsRegistered = 0;
  let imageNonDracoonAssetCommandsRegistered = 0;
  let textAssetCommandsRegistered = 0;
  for (const asset of assets) {
    if ((asset instanceof ImageAsset || asset instanceof TextAsset) && 0 <= asset.trigger.length) {
      for (const trigger of asset.trigger) {
        assetTriggersTotal += 1;
        const slashCommandName = toSlashCommandName(trigger);
        if ("" === slashCommandName) {
          skippedEmptyTriggers += 1;
          logger.log(
            "warn",
            `Skipping slash command for trigger "${trigger}" because normalized name is empty.`,
          );
          continue;
        }

        if (true === seenCommandNames.has(slashCommandName)) {
          skippedDuplicateNames += 1;
          logger.log(
            "warn",
            `Skipping duplicate slash command "${slashCommandName}" (trigger "${trigger}").`,
          );
          continue;
        }

        seenCommandNames.add(slashCommandName);
        const slashCommand = new SlashCommandBuilder()
          .setName(slashCommandName)
          .setDescription(asset.title);
        slashCommands.push(slashCommand.toJSON());

        if (asset instanceof ImageAsset) {
          if ("dracoon" === asset.location) {
            imageDracoonAssetCommandsRegistered += 1;
            dracoonAssetCommandNames.add(slashCommandName);
          } else {
            imageNonDracoonAssetCommandsRegistered += 1;
          }
        } else if (asset instanceof TextAsset) {
          textAssetCommandsRegistered += 1;
        }
      }
    }
  }
  const assetCommandsRegistered = slashCommands.length;

  // Define non-asset related slash-commands
  const slashCommandCryptodice = new SlashCommandBuilder()
    .setName("cryptodice")
    .setDescription("Roll the dice...");
  slashCommands.push(slashCommandCryptodice.toJSON());

  const slashCommandLmgtfy = new SlashCommandBuilder()
    .setName("lmgtfy")
    .setDescription("Let me google that for you...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true));
  slashCommands.push(slashCommandLmgtfy.toJSON());

  const slashCommandGoogle = new SlashCommandBuilder()
    .setName("google")
    .setDescription("Search...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true));
  slashCommands.push(slashCommandGoogle.toJSON());

  const slashCommand8ball = new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Weiser als das Interwebs...")
    .addStringOption(option =>
      option.setName("frage")
        .setDescription("Stelle die Frage, sterblicher!")
        .setRequired(true));
  slashCommands.push(slashCommand8ball.toJSON());

  const slashWhatIs = new SlashCommandBuilder()
    .setName("whatis")
    .setDescription("What is...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true)
        .addChoices(...whatIsAssetsChoices));
  slashCommands.push(slashWhatIs.toJSON());

  const slashUserquotequote = new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Quote...")
    .addStringOption(option =>
      option.setName("who")
        .setDescription("Define user")
        .setRequired(false)
        .addChoices(...userAssetsChoices));
  slashCommands.push(slashUserquotequote.toJSON());

  const slashCommandIslandboi = new SlashCommandBuilder()
    .setName("islandboi")
    .setDescription("Island bwoi!");
  slashCommands.push(slashCommandIslandboi.toJSON());

  const slashSara = new SlashCommandBuilder()
    .setName("sara")
    .setDescription("Sara...")
    .addStringOption(option =>
      option.setName("what")
        .setDescription("Was soll Sara tun?")
        .setRequired(false),
    );
  slashCommands.push(slashSara.toJSON());

  const slashCommandEarnings = new SlashCommandBuilder()
    .setName("earnings")
    .setDescription("Earnings")
    .addStringOption(option =>
      option.setName("when")
        .setDescription("Alle, nur vor open, während der Handlszeiten oder nach close?")
        .setRequired(false)
        .addChoices(
          {name: "Alle", value: "all"},
          {name: "Vor open", value: "before_open"},
          {name: "Zu Handelszeiten", value: "during_session"},
          {name: "Nach close", value: "after_close"},
        ))
    .addStringOption(option =>
      option.setName("filter")
        .setDescription("Alle oder nur Bluechips (MCap >= $10B)?")
        .setRequired(false)
        .addChoices(
          {name: "Alle", value: "all"},
          {name: "Bluechips (>= $10B)", value: "bluechips"},
        ))
    .addNumberOption(option =>
      option.setName("days")
        .setDescription("Zeitraum in Tagen (ab morgen)")
        .setMinValue(0)
        .setMaxValue(10)
        .setRequired(false))
    .addStringOption(option =>
      option.setName("date")
        .setDescription("Datum (YYYY-MM-DD)")
        .setRequired(false));
  slashCommands.push(slashCommandEarnings.toJSON());

  const slashCommandCalendar = new SlashCommandBuilder()
    .setName("calendar")
    .setDescription("Wichtige Ereignisse")
    .addStringOption(option =>
      option.setName("range")
        .setDescription("Zeitspanne in Tagen")
        .setRequired(false));
  slashCommands.push(slashCommandCalendar.toJSON());
  const fixedCommandsRegistered = slashCommands.length - assetCommandsRegistered;

  if (0 < skippedEmptyTriggers || 0 < skippedDuplicateNames) {
    logger.log(
      "warn",
      {
        source: "slash-registration",
        asset_triggers_total: assetTriggersTotal,
        asset_commands_registered: assetCommandsRegistered,
        fixed_commands_registered: fixedCommandsRegistered,
        total_commands_registered: slashCommands.length,
        skipped_empty_triggers: skippedEmptyTriggers,
        skipped_duplicate_names: skippedDuplicateNames,
        message: "Slash command payload built with skipped asset triggers.",
      },
    );
  }

  return {
    slashCommands,
    dracoonAssetCommandNames: [...dracoonAssetCommandNames],
    expectedCommandNames: getSlashCommandNamesFromPayload(slashCommands),
    assetTriggersTotal,
    assetCommandsRegistered,
    fixedCommandsRegistered,
    skippedEmptyTriggers,
    skippedDuplicateNames,
    imageDracoonAssetCommandsRegistered,
    imageNonDracoonAssetCommandsRegistered,
    textAssetCommandsRegistered,
  };
}

export async function defineSlashCommands(assets, whatIsAssets, userAssets) {
  const token = readSecret("discord_token").trim();
  const clientId = readSecret("discord_client_ID").trim();
  const guildId = readSecret("discord_guild_ID").trim();
  const payload = buildSlashCommandPayload(assets, whatIsAssets, userAssets);
  const expectedPayloadHash = getSlashCommandPayloadHash(payload.slashCommands);
  const rest = new REST({
    version: "10",
    timeout: slashCommandRestTimeoutMs,
  }).setToken(token);

  const slashRegistrationStartedAt = Date.now();
  const slashRegistrationLogBase = {
    source: "slash-registration",
    guild_id: guildId,
    client_id: clientId,
  };
  rest.on("rateLimited", (rateLimitData: RestRateLimitData) => {
    logger.log(
      "warn",
      {
        ...slashRegistrationLogBase,
        registration_rejected: false,
        rate_limited: true,
        rate_limit_global: Boolean(rateLimitData.global),
        retry_after_ms: toDiscordTimerMs(rateLimitData.retryAfter),
        rate_limit_scope: rateLimitData.scope,
        rate_limit_method: rateLimitData.method,
        rate_limit_route: rateLimitData.route,
        rate_limit_hash: rateLimitData.hash,
        rate_limit_limit: rateLimitData.limit,
        rate_limit_major_parameter: rateLimitData.majorParameter,
        time_to_reset_ms: toDiscordTimerMs(rateLimitData.timeToReset),
        sublimit_timeout_ms: toDiscordTimerMs(rateLimitData.sublimitTimeout),
        message: "slash-registration:rate-limit-event",
      },
    );
  });

  try {
    logger.log(
      "warn",
      {
        ...slashRegistrationLogBase,
        expected_command_count: payload.expectedCommandNames.length,
        dracoon_asset_command_count: payload.imageDracoonAssetCommandsRegistered,
        asset_image_dracoon: payload.imageDracoonAssetCommandsRegistered,
        asset_image_non_dracoon: payload.imageNonDracoonAssetCommandsRegistered,
        asset_text: payload.textAssetCommandsRegistered,
        asset_triggers_total: payload.assetTriggersTotal,
        asset_commands_registered: payload.assetCommandsRegistered,
        fixed_commands_registered: payload.fixedCommandsRegistered,
        request_timeout_ms: slashCommandRestTimeoutMs,
        message: "slash-registration:start",
      },
    );
    const currentRegistrationResponse = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
    if (false === Array.isArray(currentRegistrationResponse)) {
      logger.log(
        "warn",
        {
          ...slashRegistrationLogBase,
          expected_command_count: payload.expectedCommandNames.length,
          response_type: typeof currentRegistrationResponse,
          message: "Slash command registration returned unexpected response shape.",
        },
      );
      throw new SlashRegistrationMismatchError("Slash command registration returned unexpected response shape.");
    }

    if (expectedPayloadHash === getSlashCommandPayloadHash(currentRegistrationResponse)) {
      const slashRegistrationDurationMs = Date.now() - slashRegistrationStartedAt;
      logger.log(
        "info",
        {
          ...slashRegistrationLogBase,
          duration_ms: slashRegistrationDurationMs,
          expected_command_count: payload.expectedCommandNames.length,
          returned_command_count: getSlashCommandNamesFromPayload(currentRegistrationResponse).length,
          message: "slash-registration:noop",
        },
      );
      return;
    }

    const currentDiff = computeSlashRegistrationDiff(payload.slashCommands, currentRegistrationResponse);
    const missingDracoonCommandNames = currentDiff.missingCommandNames.filter(commandName => {
      return true === payload.dracoonAssetCommandNames.includes(commandName);
    });
    logger.log(
      "warn",
      {
        ...slashRegistrationLogBase,
        expected_command_count: currentDiff.expectedCommandNames.length,
        returned_command_count: currentDiff.returnedCommandNames.length,
        missing_command_count: currentDiff.missingCommandNames.length,
        unexpected_command_count: currentDiff.unexpectedCommandNames.length,
        changed_command_count: currentDiff.changedCommandNames.length,
        missing_commands: currentDiff.missingCommandNames.slice(0, slashCommandNameLogLimit),
        unexpected_commands: currentDiff.unexpectedCommandNames.slice(0, slashCommandNameLogLimit),
        changed_commands: currentDiff.changedCommandNames.slice(0, slashCommandNameLogLimit),
        truncated: currentDiff.truncated,
        missing_dracoon_command_count: missingDracoonCommandNames.length,
        missing_dracoon_commands: missingDracoonCommandNames.slice(0, slashCommandNameLogLimit),
        message: "slash-registration:diff-detected",
      },
    );

    logger.log(
      "warn",
      {
        ...slashRegistrationLogBase,
        expected_command_count: payload.expectedCommandNames.length,
        message: "slash-registration:put-sent",
      },
    );
    const putRegistrationResponse = await rest.put(
      Routes.applicationGuildCommands(clientId, guildId),
      {
        body: payload.slashCommands,
      },
    );

    let persistedRegistrationResponse = putRegistrationResponse;
    if (false === Array.isArray(persistedRegistrationResponse)) {
      logger.log(
        "warn",
        {
          ...slashRegistrationLogBase,
          response_type: typeof persistedRegistrationResponse,
          message: "slash-registration:verification-fallback-get",
        },
      );
      persistedRegistrationResponse = await rest.get(Routes.applicationGuildCommands(clientId, guildId));
    }

    if (false === Array.isArray(persistedRegistrationResponse)) {
      logger.log(
        "warn",
        {
          ...slashRegistrationLogBase,
          expected_command_count: payload.expectedCommandNames.length,
          response_type: typeof persistedRegistrationResponse,
          message: "Slash command registration returned unexpected response shape.",
        },
      );
      throw new SlashRegistrationMismatchError("Slash command registration returned unexpected response shape.");
    }

    if (expectedPayloadHash !== getSlashCommandPayloadHash(persistedRegistrationResponse)) {
      const persistedDiff = computeSlashRegistrationDiff(payload.slashCommands, persistedRegistrationResponse);
      if (hasSlashRegistrationMismatch(persistedDiff)) {
        const persistedMissingDracoonCommandNames = persistedDiff.missingCommandNames.filter(commandName => {
          return true === payload.dracoonAssetCommandNames.includes(commandName);
        });
        logger.log(
          "warn",
          {
            ...slashRegistrationLogBase,
            expected_command_count: persistedDiff.expectedCommandNames.length,
            returned_command_count: persistedDiff.returnedCommandNames.length,
            missing_command_count: persistedDiff.missingCommandNames.length,
            unexpected_command_count: persistedDiff.unexpectedCommandNames.length,
            changed_command_count: persistedDiff.changedCommandNames.length,
            missing_commands: persistedDiff.missingCommandNames.slice(0, slashCommandNameLogLimit),
            unexpected_commands: persistedDiff.unexpectedCommandNames.slice(0, slashCommandNameLogLimit),
            changed_commands: persistedDiff.changedCommandNames.slice(0, slashCommandNameLogLimit),
            truncated: persistedDiff.truncated,
            missing_dracoon_command_count: persistedMissingDracoonCommandNames.length,
            missing_dracoon_commands: persistedMissingDracoonCommandNames.slice(0, slashCommandNameLogLimit),
            message: "Slash command registration response does not match requested payload.",
          },
        );
        throw new SlashRegistrationMismatchError("Slash command registration response does not match requested payload.");
      }
    }

    const slashRegistrationDurationMs = Date.now() - slashRegistrationStartedAt;
    logger.log(
      "info",
      {
        ...slashRegistrationLogBase,
        duration_ms: slashRegistrationDurationMs,
        expected_command_count: payload.expectedCommandNames.length,
        returned_command_count: getSlashCommandNamesFromPayload(persistedRegistrationResponse).length,
        message: "slash-registration:completed",
      },
    );
  } catch (error: unknown) {
    if (error instanceof SlashRegistrationMismatchError) {
      throw error;
    }

    const createLimitError = toSlashRegistrationCreateLimitError(error);
    if (createLimitError) {
      logger.log(
        "warn",
        {
          ...slashRegistrationLogBase,
          total_commands_registered: payload.slashCommands.length,
          registration_rejected: true,
          daily_create_limit_reached: true,
          retry_after_ms: createLimitError.retryAfterMs,
          ...toSlashRegistrationErrorDetails(error),
          message: "slash-registration:daily-create-limit-reached",
        },
      );
      throw createLimitError;
    }

    const rateLimitError = toSlashRegistrationRateLimitError(error);
    if (rateLimitError) {
      logger.log(
        "warn",
        {
          ...slashRegistrationLogBase,
          total_commands_registered: payload.slashCommands.length,
          registration_rejected: true,
          rate_limited: true,
          rate_limit_global: rateLimitError.isGlobal,
          retry_after_ms: rateLimitError.retryAfterMs,
          ...toSlashRegistrationErrorDetails(error),
          message: "slash-registration:rate-limited",
        },
      );
      throw rateLimitError;
    }

    logger.log(
      "warn",
      {
        ...slashRegistrationLogBase,
        total_commands_registered: payload.slashCommands.length,
        registration_rejected: true,
        ...toSlashRegistrationErrorDetails(error),
        message: "Slash command registration was rejected by Discord.",
      },
    );
    logger.log(
      "error",
      error,
    );
    throw error;
  }
}

export function interactSlashCommands(client, assets, assetCommands, whatIsAssets, tickers: Ticker[]) {
  const guildId = readSecret("discord_guild_ID").trim();
  // Respond to slash-commands
  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const commandName: string = validator.escape(interaction.commandName);
    for (const asset of assets) {
      if (false === Array.isArray(asset.trigger)) {
        continue;
      }

      for (const trigger of asset.trigger) {
        if ("whatis" !== commandName && commandName === toSlashCommandName(trigger)) {
          if (asset instanceof ImageAsset) {
            if (!asset?.fileContent || !asset.fileName) {
              logger.log(
                "warn",
                `Asset ${asset.name ?? asset.fileName ?? trigger} is temporarily unavailable.`,
              );
              await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
                logger.log(
                  "error",
                  `Error replying to slashcommand: ${error}`,
                );
              });
              continue;
            }

            const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
            if (asset instanceof ImageAsset && asset.hasText) {
              // For images with text description, currently not used.
              const embed = new EmbedBuilder();
              embed.setImage(`attachment://${asset.fileName}`);
              embed.addFields(
                {name: asset.title, value: asset.text},
              );
              await interaction.reply({embeds: [embed], files: [file]});
            } else {
              await interaction.reply({files: [file]});
            }
          } else if (asset instanceof TextAsset) {
            await interaction.reply(asset.response).catch(error => {
              logger.log(
                "error",
                `Error replying to slashcommand: ${error}`,
              );
            });
          }
        }
      }
    }

    if ("cryptodice" === commandName) {
      await interaction.reply(`Rolling the crypto dice... ${cryptodice()}.`).catch(error => {
        logger.log(
          "error",
          `Error replying to cryptodice slashcommand: ${error}`,
        );
      });
    }

    if ("8ball" === commandName) {
      const options: string[] = [
        ":8ball: Ziemlich sicher.",
        ":8ball: Es ist entschieden.",
        ":8ball: Ohne Zweifel.",
        ":8ball: Ja, absolut.",
        ":8ball: Du kannst darauf zählen.",
        ":8ball: Sehr wahrscheinlich.",
        ":8ball: Sieht gut aus.",
        ":8ball: Ja.",
        ":8ball: Die Zeichen stehen auf Ja.",
        ":8ball: Antwort unklar.",
        ":8ball: Frag mich später noch mal.",
        ":8ball: Sag ich dir besser noch nicht.",
        ":8ball: Kann ich noch nicht sagen.",
        ":8ball: Konzentriere dich und frage erneut.",
        ":8ball: Zähl nicht darauf.",
        ":8ball: Meine Antwort ist nein.",
        ":8ball: Meine Quellen sagen nein.",
        ":8ball: Sieht nicht so gut aus.",
        ":8ball: Sehr unwahrscheinlich.",
      ];

      // This may show up as possible object insertion in Semgrep. However, it is safe since the content of `options` is predefined by the code and not supplied by a user.
      const randomElement = options[Math.floor(Math.random() * options.length)];
      const embed = new EmbedBuilder();
      embed.addFields(
        {name: interaction.options.getString("frage", true), value: randomElement},
      );
      await interaction.reply({embeds: [embed]}).catch(error => {
        logger.log(
          "error",
          `Error replying to 8ball slashcommand: ${error}`,
        );
      });
    }

    if (commandName.startsWith("lmgtfy")) {
      const search = validator.escape(interaction.options.getString("search", true));
      await interaction.reply(`Let me google that for you... ${lmgtfy(search)}.`).catch(error => {
        logger.log(
          "error",
          `Error replying to lmgtfy slashcommand: ${error}`,
        );
      });
    }

    if (commandName.startsWith("google")) {
      const search = validator.escape(interaction.options.getString("search", true));
      await interaction.reply(`Here you go: ${google(search)}.`).catch(error => {
        logger.log(
          "error",
          `Error replying to google slashcommand: ${error}`,
        );
      });
    }

    if ("whatis" === commandName) {
      const search = validator.escape(interaction.options.getString("search", true));

      for (const asset of whatIsAssets) {
        if (asset.name === search) {
          const embed = new EmbedBuilder();
          embed.addFields(
            {name: asset.title, value: asset.text},
          );

          if (true === Object.prototype.hasOwnProperty.call(asset, "_fileName")) {
            if (!asset?.fileContent || !asset.fileName) {
              logger.log(
                "warn",
                `Whatis asset ${asset.name} is temporarily unavailable.`,
              );
              await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
                logger.log(
                  "error",
                  `Error replying to whatis slashcommand: ${error}`,
                );
              });
              continue;
            }

            const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
            embed.setImage(`attachment://${asset.fileName}`);
            await interaction.reply({embeds: [embed], files: [file]});
          } else {
            await interaction.reply({embeds: [embed]});
          }
        }
      }
    }

    if ("quote" === commandName) {
      let who: string;

      const quoteUser = interaction.options.getString("who");
      if (null !== quoteUser) {
        who = validator.escape(quoteUser);
      } else {
        who = "any";
      }

      const randomQuote = getRandomQuote(who, assets);
      if (!randomQuote) {
        await interaction.reply(noQuoteMessage).catch(error => {
          logger.log(
            "error",
            `Error replying to quote slashcommand: ${error}`,
          );
        });
        return;
      }

      if (!randomQuote.fileContent || !randomQuote.fileName) {
        logger.log(
          "warn",
          `Quote asset for ${who} is temporarily unavailable.`,
        );
        await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
          logger.log(
            "error",
            `Error replying to quote slashcommand: ${error}`,
          );
        });
        return;
      }

      const file = new AttachmentBuilder(Buffer.from(randomQuote.fileContent), {name: randomQuote.fileName});
      await interaction.reply({files: [file]});
    }

    if ("islandboi" === commandName) {
      const now = Date.now();
      const currentCooldownUntil = islandboiCooldownByUser.get(interaction.user.id) ?? 0;
      if (currentCooldownUntil > now) {
        const remainingSeconds = Math.ceil((currentCooldownUntil - now) / 1000);
        await interaction.reply({
          content: `Please wait ${remainingSeconds} more seconds.`,
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const mutedRole = readSecret("hblwrk_role_muted_ID").trim();
      if ("" === mutedRole) {
        await interaction.reply({
          content: "Muted role is not configured.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(error => {
        logger.log(
          "error",
          `Error fetching guild for islandboi slashcommand: ${error}`,
        );
      });
      if (!guild) {
        await interaction.reply({
          content: "Guild is currently unavailable.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const botMember = guild.members.me ?? await guild.members.fetchMe().catch(error => {
        logger.log(
          "error",
          `Error fetching bot member for islandboi slashcommand: ${error}`,
        );
      });
      if (!botMember || false === botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await interaction.reply({
          content: "No permissions to manage roles.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const guildUser = await guild.members.fetch(interaction.user.id).catch(error => {
        logger.log(
          "error",
          `Error fetching user for islandboi slashcommand: ${error}`,
        );
      });
      if (!guildUser) {
        await interaction.reply({
          content: "Konnte Benutzer nicht laden.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const addRoleSuccess = await guildUser.roles.add(mutedRole).then(() => true).catch(error => {
        logger.log(
          "error",
          `Error muting user for islandboi slashcommand: ${error}`,
        );
        return false;
      });
      if (false === addRoleSuccess) {
        await interaction.reply({
          content: "Unable to assign muted role.",
          ephemeral: true,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to islandboi slashcommand: ${error}`,
          );
        });
        return;
      }

      const cooldownUntil = now + islandboiCooldownMs;
      islandboiCooldownByUser.set(interaction.user.id, cooldownUntil);
      const existingTimer = islandboiUnmuteTimers.get(interaction.user.id);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      await interaction.reply({
        content: "You are now muted for 60 seconds.",
        ephemeral: true,
      }).catch(error => {
        logger.log(
          "error",
          `Error replying to islandboi slashcommand: ${error}`,
        );
      });

      logger.log(
        "info",
        `Muted ${interaction.user.username} for 60 seconds.`,
      );

      const timer = setTimeout(() => {
        guildUser.roles.remove(mutedRole).catch(error => {
          logger.log(
            "error",
            `Error unmuting user for islandboi slashcommand: ${error}`,
          );
        }).finally(() => {
          islandboiUnmuteTimers.delete(interaction.user.id);
          islandboiCooldownByUser.delete(interaction.user.id);
        });
        logger.log(
          "info",
          `Unmuted ${interaction.user.username} after 60 seconds.`,
        );
      }, islandboiCooldownMs);
      (timer as any).unref?.();
      islandboiUnmuteTimers.set(interaction.user.id, timer);
    }

    if ("earnings" === commandName) {
      const discordLogger = getDiscordLogger(client);

      discordLogger.log(
        "info",
        {
          username: `${interaction.user.username}`,
          message: "Using earnings slashcommand",
          channel: `${interaction.channel}`,
        },
      );

      let earningsEvents = [];
      let earningsStatus: "ok" | "error";
      let when: string;
      let filter: string;
      let date: string;
      let days: number;

      const daysOption = interaction.options.getNumber("days");
      if (null !== daysOption) {
        days = daysOption;
      } else {
        days = 0;
      }

      const dateOption = interaction.options.getString("date");
      if (null !== dateOption) {
        date = validator.escape(dateOption);
      } else {
        date = "today";
      }

      const whenOption = interaction.options.getString("when");
      if (null !== whenOption) {
        when = validator.escape(whenOption);
      } else {
        when = "all";
      }

      const filterOption = interaction.options.getString("filter");
      if (null !== filterOption) {
        filter = validator.escape(filterOption);
      } else {
        filter = "bluechips";
      }

      const deferred = await interaction.deferReply().then(() => true).catch(error => {
        logger.log(
          "error",
          `Error deferring earnings slashcommand: ${error}`,
        );
        return false;
      });
      if (false === deferred) {
        return;
      }

      const earningsResult = await getEarningsResult(days, date);
      earningsEvents = earningsResult.events;
      earningsStatus = earningsResult.status;

      const earningsBatch = getEarningsMessages(earningsEvents, when, tickers, {
        maxMessageLength: EARNINGS_MAX_MESSAGE_LENGTH,
        maxMessages: EARNINGS_MAX_MESSAGES_SLASH,
        marketCapFilter: filter,
      });
      logger.log(
        "info",
        {
          source: "slash-earnings",
          filter,
          chunkCount: earningsBatch.messages.length,
          truncated: earningsBatch.truncated,
          includedEvents: earningsBatch.includedEvents,
          totalEvents: earningsBatch.totalEvents,
          status: earningsStatus,
        },
      );
      if (true === earningsBatch.truncated) {
        logger.log(
          "warn",
          {
            source: "slash-earnings",
            filter,
            chunkCount: earningsBatch.messages.length,
            includedEvents: earningsBatch.includedEvents,
            totalEvents: earningsBatch.totalEvents,
            message: "Earnings output truncated because message limits were reached.",
          },
        );
      }

      if (0 === earningsBatch.messages.length) {
        if ("error" === earningsStatus) {
          await interaction.editReply({
            content: "Earnings konnten gerade nicht geladen werden. Bitte später erneut versuchen.",
            allowedMentions: noMentions,
          }).catch(error => {
            logger.log(
              "error",
              `Error replying to earnings slashcommand: ${error}`,
            );
          });
          return;
        }

        await interaction.editReply({
          content: "Es stehen keine relevanten Quartalszahlen an.",
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to earnings slashcommand: ${error}`,
          );
        });
        return;
      }

      await interaction.editReply({
        content: earningsBatch.messages[0],
        allowedMentions: noMentions,
      }).catch(error => {
        logger.log(
          "error",
          `Error replying to earnings slashcommand: ${error}`,
        );
      });

      for (let chunkIndex = 1; chunkIndex < earningsBatch.messages.length; chunkIndex++) {
        await interaction.followUp({
          content: earningsBatch.messages[chunkIndex],
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error following up earnings slashcommand: ${error}`,
          );
        });
      }
    }

    if ("calendar" === commandName) {
      const discordLogger = getDiscordLogger(client);

      discordLogger.log(
        "info",
        {
          "username": `${interaction.user.username}`,
          "message": "Using calendar slashcommand",
          "channel": `${interaction.channel}`
        },
      );

      let calendarEvents = [];

      const rangeOption = interaction.options.getString("range");
      if (null !== rangeOption) {
        let range: number = Number.parseInt(validator.escape(rangeOption), 10);
        if (Number.isNaN(range)) {
          range = 0;
        }

        if (31 < range) {
          range = 31;
        }

        calendarEvents = await getCalendarEvents("", range - 1);
      } else {
        calendarEvents = await getCalendarEvents("", 0);
      }

      const calendarBatch = getCalendarMessages(calendarEvents, {
        maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
        maxMessages: CALENDAR_MAX_MESSAGES_SLASH,
        keepDayTogether: true,
      });
      logger.log(
        "info",
        {
          source: "slash-calendar",
          chunkCount: calendarBatch.messages.length,
          truncated: calendarBatch.truncated,
          includedEvents: calendarBatch.includedEvents,
          totalEvents: calendarBatch.totalEvents,
        },
      );
      if (true === calendarBatch.truncated) {
        logger.log(
          "warn",
          {
            source: "slash-calendar",
            chunkCount: calendarBatch.messages.length,
            includedEvents: calendarBatch.includedEvents,
            totalEvents: calendarBatch.totalEvents,
            message: "Calendar output truncated because message limits were reached.",
          },
        );
      }

      if (0 === calendarBatch.messages.length) {
        await interaction.reply({
          content: "Heute passiert nichts wichtiges 😴.",
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error replying to calendar slashcommand: ${error}`,
          );
        });
        return;
      }

      await interaction.reply({
        content: calendarBatch.messages[0],
        allowedMentions: noMentions,
      }).catch(error => {
        logger.log(
          "error",
          `Error replying to calendar slashcommand: ${error}`,
        );
      });

      for (let chunkIndex = 1; chunkIndex < calendarBatch.messages.length; chunkIndex++) {
        await interaction.followUp({
          content: calendarBatch.messages[chunkIndex],
          allowedMentions: noMentions,
        }).catch(error => {
          logger.log(
            "error",
            `Error following up calendar slashcommand: ${error}`,
          );
        });
      }
    }

    async function saraDoesNotWant() {
      await interaction.reply("Sara möchte das nicht.").catch(error => {
        logger.log(
          "error",
          `Error replying to sara slashcommand: ${error}`,
        );
      });
    }

    if ("sara" === commandName) {
      let what: string;
      const whatOption = interaction.options.getString("what");
      if (null !== whatOption) {
        what = validator.escape(whatOption);

        if ("yes" === what.toLowerCase()) {
          const asset = getAssetByName("sara-yes", assets);
          if (!asset?.fileContent || !asset.fileName) {
            await saraDoesNotWant();
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
          await interaction.reply({files: [file]});
        } else if ("shrug" === what.toLowerCase()) {
          const asset = getAssetByName("sara-shrug", assets);
          if (!asset?.fileContent || !asset.fileName) {
            await saraDoesNotWant();
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
          await interaction.reply({files: [file]});
        } else {
          await saraDoesNotWant();
        }
      } else {
        await saraDoesNotWant();
      }
    }
  });
}
