import {getLogger} from "./logging.ts";

const logger = getLogger();
const discordMaxMessageLength = 2_000;
const embedSuppressionWaitMs = 15_000;
const trailingUrlPunctuation = ".,!?;:)]}";
const linkWrapperPunctuation = "<>\"'.,!?;:()[]{}";
const twitterUrlRegex = /https?:\/\/[^\s<>"']+/giu;
const twitterHosts = new Set([
  "mobile.twitter.com",
  "mobile.x.com",
  "m.twitter.com",
  "twitter.com",
  "x.com",
]);

type TwitterLinkRewriteMessage = {
  author?: {
    bot?: boolean;
    globalName?: string | null;
    username?: string;
  };
  channel: {
    send: (payload: {
      allowedMentions: {
        parse: string[];
      };
      content: string;
    }) => Promise<unknown> | unknown;
  };
  content: string;
  delete: () => Promise<unknown>;
  embeds?: readonly unknown[];
  id: string;
  member?: {
    displayName?: string;
  } | null;
  reply: (payload: {
    allowedMentions: {
      parse: string[];
      repliedUser: boolean;
    };
    content: string;
  }) => Promise<unknown> | unknown;
  suppressEmbeds: (suppress?: boolean) => Promise<unknown>;
  webhookId?: string | null;
};

// Discord generates link embeds asynchronously and delivers them via
// messageUpdate, so the suppression path only needs the message identity,
// its embeds, and the suppress call — not the full create-time shape.
type TwitterLinkSuppressibleMessage = {
  embeds?: readonly unknown[] | null;
  id: string;
  suppressEmbeds: (suppress?: boolean) => Promise<unknown>;
};

type TwitterLinkRewriteClient = {
  on: {
    (eventName: "messageCreate", handler: (message: TwitterLinkRewriteMessage) => Promise<void>): unknown;
    (eventName: "messageUpdate", handler: (oldMessage: unknown, newMessage: TwitterLinkSuppressibleMessage) => Promise<void>): unknown;
  };
};

function trimTrailingUrlPunctuation(value: string): string {
  let trimmed = value;
  while ("" !== trimmed && trailingUrlPunctuation.includes(trimmed.at(-1) ?? "")) {
    trimmed = trimmed.slice(0, -1);
  }

  return trimmed;
}

function normalizeTwitterHostname(hostname: string): string {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname.startsWith("www.")
    ? normalizedHostname.slice(4)
    : normalizedHostname;
}

function getFixedTwitterUrl(value: string): string | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return undefined;
  }

  if (false === twitterHosts.has(normalizeTwitterHostname(parsedUrl.hostname))) {
    return undefined;
  }

  if ("/" === parsedUrl.pathname) {
    return undefined;
  }

  return `https://fxtwitter.com${parsedUrl.pathname}`;
}

function getMessageContentWithinDiscordLimit(links: string[], maxLength: number = discordMaxMessageLength): string {
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

// A message "only contains the link" when removing every fixable Twitter/X URL
// leaves nothing but whitespace and the brackets/punctuation that commonly wrap
// a pasted URL. Those messages are deleted and reposted by the bot rather than
// replied to, so the channel shows a single clean fxtwitter card.
function messageIsOnlyFixableLinks(content: string): boolean {
  let foundFixableLink = false;
  const remainder = content.replace(twitterUrlRegex, match => {
    if (undefined === getFixedTwitterUrl(trimTrailingUrlPunctuation(match))) {
      return match;
    }

    foundFixableLink = true;
    return "";
  });

  if (false === foundFixableLink) {
    return false;
  }

  for (const character of remainder) {
    if (false === /\s/u.test(character) && false === linkWrapperPunctuation.includes(character)) {
      return false;
    }
  }

  return true;
}

function resolvePosterName(message: TwitterLinkRewriteMessage): string {
  return message.member?.displayName
    ?? message.author?.globalName
    ?? message.author?.username
    ?? "someone";
}

function messageHasEmbeds(message: {embeds?: readonly unknown[] | null}): boolean {
  return Array.isArray(message.embeds) && 0 < message.embeds.length;
}

async function suppressOriginalEmbeds(message: TwitterLinkSuppressibleMessage) {
  try {
    await message.suppressEmbeds(true);
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error suppressing Twitter/X embed: ${error}`,
    );
  }
}

async function replyWithFixedLinks(message: TwitterLinkRewriteMessage, content: string) {
  try {
    await message.reply({
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
      content,
    });
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error sending fixed Twitter/X link: ${error}`,
    );
  }
}

// Delete a link-only message and repost the fixed link in the bot's name,
// crediting the original poster ("From <name>: <link>"). Returns true when the
// original was removed so the caller skips the reply-and-suppress path; returns
// false (e.g. the bot lacks delete permission) to fall back to that path.
async function replaceLinkOnlyMessage(message: TwitterLinkRewriteMessage, fixedLinks: string[]): Promise<boolean> {
  const prefix = `From ${resolvePosterName(message)}: `;
  const content = getMessageContentWithinDiscordLimit(fixedLinks, discordMaxMessageLength - prefix.length);
  if ("" === content) {
    return false;
  }

  try {
    await message.delete();
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error deleting original Twitter/X message: ${error}`,
    );
    return false;
  }

  try {
    await message.channel.send({
      allowedMentions: {
        parse: [],
      },
      content: `${prefix}${content}`,
    });
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error posting replacement Twitter/X message: ${error}`,
    );
  }

  return true;
}

export function getFixedTwitterLinks(content: string): string[] {
  const fixedLinks = new Set<string>();
  const matches = content.matchAll(twitterUrlRegex);

  for (const match of matches) {
    const rawUrl = match[0];
    const fixedUrl = getFixedTwitterUrl(trimTrailingUrlPunctuation(rawUrl));
    if (fixedUrl) {
      fixedLinks.add(fixedUrl);
    }
  }

  return [...fixedLinks];
}

export function addTwitterLinkRewrites(client: TwitterLinkRewriteClient) {
  // Discord attaches the X/Twitter card after the message is created, arriving
  // as a separate messageUpdate. Suppressing at messageCreate races that update
  // and the card slips through, so we wait for the embed to appear before
  // suppressing. Track the message ids whose embeds are still pending, with a
  // timeout that drops ids whose card never materialises.
  const pendingEmbedSuppressions = new Map<string, ReturnType<typeof setTimeout>>();

  function stopTrackingMessage(messageId: string): void {
    const pendingTimeout = pendingEmbedSuppressions.get(messageId);
    if (undefined === pendingTimeout) {
      return;
    }

    clearTimeout(pendingTimeout);
    pendingEmbedSuppressions.delete(messageId);
  }

  function trackMessageForEmbedSuppression(messageId: string): void {
    stopTrackingMessage(messageId);
    const pendingTimeout = setTimeout(() => {
      pendingEmbedSuppressions.delete(messageId);
    }, embedSuppressionWaitMs);
    pendingTimeout.unref();
    pendingEmbedSuppressions.set(messageId, pendingTimeout);
  }

  client.on("messageCreate", async message => {
    if (true === message.author?.bot || Boolean(message.webhookId)) {
      return;
    }

    const fixedLinks = getFixedTwitterLinks(message.content);
    if (0 === fixedLinks.length) {
      return;
    }

    if (messageIsOnlyFixableLinks(message.content)) {
      const replaced = await replaceLinkOnlyMessage(message, fixedLinks);
      if (replaced) {
        return;
      }
    }

    const content = getMessageContentWithinDiscordLimit(fixedLinks);
    if ("" === content) {
      return;
    }

    if (messageHasEmbeds(message)) {
      await suppressOriginalEmbeds(message);
    } else {
      trackMessageForEmbedSuppression(message.id);
    }

    await replyWithFixedLinks(message, content);
  });

  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    if (false === pendingEmbedSuppressions.has(newMessage.id)) {
      return;
    }

    if (false === messageHasEmbeds(newMessage)) {
      return;
    }

    stopTrackingMessage(newMessage.id);
    await suppressOriginalEmbeds(newMessage);
  });
}
