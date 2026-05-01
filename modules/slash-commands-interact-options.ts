import {type ChatInputCommandInteraction} from "discord.js";
import {BrokerApiRateLimitError} from "./broker-api-rate-limit.ts";
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
import {
  formatBoxRatesLookupResult,
  getBoxRatesLookup,
} from "./options-boxrates.ts";
import {
  formatBoxSpreadLookupResult,
  getBoxSpreadLookup,
  type BoxSpreadDirection,
} from "./options-boxspread.ts";
import {
  formatExpectedMoveLookupResult,
  formatOptionStraddleLookupResult,
  formatOptionStrangleLookupResult,
  getOptionStraddleLookup,
  getOptionStrangleLookup,
} from "./options-strategy.ts";
import {readSecret} from "./secrets.ts";
import {getDiscordLoggerClient, noMentions, type SlashCommandClient} from "./slash-commands-interact-shared.ts";

const logger = getLogger();
const optionCommandNames = new Set(["delta", "strangle", "straddle", "expectedmove", "boxspread", "boxrates"]);

function getRequestedSide(sideOption: string | null): OptionDeltaRequestedSide {
  if ("call" === sideOption || "put" === sideOption) {
    return sideOption;
  }

  return "both";
}

function getBoxSpreadDirection(directionOption: string): BoxSpreadDirection {
  if ("borrow" === directionOption || "lend" === directionOption) {
    return directionOption;
  }

  throw new OptionDeltaInputError("Direction must be borrow or lend.");
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

function getDeltaErrorMessage(error: unknown, commandName: string): string {
  if (error instanceof BrokerApiRateLimitError) {
    return "Optionsdaten sind gerade ausgelastet. Bitte gleich erneut versuchen.";
  }

  if (error instanceof OptionDeltaConfigurationError) {
    return `Optionsdaten sind für /${commandName} noch nicht konfiguriert.`;
  }

  if (error instanceof OptionDeltaInputError) {
    return `Ungültige Eingabe: ${error.message}`;
  }

  if (error instanceof OptionDeltaDataError) {
    return error.message;
  }

  return "Optionsdaten konnten gerade nicht geladen werden. Bitte später erneut versuchen.";
}

async function getOptionsCommandResponse(interaction: ChatInputCommandInteraction, commandName: string): Promise<string> {
  const credentials = getTastytradeCredentials();
  if ("boxrates" === commandName) {
    const notational = interaction.options.getNumber("notational");
    const result = await getBoxRatesLookup({
      credentials,
      ...(null === notational ? {} : {notational}),
    });
    return formatBoxRatesLookupResult(result);
  }

  const dte = interaction.options.getInteger("dte", true);
  if ("boxspread" === commandName) {
    const result = await getBoxSpreadLookup({
      credentials,
      direction: getBoxSpreadDirection(interaction.options.getString("direction", true)),
      dte,
      notational: interaction.options.getNumber("notational", true),
    });
    return formatBoxSpreadLookupResult(result);
  }

  const symbol = interaction.options.getString("symbol", true);
  if ("strangle" === commandName) {
    const delta = interaction.options.getNumber("delta");
    const result = await getOptionStrangleLookup({
      credentials,
      dte,
      symbol,
      ...(null === delta ? {} : {delta}),
    });
    return formatOptionStrangleLookupResult(result);
  }

  if ("straddle" === commandName) {
    const result = await getOptionStraddleLookup({
      credentials,
      dte,
      symbol,
    });
    return formatOptionStraddleLookupResult(result);
  }

  if ("expectedmove" === commandName) {
    const result = await getOptionStraddleLookup({
      credentials,
      dte,
      symbol,
    });
    return formatExpectedMoveLookupResult(result);
  }

  const delta = interaction.options.getNumber("delta", true);
  const side = getRequestedSide(interaction.options.getString("side"));
  const result = await getOptionDeltaLookup({
    credentials,
    delta,
    dte,
    side,
    symbol,
  });
  return formatOptionDeltaLookupResult(result);
}

export async function handleDeltaSlashCommand(
  client: SlashCommandClient,
  interaction: ChatInputCommandInteraction,
  commandName: string,
): Promise<boolean> {
  if (false === optionCommandNames.has(commandName)) {
    return false;
  }

  const discordLogger = getDiscordLogger(getDiscordLoggerClient(client));
  discordLogger.log(
    "info",
    {
      username: `${interaction.user.username}`,
      message: `Using ${commandName} slashcommand`,
      channel: `${interaction.channel}`,
    },
  );

  const deferred = await interaction.deferReply().then(() => true).catch((error: unknown) => {
    logger.log(
      "error",
      `Error deferring ${commandName} slashcommand: ${error}`,
    );
    return false;
  });
  if (false === deferred) {
    return true;
  }

  try {
    await interaction.editReply({
      content: await getOptionsCommandResponse(interaction, commandName),
      allowedMentions: noMentions,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to ${commandName} slashcommand: ${error}`,
      );
    });
  } catch (error: unknown) {
    logger.log(
      "warn",
      `Error loading ${commandName} slashcommand: ${error}`,
    );
    await interaction.editReply({
      content: getDeltaErrorMessage(error, commandName),
      allowedMentions: noMentions,
    }).catch((replyError: unknown) => {
      logger.log(
        "error",
        `Error replying to ${commandName} slashcommand failure: ${replyError}`,
      );
    });
  }

  return true;
}
