/* eslint-disable yoda */
/* eslint-disable complexity */
/* eslint-disable import/extensions */
import {SlashCommandBuilder} from "discord.js";
import {ImageAsset, TextAsset} from "./assets.js";
import {getLogger} from "./logging.js";
import {
  buildGroupedAssetSlashCommand,
  getGroupedAssetCommands,
  type GroupedAssetCommand,
  toSlashCommandName,
} from "./slash-commands-assets.js";
import {getSlashCommandNamesFromPayload} from "./slash-commands-canonical.js";

const logger = getLogger();
const maxSlashCommandsPerScope = 100;
export const fixedSlashCommandNames = ["cryptodice", "lmgtfy", "google", "8ball", "whatis", "quote", "islandboi", "sara", "earnings", "calendar", "paywall"];

export type SlashCommandPayloadBuildResult = {
  slashCommands: any[];
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

function createFixedSlashCommands(whatIsAssetsChoices: any[], userAssetsChoices: any[]) {
  const fixedSlashCommands = [];

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

  const slashCommandGoogle = new SlashCommandBuilder()
    .setName("google")
    .setDescription("Search...")
    .addStringOption(option =>
      option.setName("search")
        .setDescription("The search term")
        .setRequired(true));
  fixedSlashCommands.push(slashCommandGoogle.toJSON());

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

  const slashCommandIslandboi = new SlashCommandBuilder()
    .setName("islandboi")
    .setDescription("Island bwoi!");
  fixedSlashCommands.push(slashCommandIslandboi.toJSON());

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

  return fixedSlashCommands;
}

export function buildSlashCommandPayload(assets: any[], whatIsAssets: any[], userAssets: any[]): SlashCommandPayloadBuildResult {
  const whatIsAssetsChoices = [];
  for (const asset of whatIsAssets) {
    whatIsAssetsChoices.push({name: asset.title, value: asset.name});
  }

  const userAssetsChoices = [];
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

  const slashCommands = [];
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
