import {AttachmentBuilder, type ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder} from "discord.js";
import {ImageAsset, TextAsset} from "./assets.ts";
import {getLogger} from "./logging.ts";

const logger = getLogger();

export type GroupedAssetVariant = {
  asset: ImageAsset | TextAsset;
  trigger: string;
  variant: number;
};

export type GroupedAssetCommand = {
  baseTrigger: string;
  commandName: string;
  variants: GroupedAssetVariant[];
};

type SlashAssetInteraction = Pick<ChatInputCommandInteraction, "reply">;

export function toSlashCommandName(trigger: string): string {
  return trigger
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replaceAll(" ", "_")
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
}

function parseGroupedAssetTrigger(trigger: string) {
  const groupedTriggerMatch = /^(.*)\s+(\d+)$/.exec(trigger.trim());
  if (!groupedTriggerMatch) {
    return undefined;
  }

  const baseTrigger = groupedTriggerMatch[1]?.trim() ?? "";
  if ("" === baseTrigger) {
    return undefined;
  }

  return {
    baseTrigger,
    variant: Number(groupedTriggerMatch[2]),
  };
}

function isGroupedSlashAsset(asset: unknown): asset is ImageAsset | TextAsset {
  return asset instanceof ImageAsset || asset instanceof TextAsset;
}

export function getGroupedAssetCommands(assets: unknown[], reservedCommandNames: string[] = []): GroupedAssetCommand[] {
  const reservedCommandNameSet = new Set(reservedCommandNames);
  const exactCommandNames = new Set<string>();
  const groupedAssetCandidates = new Map<string, {
    baseTrigger: string;
    firstSeenIndex: number;
    rawBaseTriggers: Set<string>;
    variants: GroupedAssetVariant[];
  }>();
  let triggerIndex = 0;

  for (const asset of assets) {
    if (false === isGroupedSlashAsset(asset) || false === Array.isArray(asset.trigger)) {
      continue;
    }

    for (const trigger of asset.trigger) {
      const groupedTrigger = parseGroupedAssetTrigger(trigger);
      if (!groupedTrigger) {
        const exactCommandName = toSlashCommandName(trigger);
        if ("" !== exactCommandName) {
          exactCommandNames.add(exactCommandName);
        }

        triggerIndex += 1;
        continue;
      }

      const commandName = toSlashCommandName(groupedTrigger.baseTrigger);
      if ("" === commandName) {
        triggerIndex += 1;
        continue;
      }

      const groupedAssetCandidate = groupedAssetCandidates.get(commandName) ?? {
        baseTrigger: groupedTrigger.baseTrigger,
        firstSeenIndex: triggerIndex,
        rawBaseTriggers: new Set<string>(),
        variants: [],
      };
      groupedAssetCandidate.rawBaseTriggers.add(groupedTrigger.baseTrigger);
      groupedAssetCandidate.variants.push({
        asset,
        trigger,
        variant: groupedTrigger.variant,
      });
      groupedAssetCandidates.set(commandName, groupedAssetCandidate);
      triggerIndex += 1;
    }
  }

  return [...groupedAssetCandidates.entries()]
    .sort((left, right) => left[1].firstSeenIndex - right[1].firstSeenIndex)
    .flatMap(([commandName, groupedAssetCandidate]) => {
      if (groupedAssetCandidate.variants.length < 2) {
        return [];
      }

      if (true === reservedCommandNameSet.has(commandName) || true === exactCommandNames.has(commandName)) {
        return [];
      }

      if (1 !== groupedAssetCandidate.rawBaseTriggers.size) {
        return [];
      }

      const variantNumbers = groupedAssetCandidate.variants.map(groupedAssetVariant => groupedAssetVariant.variant);
      if (variantNumbers.length !== new Set(variantNumbers).size) {
        return [];
      }

      return [{
        baseTrigger: groupedAssetCandidate.baseTrigger,
        commandName,
        variants: [...groupedAssetCandidate.variants].sort((left, right) => left.variant - right.variant),
      }];
    });
}

export function buildGroupedAssetSlashCommand(groupedAssetCommand: GroupedAssetCommand): ReturnType<SlashCommandBuilder["toJSON"]> {
  const slashCommand = new SlashCommandBuilder()
    .setName(groupedAssetCommand.commandName)
    .setDescription(`Random oder Variante von ${groupedAssetCommand.baseTrigger}`.slice(0, 100));
  const variantChoices = groupedAssetCommand.variants.map(groupedAssetVariant => ({
    name: String(groupedAssetVariant.variant),
    value: groupedAssetVariant.variant,
  }));

  slashCommand.addIntegerOption(option => {
    option
      .setName("variant")
      .setDescription("Bestimmte Variante, leer = zufällig")
      .setRequired(false);

    const firstVariant = groupedAssetCommand.variants[0];
    const lastVariant = groupedAssetCommand.variants[groupedAssetCommand.variants.length - 1];
    if (variantChoices.length <= 25) {
      option.addChoices(...variantChoices);
    } else if (undefined !== firstVariant && undefined !== lastVariant) {
      option
        .setMinValue(firstVariant.variant)
        .setMaxValue(lastVariant.variant);
    }

    return option;
  });

  return slashCommand.toJSON();
}

export async function replyWithSlashAsset(interaction: SlashAssetInteraction, asset: ImageAsset | TextAsset, fallbackLabel: string) {
  if (asset instanceof ImageAsset) {
    if (!asset?.fileContent || !asset.fileName) {
      logger.log(
        "warn",
        `Asset ${asset.name ?? asset.fileName ?? fallbackLabel} is temporarily unavailable.`,
      );
      await interaction.reply("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch((error: unknown) => {
        logger.log(
          "error",
          `Error replying to slashcommand: ${error}`,
        );
      });
      return true;
    }

    const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
    if (asset.hasText) {
      const embed = new EmbedBuilder();
      embed.setImage(`attachment://${asset.fileName}`);
      embed.addFields(
        {name: asset.title, value: asset.text},
      );
      await interaction.reply({embeds: [embed], files: [file]});
    } else {
      await interaction.reply({files: [file]});
    }

    return true;
  }

  if (asset instanceof TextAsset) {
    await interaction.reply(asset.response).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to slashcommand: ${error}`,
      );
    });
    return true;
  }

  return false;
}
