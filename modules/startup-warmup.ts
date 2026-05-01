/* eslint-disable import/extensions */
import {Client} from "discord.js";
import {getDiscordRateLimitRetryAfterMs} from "./discord-retry-after.ts";
import {type createStartupState} from "./startup-state.ts";
import {
  type ErrorLogDetails,
  type SharedStartupData,
  type StartupDependencies,
} from "./startup-types.ts";

const slashCommandCreateLimitCooldownMs = 24 * 60 * 60_000;

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

export async function warmRemoteData({
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
