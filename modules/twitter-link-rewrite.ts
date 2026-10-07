import {getLogger} from "./logging.ts";
import type {APIEmbed} from "discord.js";
import {createTwitterIntrospector, type TwitterIntrospector} from "./twitter-sanity.ts";
import {appendTwitterBadgeText, type TwitterBadge} from "./twitter-badge-text.ts";
import {getTwitterStatusId} from "./twitter-status-url.ts";

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

type TwitterLinkResponse = {
  edit: (payload: {
    content: string;
    allowedMentions: {parse: string[]; repliedUser: boolean};
  }) => Promise<unknown>;
};

type LinkDelivery = {response: TwitterLinkResponse; content: string; messageContent: string};

type TwitterLinkRewriteMessage = {
  author?: {
    bot?: boolean;
    id?: string;
  };
  channel: {
    send: (payload: {
      allowedMentions: {
        parse: string[];
        repliedUser?: boolean;
      };
      content: string;
      embeds?: APIEmbed[];
      reply?: {
        failIfNotExists: boolean;
        messageReference: string;
      };
    }) => Promise<TwitterLinkResponse> | TwitterLinkResponse;
  };
  content: string;
  delete: () => Promise<unknown>;
  embeds?: readonly unknown[];
  id: string;
  reference?: {
    messageId?: string;
  } | null;
  reply: (payload: {
    allowedMentions: {
      parse: string[];
      repliedUser: boolean;
    };
    content: string;
    embeds?: APIEmbed[];
  }) => Promise<TwitterLinkResponse> | TwitterLinkResponse;
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

// Keep proxy modifiers and queries; raw X/Twitter links use FxTwitter.
function getRepostedTwitterUrl(value: string): string | undefined {
  return getFixedTwitterUrl(value) ?? (undefined !== getTwitterStatusId(value) ? value : undefined);
}

function getRepostedTwitterLinks(content: string): string[] {
  const links = new Map<string, string>();
  for (const match of content.matchAll(twitterUrlRegex)) {
    if (isEmbedSuppressedLink(content, match.index, match[0].length)) {
      continue;
    }
    const link = getRepostedTwitterUrl(trimTrailingUrlPunctuation(match[0]));
    if (undefined !== link) {
      const key = getTwitterStatusId(link) ?? link;
      if (!links.has(key)) links.set(key, link);
    }
  }
  return [...links.values()];
}

function isEmbedSuppressedLink(content: string, start: number, length: number): boolean {
  return "<" === content[start - 1] && ">" === content[start + length];
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

// A message "only contains the link" when removing every supported Twitter/X
// or proxy URL leaves only whitespace and common link-wrapper punctuation.
// Those messages are deleted and reposted by the bot rather than
// replied to, so the channel shows a single link response with native previews.
function messageIsOnlyRepostableLinks(content: string): boolean {
  let foundRepostableLink = false;
  const remainder = content.replace(twitterUrlRegex, (match, offset: number) => {
    if (isEmbedSuppressedLink(content, offset, match.length)
      || undefined === getRepostedTwitterUrl(trimTrailingUrlPunctuation(match))) {
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
// name. The replacement is posted in the bot's name, so a user-controlled name
// string could be used to impersonate someone else ("From <victim>: <link>").
// A mention is resolved by Discord to the real account captured at post time —
// it cannot be spoofed and stays clickable. With allowedMentions.parse empty it
// renders without pinging. Fall back to a neutral label if no author id exists.
function resolvePosterCredit(message: TwitterLinkRewriteMessage): string {
  const authorId = message.author?.id;
  return undefined === authorId || "" === authorId
    ? "someone"
    : `<@${authorId}>`;
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

async function replyWithFixedLinks(message: TwitterLinkRewriteMessage, content: string): Promise<LinkDelivery | undefined> {
  try {
    const response = await message.reply({
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
      content,
    });
    return {response, content, messageContent: content};
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error sending fixed Twitter/X link: ${error}`,
    );
    return undefined;
  }
}

// Delete a link-only message and repost its links in the bot's name,
// crediting the original poster by mention ("From <@id>: <link>"). When the
// deleted message was a reply, the replacement replies to the same message.
// Reports whether the original was removed so the caller skips the reply path,
// including when sending fails; a failed deletion falls back to replying.
async function replaceLinkOnlyMessage(
  message: TwitterLinkRewriteMessage,
  fixedLinks: string[],
): Promise<{removed: boolean; delivery?: LinkDelivery}> {
  const prefix = `From ${resolvePosterCredit(message)}: `;
  const content = getMessageContentWithinDiscordLimit(fixedLinks, discordMaxMessageLength - prefix.length);
  const referencedMessageId = message.reference?.messageId;
  if ("" === content) {
    return {removed: false};
  }

  try {
    await message.delete();
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error deleting original Twitter/X message: ${error}`,
    );
    return {removed: false};
  }

  try {
    const response = await message.channel.send({
      allowedMentions: {
        parse: [],
        ...(undefined === referencedMessageId ? {} : {repliedUser: false}),
      },
      content: `${prefix}${content}`,
      ...(undefined === referencedMessageId
        ? {}
        : {
            reply: {
              failIfNotExists: false,
              messageReference: referencedMessageId,
            },
          }),
    });
    return {removed: true, delivery: {response, content, messageContent: `${prefix}${content}`}};
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error posting replacement Twitter/X message: ${error}`,
    );
  }

  return {removed: true};
}

async function updateSanityBadges(delivery: LinkDelivery, introspect: TwitterIntrospector): Promise<void> {
  // Assess only delivered links. Promise.all preserves paste order even when
  // providers finish out of order, and no inspection delays the initial send.
  const links = delivery.content.split("\n");
  const badges = await assessLinks(links, introspect);
  const content = appendTwitterBadgeText(delivery.messageContent, badges, links.length > 1);
  if (content === delivery.messageContent) {
    return;
  }
  try {
    // Explicit embeds replace Discord's automatic image/video preview. Edit
    // only content so the native unfurl remains under the converted link.
    await delivery.response.edit({content, allowedMentions: {parse: [], repliedUser: false}});
  } catch {
    // Deleted responses and missing edit permissions must not undo conversion.
    logger.log("warn", "Twitter/X badge update failed; keeping the converted link.");
  }
}

async function assessLinks(links: string[], introspect: TwitterIntrospector): Promise<TwitterBadge[]> {
  const results = await Promise.all(links.slice(0, 4).map(async (link, index) => {
    try {
      const embed = await introspect(link);
      return undefined !== embed ? {linkNumber: index + 1, embed} : undefined;
    } catch {
      logger.log("warn", "Twitter/X assessment failed; keeping the link preview.");
      return undefined;
    }
  }));
  return results.filter(badge => undefined !== badge);
}

async function replyWithProxyBadges(message: TwitterLinkRewriteMessage, links: string[], introspect: TwitterIntrospector): Promise<void> {
  const badges = await assessLinks(links, introspect);
  // Source references identify each proxy post without creating another unfurl.
  const identified = badges.map(badge => ({...badge, embed: {
    ...badge.embed, description: [badge.embed.description, `Post: <${links[badge.linkNumber - 1]}>`].filter(Boolean).join("\n"),
  }}));
  const content = appendTwitterBadgeText("", identified, links.length > 1).trimStart();
  if (!content) {
    return;
  }
  try {
    await message.reply({content, allowedMentions: {parse: [], repliedUser: false}});
  } catch {
    logger.log("warn", "Twitter/X proxy badge reply failed; keeping the original link preview.");
  }
}

export function getTwitterProxyLinks(content: string): string[] {
  const posts = new Map<string, string>();
  for (const match of content.matchAll(twitterUrlRegex)) {
    if (isEmbedSuppressedLink(content, match.index, match[0].length)) {
      continue;
    }
    const link = trimTrailingUrlPunctuation(match[0]);
    const id = getTwitterStatusId(link);
    if (undefined !== id && !posts.has(id)) {
      posts.set(id, link);
    }
  }
  return [...posts.values()];
}

export function getFixedTwitterLinks(content: string): string[] {
  const fixedLinks = new Set<string>();
  const matches = content.matchAll(twitterUrlRegex);

  for (const match of matches) {
    const rawUrl = match[0];
    if (isEmbedSuppressedLink(content, match.index, rawUrl.length)) {
      continue;
    }

    const fixedUrl = getFixedTwitterUrl(trimTrailingUrlPunctuation(rawUrl));
    if (fixedUrl) {
      fixedLinks.add(fixedUrl);
    }
  }

  return [...fixedLinks];
}

export function addTwitterLinkRewrites(
  client: TwitterLinkRewriteClient,
  introspect: TwitterIntrospector = createTwitterIntrospector({logger}),
) {
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
    const proxyLinks = getTwitterProxyLinks(message.content);
    if (messageIsOnlyRepostableLinks(message.content)) {
      const replacement = await replaceLinkOnlyMessage(message, getRepostedTwitterLinks(message.content));
      if (replacement.removed) {
        if (undefined !== replacement.delivery) {
          void updateSanityBadges(replacement.delivery, introspect);
        }
        return;
      }
    }

    const convertedLinks = getMessageContentWithinDiscordLimit(fixedLinks).split("\n").filter(Boolean).slice(0, 4);
    const convertedIds = new Set(convertedLinks
      .map(getTwitterStatusId).filter(id => undefined !== id));
    const extraLinks = proxyLinks.filter(link => !convertedIds.has(getTwitterStatusId(link) ?? "")).slice(0, 4 - convertedLinks.length);
    if (extraLinks.length) {
      // Original proxy links are already delivered; assessment never changes
      // their content or embeds and does not block conversion of raw X links.
      void replyWithProxyBadges(message, extraLinks, introspect);
    }
    if (0 === fixedLinks.length) {
      return;
    }

    // Suppression runs independently of sending the converted link.
    // Suppression affects every embed on a message. Preserve existing proxy
    // previews when raw Twitter/X links are pasted alongside them.
    if (!proxyLinks.length) {
      if (messageHasEmbeds(message)) {
        void suppressOriginalEmbeds(message);
      } else {
        trackMessageForEmbedSuppression(message.id);
      }
    }

    const content = getMessageContentWithinDiscordLimit(fixedLinks);
    if ("" === content) {
      return;
    }

    const delivery = await replyWithFixedLinks(message, content);
    if (undefined !== delivery) {
      void updateSanityBadges(delivery, introspect);
    }
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
