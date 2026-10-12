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
    const primary = embed.title === "ℹ️ Company statement"
      ? embed.fields?.find(field => field.name.startsWith("Primary source: ")) : undefined;
    const report = embed.title === "ℹ️ Reported claim"
      ? embed.fields?.find(field => field.name === "Report source") : undefined;
    // A scored status needs an explicit factual-review state, including pending
    // and unverified results, so the indicator never implies a checked claim.
    if (scored && undefined === check) {
      continue;
    }
    const primaryUrl = /\[Source\]\((https:\/\/[^)\s]+)\)/u.exec(primary?.value ?? "")?.[1];
    const reportUrl = /\[Source\]\((https:\/\/[^)\s]+)\)/u.exec(report?.value ?? "")?.[1];
    if (embed.title === "ℹ️ Company statement" && (undefined === primary || undefined === primaryUrl)) continue;
    if (embed.title === "ℹ️ Reported claim" && undefined === reportUrl) continue;
    const indicator = scored ? /^(🟢|🟡|🔴)/u.exec(embed.title)?.[1]
      : undefined !== primary ? `ℹ️ ${primary.name.slice("Primary source: ".length)} statement`
        : undefined !== report ? "ℹ️ Reported" : embed.title;
    if (undefined === indicator) {
      continue;
    }
    const status = scored ? ` ${shortTrustStatus(embed.title, indicator)}` : "";
    const source = undefined === check ? primaryUrl ?? reportUrl
      : /\[Source(?: \d+)?\]\((https:\/\/[^)\s]+)\)/u.exec(check.value)?.[1];
    const label = multipleLinks && !content ? `Link ${linkNumber}: ${indicator}${status}` : `${indicator}${status}`;
    const citation = undefined === source ? "" : ` [source](<${source}>)`;
    const explanation = status === " Claim contradicted" && check?.name.startsWith("AI web cross-check: contradicted")
      && undefined !== source ? shortEvidenceReason(embed.description) : undefined;
    const badgeTexts = undefined === explanation
      ? [`${label}${citation}`] : [`${label} — ${explanation}${citation}`, `${label}${citation}`];
    if (content) {
      const lineIndex = linkNumber - 1;
      if (lineIndex < 0 || lineIndex >= linkLines.length) continue;
      for (const badgeText of badgeTexts) {
        const candidateLines = [...linkLines];
        candidateLines[lineIndex] += `  ${badgeText}`;
        if (candidateLines.join("\n").length <= messageLimit) {
          linkLines[lineIndex] = candidateLines[lineIndex]!;
          break;
        }
      }
      continue;
    }
    for (const badgeText of badgeTexts) {
      const block = `-# ${badgeText}`;
      if ([...blocks, block].join("\n").length <= messageLimit) {
        blocks.push(block);
        break;
      }
    }
  }
  return content ? linkLines.join("\n") : blocks.join("\n");
}

function shortEvidenceReason(description?: string): string | undefined {
  const reason = description?.trim();
  if (undefined === reason || reason.length < 15 || reason.length > 80 || /[@<>\n\r`*_~|\\]/u.test(reason)) {
    return undefined;
  }
  return reason;
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
