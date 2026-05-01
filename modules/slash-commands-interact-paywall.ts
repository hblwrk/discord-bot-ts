import {type ChatInputCommandInteraction, EmbedBuilder} from "discord.js";
import validator from "validator";
import {type PaywallAsset} from "./assets.ts";
import {getLogger} from "./logging.ts";
import {
  getPaywallLinks,
  PaywallLookupCapacityError,
  paywallLookupBusyMessage,
  type PaywallResult,
} from "./paywall.ts";
import {assertSafeRequestUrl, UnsafeUrlError} from "./safe-http.ts";

const logger = getLogger();

export async function handlePaywallSlashCommand(
  interaction: ChatInputCommandInteraction,
  commandName: string,
  paywallAssets?: PaywallAsset[],
): Promise<boolean> {
  if ("paywall" !== commandName) {
    return false;
  }

  const rawUrl = interaction.options.getString("url", true).trim();

  if (false === validator.isURL(rawUrl)) {
    await interaction.reply({
      content: "Ungültige URL. Bitte eine vollständige URL angeben (z.B. https://www.example.com/article).",
      ephemeral: true,
    }).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to paywall slashcommand (invalid URL): ${error}`,
      );
    });
    return true;
  }

  let url: string;
  try {
    url = assertSafeRequestUrl(rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`).toString();
  } catch (error: unknown) {
    if (error instanceof UnsafeUrlError) {
      await interaction.reply({
        content: "Ungültige URL. Bitte eine öffentliche http(s)-URL angeben.",
        ephemeral: true,
      }).catch((replyError: unknown) => {
        logger.log(
          "error",
          `Error replying to paywall slashcommand (unsafe URL): ${replyError}`,
        );
      });
      return true;
    }

    throw error;
  }

  const deferred = await interaction.deferReply().then(() => true).catch((error: unknown) => {
    logger.log(
      "error",
      `Error deferring paywall slashcommand reply: ${error}`,
    );
    return false;
  });
  if (false === deferred) {
    return true;
  }

  await interaction.editReply({
    content: `Suche nach Paywall-Bypass für <${url}>... Das kann bis zu 60 Sekunden dauern.`,
  }).catch((error: unknown) => {
    logger.log(
      "error",
      `Error sending paywall working message: ${error}`,
    );
  });

  try {
    const result: PaywallResult = await getPaywallLinks(url, paywallAssets ?? [], {
      requesterId: interaction.user.id,
    });
    const embed = new EmbedBuilder();

    if (true === result.nofix) {
      embed.setTitle("Paywall Bypass");
      embed.setDescription(
        `Für diese Seite ist leider kein Paywall-Bypass bekannt.`,
      );
      embed.addFields({name: "URL", value: `<${url}>`});
    } else {
      const title = true === result.isDefault
        ? "Paywall Bypass (unbekannte Seite)"
        : "Paywall Bypass";
      embed.setTitle(title);

      if (true === result.isDefault) {
        embed.setDescription("Unbekannte Seite — versuche allgemeine Services:");
      }

      const lines: string[] = [];
      for (const service of result.services) {
        if (true === service.available) {
          lines.push(`✅ **${service.name}**: <${service.url}>`);
        } else {
          lines.push(`❓ **${service.name}**: <${service.url}>`);
        }
      }

      embed.addFields(
        {name: "Original", value: `<${url}>`},
        {name: "Ergebnisse", value: lines.join("\n")},
      );
    }

    await interaction.editReply({content: "", embeds: [embed]}).catch((error: unknown) => {
      logger.log(
        "error",
        `Error replying to paywall slashcommand: ${error}`,
      );
    });
  } catch (error: unknown) {
    if (error instanceof PaywallLookupCapacityError) {
      await interaction.editReply({
        content: paywallLookupBusyMessage,
      }).catch((editError: unknown) => {
        logger.log(
          "error",
          `Error sending paywall busy message: ${editError}`,
        );
      });
      return true;
    }

    logger.log(
      "error",
      `Error processing paywall slashcommand: ${error}`,
    );
    await interaction.editReply({
      content: "Fehler beim Verarbeiten der Anfrage. Bitte später erneut versuchen.",
    }).catch((editError: unknown) => {
      logger.log(
        "error",
        `Error sending paywall error message: ${editError}`,
      );
    });
  }

  return true;
}
