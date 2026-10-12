import type {APIEmbed} from "discord.js";

export type TwitterBadge = {linkNumber: number; embed: APIEmbed};
const messageLimit = 2_000;

export function appendTwitterBadgeText(content: string, badges: TwitterBadge[], multipleLinks: boolean): string {
  const blocks: string[] = [];
  const linkLines = content ? content.split("\n") : [];
  for (const {linkNumber, embed} of badges) {
    if (!embed.title) {
      continue;
    }
    const scored = /(?:^|\s)\d+% Spiciness/u.test(embed.title);
    const check = embed.fields?.find(field => field.name.startsWith("AI web cross-check:"));
    // A scored status needs an explicit factual-review state, including pending
    // and unverified results, so the indicator never implies a checked claim.
    if (scored && undefined === check) {
      continue;
    }
    const indicator = scored ? /^(🟢|🟡|🔴)/u.exec(embed.title)?.[1] : embed.title;
    if (undefined === indicator) {
      continue;
    }
    const status = scored ? ` ${shortTrustStatus(embed.title, indicator)}` : "";
    const source = undefined === check ? undefined
      : /\[Source(?: \d+)?\]\((https:\/\/[^)\s]+)\)/u.exec(check.value)?.[1];
    const label = multipleLinks && !content ? `Link ${linkNumber}: ${indicator}${status}` : `${indicator}${status}`;
    const badgeText = `${label}${undefined === source ? "" : ` [source](<${source}>)`}`;
    if (content) {
      const lineIndex = linkNumber - 1;
      if (lineIndex < 0 || lineIndex >= linkLines.length) continue;
      const candidateLines = [...linkLines];
      candidateLines[lineIndex] += `  ${badgeText}`;
      if (candidateLines.join("\n").length <= messageLimit) linkLines[lineIndex] = candidateLines[lineIndex]!;
      continue;
    }
    const block = `-# ${badgeText}`;
    const nextBlocks = [...blocks, block];
    const candidate = [content, ...nextBlocks].filter(Boolean).join("\n");
    if (candidate.length <= messageLimit) {
      blocks.push(block);
    }
  }
  return content ? linkLines.join("\n") : blocks.join("\n");
}

function shortTrustStatus(title: string, indicator: string): string {
  if (indicator === "🟢") return "Supported claim";
  const reason = /Spiciness — ([^\n]+)/u.exec(title)?.[1];
  switch (reason) {
  case "Claim contradicted": return "Claim contradicted";
  case "Source credibility concerns": return "Source credibility concerns";
  case "Wording caution": return "Wording caution";
  case "Fact check pending": return "Checking claim";
  case "Fact check unverified": return "Claim unverified";
  case "Source check pending": return "Checking source credibility";
  case "Account caution": return "Account caution";
  default: return "Caution";
  }
}
