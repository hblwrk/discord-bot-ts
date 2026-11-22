// Discord-markdown helpers shared by the link rewrite features: URL candidate
// matching, embed-suppression brackets, spoiler spans, poster credit, message
// length limits and deferred embed suppression.

export const discordMaxMessageLength = 2_000;
export const embedSuppressionWaitMs = 15_000;
export const linkCandidateRegex = /https?:\/\/[^\s<>"'|]+/giu;

const trailingUrlPunctuation = ".,!?;:)]}";
const linkWrapperPunctuation = "<>\"'.,!?;:()[]{}|";

export type TextSpan = {start: number; end: number};

export function trimTrailingUrlPunctuation(value: string): string {
  let trimmed = value;
  while ("" !== trimmed && trailingUrlPunctuation.includes(trimmed.at(-1) ?? "")) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed;
}

// Discord does not unfurl links wrapped in angle brackets.
export function isEmbedSuppressedLink(content: string, start: number, length: number): boolean {
  return "<" === content[start - 1] && ">" === content[start + length];
}

function isEscaped(content: string, index: number): boolean {
  let backslashCount = 0;
  let i = index - 1;
  while (0 <= i && "\\" === content[i]) {
    backslashCount++;
    i--;
  }

  return 0 !== backslashCount % 2;
}

// Spoiler delimiters inside inline code or code blocks are literal text.
export function getSpoilerSpans(content: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let openIndex: number | undefined = undefined;
  let i = 0;

  while (i < content.length - 1) {
    if ("`" === content[i] && false === isEscaped(content, i)) {
      if (content.startsWith("```", i)) {
        const closeIndex = content.indexOf("```", i + 3);
        i = -1 === closeIndex ? content.length : closeIndex + 3;
        continue;
      }
      const closeIndex = content.indexOf("`", i + 1);
      i = -1 === closeIndex ? content.length : closeIndex + 1;
      continue;
    }
    if ("|" === content[i] && "|" === content[i + 1]) {
      if (false === isEscaped(content, i)) {
        if (undefined === openIndex) {
          openIndex = i;
        } else {
          spans.push({start: openIndex, end: i + 2});
          openIndex = undefined;
        }
        i += 2;
        continue;
      }
    }
    i++;
  }

  return spans;
}

export function isInsideSpoiler(spans: readonly TextSpan[], start: number, end: number): boolean {
  return spans.some(span => span.start <= start && end <= span.end);
}

export function wrapSpoiler(url: string): string {
  return `||${url}||`;
}

export function unwrapSpoiler(url: string): string {
  return url.startsWith("||") && url.endsWith("||") && 4 <= url.length
    ? url.slice(2, -2)
    : url;
}

// Joins links with newlines, dropping the links that would exceed maxLength.
export function getMessageContentWithinDiscordLimit(links: string[], maxLength: number = discordMaxMessageLength): string {
  const acceptedLinks: string[] = [];
  let messageLength = 0;

  for (const link of links) {
    const nextLength = messageLength + (0 === acceptedLinks.length ? 0 : 1) + link.length;
    if (nextLength > maxLength) {
      break;
    }

    acceptedLinks.push(link);
    messageLength = nextLength;
  }

  return acceptedLinks.join("\n");
}

// A message "only contains links" when removing every repostable URL leaves
// only whitespace and common link-wrapper punctuation. Bracket-suppressed
// links count as text, so the poster's choice to hide a preview is kept.
export function messageIsOnlyLinks(content: string, isRepostableLink: (url: string) => boolean): boolean {
  let foundRepostableLink = false;
  const remainder = content.replace(linkCandidateRegex, (match, offset: number) => {
    if (isEmbedSuppressedLink(content, offset, match.length)
      || false === isRepostableLink(trimTrailingUrlPunctuation(match))) {
      return match;
    }

    foundRepostableLink = true;
    return "";
  });

  if (false === foundRepostableLink) {
    return false;
  }

  for (const character of remainder) {
    if (false === /\s/u.test(character) && false === linkWrapperPunctuation.includes(character)) {
      return false;
    }
  }

  return true;
}

// Credit the poster with a Discord mention (<@id>) rather than their plaintext
// name. Replacements are posted in the bot's name, so a user-controlled name
// string could be used to impersonate someone else ("From <victim>: <link>").
// A mention is resolved by Discord to the real account captured at post time —
// it cannot be spoofed and stays clickable. With allowedMentions.parse empty it
// renders without pinging. Fall back to a neutral label if no author id exists.
export function resolvePosterCredit(author: {id?: string} | undefined): string {
  const authorId = author?.id;
  return undefined === authorId || "" === authorId
    ? "someone"
    : `<@${authorId}>`;
}

export function messageHasEmbeds(message: {embeds?: readonly unknown[] | null}): boolean {
  return Array.isArray(message.embeds) && 0 < message.embeds.length;
}

// Discord attaches link cards after a message is created, delivering them as
// a separate messageUpdate. Suppressing at messageCreate races that update, so
// callers track message ids until the embed appears. Ids whose card never
// materialises expire after waitMs.
export function createEmbedSuppressionTracker(waitMs: number = embedSuppressionWaitMs) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  function stop(messageId: string): void {
    const pendingTimeout = pending.get(messageId);
    if (undefined === pendingTimeout) {
      return;
    }

    clearTimeout(pendingTimeout);
    pending.delete(messageId);
  }

  function track(messageId: string): void {
    stop(messageId);
    const pendingTimeout = setTimeout(() => {
      pending.delete(messageId);
    }, waitMs);
    pendingTimeout.unref();
    pending.set(messageId, pendingTimeout);
  }

  return {
    has: (messageId: string): boolean => pending.has(messageId),
    stop,
    track,
  };
}
