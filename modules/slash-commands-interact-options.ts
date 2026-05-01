import {type ChatInputCommandInteraction} from "discord.js";
import {getDiscordLogger, getLogger} from "./logging.ts";
import {
  formatOptionDeltaLookupResult,
  getOptionDeltaLookup,
  OptionDeltaConfigurationError,
  OptionDeltaDataError,
  OptionDeltaInputError,
  type OptionDeltaRequestedSide,
  type OptionDeltaCredentials,
} from "./options-delta.ts";
import {readSecret} from "./secrets.ts";
import {getDiscordLoggerClient, noMentions, type SlashCommandClient} from "./slash-commands-interact-shared.ts";

const logger = getLogger();

function getRequestedSide(sideOption: string | null): OptionDeltaRequestedSide {
  if ("call" === sideOption || "put" === sideOption) {
    return sideOption;
  }

  return "both";
}

function getTastytradeCredentials(): OptionDeltaCredentials {
  try {
    return {
      clientSecret: readSecret("tastytrade_client_secret"),
      refreshToken: readSecret("tastytrade_refresh_token"),
    };
  } catch (_error: unknown) {
    throw new OptionDeltaConfigurationError("Option data credentials are missing.");
  }
}

function getDeltaErrorMessage(error: unknown): string {
  if (error instanceof OptionDeltaConfigurationError) {
    return "Optionsdaten sind fuer /delta noch nicht konfiguriert.";
  }

  if (error instanceof OptionDeltaInputError) {
    return `Ungueltige Eingabe: ${error.message}`;
  }

  if (error instanceof OptionDeltaDataError) {
    return error.message;
  }

  return "Optionsdaten konnten gerade nicht geladen werden. Bitte spaeter erneut versuchen.";
}

export async function handleDeltaSlashCommand(
  client: SlashCommandClient,
  interaction: ChatInputCommandInteraction,
  commandName: string,
): Promise<boolean> {
  if ("delta" !== commandName) {
    return false;
  }

  const discordLogger = getDiscordLogger(getDiscordLoggerClient(client));
  discordLogger.log(
    "info",
    {
      username: `${interaction.user.username}`,
      message: "Using delta slashcommand",
      channel: `${interaction.channel}`,
    },
  );

  const deferred = await interaction.deferReply().then(() => true).catch((error: unknown) => {
    logger.log(
      "error",
      `Error deferring delta slashcommand: ${error}`,
    );
    return false;
  });
  if (false === deferred) {
    return true;
  }

  try {
    const symbol = interaction.options.getString("symbol", true);
    const dte = interaction.options.getInteger("dte", true);
    const delta = interaction.options.getNumber("delta", true);
    const side = getRequestedSide(interaction.options.getString("side"));
    const result = await getOptionDeltaLookup({
      credentials: getTastytradeCredentials(),
      delta,
      dte,
      side,
      symbol,
    });

    await interaction.editReply({
      content: formatOptionDeltaLookupResult(result),
      allowedMentions: noMentions,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to delta slashcommand: ${error}`,
      );
    });
  } catch (error: unknown) {
    logger.log(
      "warn",
      `Error loading delta slashcommand: ${error}`,
    );
    await interaction.editReply({
      content: getDeltaErrorMessage(error),
      allowedMentions: noMentions,
    }).catch((replyError: unknown) => {
      logger.log(
        "error",
        `Error replying to delta slashcommand failure: ${replyError}`,
      );
    });
  }

  return true;
}
