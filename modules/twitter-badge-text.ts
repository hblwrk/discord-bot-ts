import type {APIEmbed} from "discord.js";

export type TwitterBadge = {linkNumber: number; embed: APIEmbed};
const messageLimit = 2_000;
const legend = "Wording index, not a truth probability; media and bot activity unverified.";

export function appendTwitterBadgeText(content: string, badges: TwitterBadge[], multipleLinks: boolean): string {
  const blocks: string[] = [];
  let hasScore = false;
  for (const {linkNumber, embed} of badges) {
    if (!embed.title) {
      continue;
    }
    const title = multipleLinks ? `Link ${linkNumber}: ${embed.title}` : embed.title;
    // AI factual claims retain their citation, and note excerpts retain their
    // attribution/status disclaimer. Never truncate either into a bare claim.
    const evidence = (embed.fields ?? []).filter(field =>
      field.name.startsWith("AI web cross-check:") || field.name.startsWith("Community Note via FxTwitter"));
    const block = [title, embed.description, ...evidence.map(field => `${field.name}\n${suppressCitationPreviews(field.value)}`)]
      .filter(line => undefined !== line && "" !== line).join("\n");
    const nextHasScore: boolean = hasScore || embed.title.includes("Spiciness");
    const nextBlocks = [...blocks, block];
    const candidate = [content, ...nextBlocks, ...(nextHasScore ? [legend] : [])].join("\n\n");
    if (candidate.length <= messageLimit) {
      blocks.push(block);
      hasScore = nextHasScore;
    }
  }
  // Link conversion has priority when the message has no room for a complete
  // assessment. Omit the edit rather than removing links or cited evidence.
  return blocks.length ? [content, ...blocks, ...(hasScore ? [legend] : [])].join("\n\n") : content;
}

function suppressCitationPreviews(value: string): string {
  return value.replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/gu, "$1: <$2>");
}
