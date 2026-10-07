import type {APIEmbed} from "discord.js";

export type TwitterBadge = {linkNumber: number; embed: APIEmbed};
const messageLimit = 2_000;
const legend = "-# Wording score ≠ truth probability · Media/bots unverified.";
const wordingOnlyStatus = "-# Wording only · Fact-check skipped · Media/bots unverified.";

export function appendTwitterBadgeText(content: string, badges: TwitterBadge[], multipleLinks: boolean): string {
  const blocks: string[] = [];
  let needsLegend = false;
  for (const {linkNumber, embed} of badges) {
    if (!embed.title) {
      continue;
    }
    const compactTitle = embed.title.replace(/(\d+%) Spiciness/u, "**$1 wording spice**").replace(" — ", " · ");
    const title = multipleLinks ? `Link ${linkNumber}: ${compactTitle}` : compactTitle;
    // AI factual claims retain their citation, and note excerpts retain their
    // attribution/status disclaimer. Never truncate either into a bare claim.
    const evidence = (embed.fields ?? []).filter(field =>
      field.name.startsWith("AI web cross-check:") || field.name.startsWith("Community Note via FxTwitter"));
    const score = /(?:^|\s)(\d+)% Spiciness/u.exec(embed.title);
    const wordingOnly = null !== score && Number(score[1]) < 30 && evidence.length === 0;
    // Low wording scores skip the AI check, rather than waiting for a verdict.
    // Keep proxy post references even when the generic explanation is omitted.
    const omitGenericDescription = wordingOnly || evidence.some(field => field.name.startsWith("Community Note via FxTwitter"));
    const description = omitGenericDescription
      ? embed.description?.split("\n").filter(line => line.startsWith("Post: <https://")).join("\n")
      : embed.description;
    const block = [title, description, ...evidence.map(field => {
      const name = field.name.replace("AI web cross-check:", "AI web check:");
      return `**${name}**\n${suppressCitationPreviews(field.value)}`;
    }), ...(wordingOnly ? [wordingOnlyStatus] : [])]
      .filter(line => undefined !== line && "" !== line).join("\n");
    const nextNeedsLegend: boolean = needsLegend || (null !== score && !wordingOnly);
    const nextBlocks = [...blocks, block];
    const candidate = [content, ...nextBlocks, ...(nextNeedsLegend ? [legend] : [])].filter(Boolean).join("\n");
    if (candidate.length <= messageLimit) {
      blocks.push(block);
      needsLegend = nextNeedsLegend;
    }
  }
  // Link conversion has priority when the message has no room for a complete
  // assessment. Omit the edit rather than removing links or cited evidence.
  return blocks.length ? [content, ...blocks, ...(needsLegend ? [legend] : [])].filter(Boolean).join("\n") : content;
}

function suppressCitationPreviews(value: string): string {
  return value.replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/gu, "$1: <$2>");
}
