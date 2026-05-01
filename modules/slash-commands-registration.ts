import {REST, Routes} from "discord.js";
import {type GenericAsset, type ImageAsset, type UserAsset} from "./assets.ts";
import {getDiscordRateLimitRetryAfterMs, toDiscordTimerMs} from "./discord-retry-after.ts";
import {getLogger} from "./logging.ts";
import {readSecret} from "./secrets.ts";
import {buildSlashCommandPayload} from "./slash-commands-payload.ts";
import {
  computeSlashRegistrationDiff,
  getSlashCommandNamesFromPayload,
  getSlashCommandPayloadHash,
  hasSlashRegistrationMismatch,
} from "./slash-commands-canonical.ts";

const logger = getLogger();
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
  public readonly discordErrorMessage: string | undefined;

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
  public readonly discordErrorMessage: string | undefined;

  constructor(message: string, retryAfterMs: number, isGlobal: boolean, discordErrorMessage?: string) {
    super(message);
    this.name = "SlashRegistrationRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.isGlobal = isGlobal;
    this.discordErrorMessage = discordErrorMessage;
  }
}

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

function toSlashRegistrationErrorDetails(error: unknown) {
  if (error instanceof Error) {
    const unknownError = error as Error & {
      code?: string | number;
      discordErrorMessage?: string;
      global?: boolean;
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
      rate_limit_global: "boolean" === typeof unknownError.global
        ? unknownError.global
        : "boolean" === typeof unknownError.rawError?.global
        ? unknownError.rawError.global
        : undefined,
    };
  }

  return {
    error_message: String(error),
  };
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
    global?: boolean;
    status?: number;
    rawError?: {retry_after?: unknown; message?: string; global?: boolean;};
  };
  const errorStatus = Number(unknownError.status);
  const errorMessage = unknownError.message ?? "";
  const rawErrorMessage = unknownError.rawError?.message ?? "";
  const isRateLimitError = 429 === errorStatus
    || unknownError.name.startsWith("RateLimitError")
    || /you are being rate limited/i.test(errorMessage)
    || /you are being rate limited/i.test(rawErrorMessage);
  if (false === isRateLimitError) {
    return undefined;
  }

  const retryAfterMs = getDiscordRateLimitRetryAfterMs(error) ?? 15_000;
  const isGlobal = true === unknownError.global || true === unknownError.rawError?.global;
  return new SlashRegistrationRateLimitError(
    "Slash command registration rate limited. Waiting before retry.",
    retryAfterMs,
    isGlobal,
    getDiscordErrorMessage(error),
  );
}

export async function defineSlashCommands(assets: GenericAsset[], whatIsAssets: ImageAsset[], userAssets: UserAsset[]) {
  const token = readSecret("discord_token").trim();
  const clientId = readSecret("discord_client_ID").trim();
  const guildId = readSecret("discord_guild_ID").trim();
  const payload = buildSlashCommandPayload(assets, whatIsAssets, userAssets);
  const expectedPayloadHash = getSlashCommandPayloadHash(payload.slashCommands);
  const rest = new REST({
    version: "10",
    timeout: slashCommandRestTimeoutMs,
    // Reject rate limits so slash registration can log and reschedule explicitly.
    rejectOnRateLimit: () => true,
  }).setToken(token);

  const slashRegistrationStartedAt = Date.now();
  const slashRegistrationLogBase = {
    source: "slash-registration",
    guild_id: guildId,
    client_id: clientId,
  };
  rest.on("rateLimited", (rateLimitData: RestRateLimitData) => {
    const retryAfterMs = toDiscordTimerMs(rateLimitData.retryAfter);
    const rateLimitLog = {
      ...slashRegistrationLogBase,
      registration_rejected: false,
      rate_limited: true,
      rate_limit_global: Boolean(rateLimitData.global),
      retry_after_ms: retryAfterMs,
      retry_in_ms: retryAfterMs,
      rate_limit_scope: rateLimitData.scope,
      rate_limit_method: rateLimitData.method,
      rate_limit_route: rateLimitData.route,
      rate_limit_hash: rateLimitData.hash,
      rate_limit_limit: rateLimitData.limit,
      rate_limit_major_parameter: rateLimitData.majorParameter,
      time_to_reset_ms: toDiscordTimerMs(rateLimitData.timeToReset),
      sublimit_timeout_ms: toDiscordTimerMs(rateLimitData.sublimitTimeout),
      message: "slash-registration:rate-limit-event",
    };
    logger.log(
      "warn",
      rateLimitLog,
    );
    logger.log(
      "info",
      rateLimitLog,
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
