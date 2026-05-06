import {SlashCommandBuilder} from "discord.js";
import {ImageAsset, TextAsset, type UserAsset} from "./assets.ts";
import {getLogger} from "./logging.ts";
import {
  buildGroupedAssetSlashCommand,
  getGroupedAssetCommands,
  type GroupedAssetCommand,
  toSlashCommandName,
} from "./slash-commands-assets.ts";
import {getSlashCommandNamesFromPayload} from "./slash-commands-canonical.ts";

const logger = getLogger();
const maxSlashCommandsPerScope = 100;
export const fixedSlashCommandNames = ["cryptodice", "lmgtfy", "8ball", "whatis", "quote", "sara", "earnings", "calendar", "paywall", "delta", "strangle", "straddle", "expectedmove", "boxspread", "boxrates"];
type SlashCommandJson = ReturnType<SlashCommandBuilder["toJSON"]>;
type SlashCommandChoice = {
  name: string;
  value: string;
};

export type SlashCommandPayloadBuildResult = {
  slashCommands: SlashCommandJson[];
  dracoonAssetCommandNames: string[];
  expectedCommandNames: string[];
  assetTriggersTotal: number;
  assetCommandsRegistered: number;
  fixedCommandsRegistered: number;
  skippedCommandLimit: number;
  skippedEmptyTriggers: number;
  skippedDuplicateNames: number;
  imageDracoonAssetCommandsRegistered: number;
  imageNonDracoonAssetCommandsRegistered: number;
  textAssetCommandsRegistered: number;
};

function createFixedSlashCommands(whatIsAssetsChoices: SlashCommandChoice[], userAssetsChoices: SlashCommandChoice[]) {
  const fixedSlashCommands: SlashCommandJson[] = [];

  const slashCommandCryptodice = new SlashCommandBuilder()
    .setName("cryptodice")
    .setDescription("Roll the dice...");
  fixedSlashCommands.push(slashCommandCryptodice.toJSON());

  const slashCommandLmgtfy = new SlashCommandBuilder()
    .setName("lmgtfy")
    .setDescription("Let me google that for you...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true));
  fixedSlashCommands.push(slashCommandLmgtfy.toJSON());

  const slashCommand8ball = new SlashCommandBuilder()
    .setName("8ball")
    .setDescription("Weiser als das Interwebs...")
    .addStringOption(option =>
      option.setName("frage")
        .setDescription("Stelle die Frage, sterblicher!")
        .setRequired(true));
  fixedSlashCommands.push(slashCommand8ball.toJSON());

  const slashWhatIs = new SlashCommandBuilder()
    .setName("whatis")
    .setDescription("What is...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true)
        .addChoices(...whatIsAssetsChoices));
  fixedSlashCommands.push(slashWhatIs.toJSON());

  const slashUserquotequote = new SlashCommandBuilder()
    .setName("quote")
    .setDescription("Quote...")
    .addStringOption(option =>
      option.setName("who")
        .setDescription("Define user")
        .setRequired(false)
        .addChoices(...userAssetsChoices));
  fixedSlashCommands.push(slashUserquotequote.toJSON());

  const slashSara = new SlashCommandBuilder()
    .setName("sara")
    .setDescription("Sara...")
    .addStringOption(option =>
      option.setName("what")
        .setDescription("Was soll Sara tun?")
        .setRequired(false),
    );
  fixedSlashCommands.push(slashSara.toJSON());

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
        .setDescription("Alle oder nur Bluechips (MCap >= $50B)?")
        .setRequired(false)
        .addChoices(
          {name: "Alle", value: "all"},
          {name: "Bluechips (>= $50B)", value: "bluechips"},
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
  fixedSlashCommands.push(slashCommandEarnings.toJSON());

  const slashCommandCalendar = new SlashCommandBuilder()
    .setName("calendar")
    .setDescription("Wichtige Ereignisse")
    .addStringOption(option =>
      option.setName("range")
        .setDescription("Zeitspanne in Tagen")
        .setRequired(false));
  fixedSlashCommands.push(slashCommandCalendar.toJSON());

  const slashCommandPaywall = new SlashCommandBuilder()
    .setName("paywall")
    .setDescription("Paywall bypass")
    .addStringOption(option =>
      option.setName("url")
        .setDescription("Article URL")
        .setRequired(true));
  fixedSlashCommands.push(slashCommandPaywall.toJSON());

  const slashCommandDelta = new SlashCommandBuilder()
    .setName("delta")
    .setDescription("Find option strikes around a target delta")
    .addStringOption(option =>
      option.setName("symbol")
        .setDescription("Underlying symbol")
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName("dte")
        .setDescription("Target days to expiration")
        .setMinValue(0)
        .setMaxValue(3650)
        .setRequired(true))
    .addNumberOption(option =>
      option.setName("delta")
        .setDescription("Absolute target delta, for example 0.30")
        .setMinValue(0.01)
        .setMaxValue(0.99)
        .setRequired(true))
    .addStringOption(option =>
      option.setName("side")
        .setDescription("Calls, puts, or both when omitted")
        .setRequired(false)
        .addChoices(
          {name: "Calls", value: "call"},
          {name: "Puts", value: "put"},
        ));
  fixedSlashCommands.push(slashCommandDelta.toJSON());

  const slashCommandStrangle = new SlashCommandBuilder()
    .setName("strangle")
    .setDescription("Find option legs for a short strangle")
    .addStringOption(option =>
      option.setName("symbol")
        .setDescription("Underlying symbol")
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName("dte")
        .setDescription("Target days to expiration")
        .setMinValue(0)
        .setMaxValue(3650)
        .setRequired(true))
    .addNumberOption(option =>
      option.setName("delta")
        .setDescription("Absolute target delta")
        .setMinValue(0.01)
        .setMaxValue(0.99)
        .setRequired(false)
        .addChoices(
          {name: "0.16 delta", value: 0.16},
          {name: "0.30 delta", value: 0.3},
        ));
  fixedSlashCommands.push(slashCommandStrangle.toJSON());

  const slashCommandStraddle = new SlashCommandBuilder()
    .setName("straddle")
    .setDescription("Find the ATM option straddle")
    .addStringOption(option =>
      option.setName("symbol")
        .setDescription("Underlying symbol")
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName("dte")
        .setDescription("Target days to expiration")
        .setMinValue(0)
        .setMaxValue(3650)
        .setRequired(true));
  fixedSlashCommands.push(slashCommandStraddle.toJSON());

  const slashCommandExpectedMove = new SlashCommandBuilder()
    .setName("expectedmove")
    .setDescription("Estimate the option-implied move from the ATM straddle")
    .addStringOption(option =>
      option.setName("symbol")
        .setDescription("Underlying symbol")
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName("dte")
        .setDescription("Target days to expiration")
        .setMinValue(0)
        .setMaxValue(3650)
        .setRequired(true));
  fixedSlashCommands.push(slashCommandExpectedMove.toJSON());

  const slashCommandBoxSpread = new SlashCommandBuilder()
    .setName("boxspread")
    .setDescription("Price an SPX box spread")
    .addIntegerOption(option =>
      option.setName("dte")
        .setDescription("Target days to expiration")
        .setMinValue(0)
        .setMaxValue(3650)
        .setRequired(true))
    .addStringOption(option =>
      option.setName("direction")
        .setDescription("Borrow cash with a short box, or lend cash with a long box")
        .setRequired(true)
        .addChoices(
          {name: "Borrow cash (short box)", value: "borrow"},
          {name: "Lend cash (long box)", value: "lend"},
        ))
    .addNumberOption(option =>
      option.setName("notational")
        .setDescription("Maturity notational, e.g. 100000 for one 1000-wide SPX box")
        .setMinValue(1)
        .setRequired(true));
  fixedSlashCommands.push(slashCommandBoxSpread.toJSON());

  const slashCommandBoxRates = new SlashCommandBuilder()
    .setName("boxrates")
    .setDescription("Show SPX box-spread implied rates for the next 12 months")
    .addNumberOption(option =>
      option.setName("notational")
        .setDescription("Maturity notational per row; defaults to 100000")
        .setMinValue(1)
        .setRequired(false));
  fixedSlashCommands.push(slashCommandBoxRates.toJSON());

  return fixedSlashCommands;
}

export function buildSlashCommandPayload(assets: unknown[], whatIsAssets: ImageAsset[], userAssets: UserAsset[]): SlashCommandPayloadBuildResult {
  const whatIsAssetsChoices: SlashCommandChoice[] = [];
  for (const asset of whatIsAssets) {
    whatIsAssetsChoices.push({name: asset.title, value: asset.name});
  }

  const userAssetsChoices: SlashCommandChoice[] = [];
  for (const asset of userAssets) {
    userAssetsChoices.push({name: asset.name, value: asset.name});
  }

  const fixedSlashCommands = createFixedSlashCommands(whatIsAssetsChoices, userAssetsChoices);
  const fixedCommandsRegistered = fixedSlashCommands.length;
  if (fixedCommandsRegistered > maxSlashCommandsPerScope) {
    throw new Error(
      `Fixed slash command count ${fixedCommandsRegistered} exceeds Discord's ${maxSlashCommandsPerScope} command limit.`,
    );
  }
  const maxAssetCommands = maxSlashCommandsPerScope - fixedCommandsRegistered;
  const groupedAssetCommands = getGroupedAssetCommands(assets, fixedSlashCommandNames);
  const groupedAssetCommandByTrigger = new Map<string, GroupedAssetCommand>();
  for (const groupedAssetCommand of groupedAssetCommands) {
    for (const groupedAssetVariant of groupedAssetCommand.variants) {
      groupedAssetCommandByTrigger.set(groupedAssetVariant.trigger, groupedAssetCommand);
    }
  }

  const slashCommands: SlashCommandJson[] = [];
  const seenCommandNames = new Set<string>(getSlashCommandNamesFromPayload(fixedSlashCommands));
  const dracoonAssetCommandNames = new Set<string>();
  const registeredGroupedCommandNames = new Set<string>();
  let assetTriggersTotal = 0;
  let skippedCommandLimit = 0;
  let skippedEmptyTriggers = 0;
  let skippedDuplicateNames = 0;
  let imageDracoonAssetCommandsRegistered = 0;
  let imageNonDracoonAssetCommandsRegistered = 0;
  let textAssetCommandsRegistered = 0;
  for (const asset of assets) {
    if ((asset instanceof ImageAsset || asset instanceof TextAsset) && 0 <= asset.trigger.length) {
      for (const trigger of asset.trigger) {
        assetTriggersTotal += 1;
        const groupedAssetCommand = groupedAssetCommandByTrigger.get(trigger);
        if (groupedAssetCommand) {
          if (true === registeredGroupedCommandNames.has(groupedAssetCommand.commandName)) {
            continue;
          }

          registeredGroupedCommandNames.add(groupedAssetCommand.commandName);
          if (maxAssetCommands <= slashCommands.length) {
            skippedCommandLimit += 1;
            continue;
          }

          seenCommandNames.add(groupedAssetCommand.commandName);
          slashCommands.push(buildGroupedAssetSlashCommand(groupedAssetCommand));

          if (true === groupedAssetCommand.variants.some(groupedAssetVariant => {
            return groupedAssetVariant.asset instanceof ImageAsset && "dracoon" === groupedAssetVariant.asset.location;
          })) {
            imageDracoonAssetCommandsRegistered += 1;
            dracoonAssetCommandNames.add(groupedAssetCommand.commandName);
          } else if (true === groupedAssetCommand.variants.some(groupedAssetVariant => groupedAssetVariant.asset instanceof ImageAsset)) {
            imageNonDracoonAssetCommandsRegistered += 1;
          } else if (true === groupedAssetCommand.variants.some(groupedAssetVariant => groupedAssetVariant.asset instanceof TextAsset)) {
            textAssetCommandsRegistered += 1;
          }

          continue;
        }

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

        if (maxAssetCommands <= slashCommands.length) {
          skippedCommandLimit += 1;
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
  slashCommands.push(...fixedSlashCommands);

  if (0 < skippedCommandLimit || 0 < skippedEmptyTriggers || 0 < skippedDuplicateNames) {
    logger.log(
      "warn",
      {
        source: "slash-registration",
        max_commands_per_scope: maxSlashCommandsPerScope,
        asset_triggers_total: assetTriggersTotal,
        asset_commands_registered: assetCommandsRegistered,
        fixed_commands_registered: fixedCommandsRegistered,
        total_commands_registered: slashCommands.length,
        skipped_command_limit: skippedCommandLimit,
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
    skippedCommandLimit,
    skippedEmptyTriggers,
    skippedDuplicateNames,
    imageDracoonAssetCommandsRegistered,
    imageNonDracoonAssetCommandsRegistered,
    textAssetCommandsRegistered,
  };
}
