import type {APIEmbed} from "discord.js";

export type TwitterBadge = {linkNumber: number; embed: APIEmbed};
const messageLimit = 2_000;

export function appendTwitterBadgeText(content: string, badges: TwitterBadge[], multipleLinks: boolean): string {
  const blocks: string[] = [];
  for (const {linkNumber, embed} of badges) {
    if (!embed.title) {
      continue;
    }
    const scored = /(?:^|\s)\d+% Spiciness/u.test(embed.title);
    const check = embed.fields?.find(field => field.name.startsWith("AI web cross-check:"));
    // A scored status is displayed only after the factual check finishes.
    if (scored && undefined === check) {
      continue;
    }
    const indicator = scored ? /^(🟢|🟡)/u.exec(embed.title)?.[1] : embed.title;
    if (undefined === indicator) {
      continue;
    }
    const source = undefined === check ? undefined
      : /\[Source(?: \d+)?\]\((https:\/\/[^)\s]+)\)/u.exec(check.value)?.[1];
    const label = multipleLinks ? `Link ${linkNumber}: ${indicator}` : indicator;
    const block = `-# ${label}${undefined === source ? "" : ` [source](<${source}>)`}`;
    const nextBlocks = [...blocks, block];
    const candidate = [content, ...nextBlocks].filter(Boolean).join("\n");
    if (candidate.length <= messageLimit) {
      blocks.push(block);
    }
  }
  return blocks.length ? [content, ...blocks].filter(Boolean).join("\n") : content;
}
