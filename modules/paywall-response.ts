import {EmbedBuilder} from "discord.js";
import type {PaywallResult} from "./paywall.ts";

export type PaywallResponsePayload = {
  content: string;
  embeds: EmbedBuilder[];
};

export function buildPaywallResponsePayload(url: string, result: PaywallResult): PaywallResponsePayload {
  const embed = new EmbedBuilder();

  if (true === result.nofix) {
    embed.setTitle("Paywall Bypass");
    embed.setDescription("Für diese Seite ist leider kein Paywall-Bypass bekannt.");
    return {
      content: url,
      embeds: [embed],
    };
  }

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

  embed.addFields({name: "Ergebnisse", value: lines.join("\n")});

  return {
    content: url,
    embeds: [embed],
  };
}
