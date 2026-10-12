import type {APIEmbed} from "discord.js";

export type TwitterBadge = {linkNumber: number; embed: APIEmbed};
const messageLimit = 2_000;

export function appendTwitterBadgeText(content: string, badges: TwitterBadge[], multipleLinks: boolean): string {
  const blocks: string[] = [];
  for (const {linkNumber, embed} of badges) {
    if (!embed.title) {
      continue;
    }
    const compactTitle = embed.title.replace(/(\d+%) Spiciness(?: — [^\n]+| \([^\n]+\))?/u, "$1 wording spice");
    const title = multipleLinks ? `Link ${linkNumber}: ${compactTitle}` : compactTitle;
    // AI factual claims retain their citation, and note excerpts retain their
    // attribution/status disclaimer. Never truncate either into a bare claim.
    const evidence = (embed.fields ?? []).filter(field =>
      field.name.startsWith("AI web cross-check:") || field.name.startsWith("Source credibility:")
        || field.name.startsWith("Community Note via FxTwitter"));
    const score = /(?:^|\s)(\d+)% Spiciness/u.exec(embed.title);
    // Scored badges require a completed, source-linked AI check at every score.
    if (null !== score && !evidence.some(field => field.name.startsWith("AI web cross-check:"))) {
      continue;
    }
    const check = evidence.find(field => field.name.startsWith("AI web cross-check:"));
    const credibility = evidence.find(field => field.name.startsWith("Source credibility:"));
    const header = undefined === check ? title : [
      title,
      `**${check.name.replace("AI web cross-check:", "AI:").replace(" (review sources)", "")}**`,
      suppressCitationPreviews(check.value).replace(/\[Source(?: \d+)?\]\(</gu, "[source](<"),
    ].join(" · ");
    const credibilityLine = undefined === credibility ? undefined : [
      `**${credibility.name.replace("Source credibility:", "Source:")}**`,
      suppressCitationPreviews(credibility.value).replace("[Evidence](<", "[evidence](<"),
    ].join(" · ");
    const block = [header, embed.description, credibilityLine, ...evidence.filter(field => field !== check && field !== credibility).map(field =>
      `**${field.name}**\n${suppressCitationPreviews(field.value)}`)]
      .filter(line => undefined !== line && "" !== line).join("\n")
      .split("\n").map(line => `-# ${line}`).join("\n");
    const nextBlocks = [...blocks, block];
    const candidate = [content, ...nextBlocks].filter(Boolean).join("\n");
    if (candidate.length <= messageLimit) {
      blocks.push(block);
    }
  }
  // Link conversion has priority when the message has no room for a complete
  // assessment. Omit the edit rather than removing links or cited evidence.
  return blocks.length ? [content, ...blocks].filter(Boolean).join("\n") : content;
}

function suppressCitationPreviews(value: string): string {
  return value.replace(/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/gu, "[$1](<$2>)");
}
