import {getLogger} from "./logging.ts";
import type {APIEmbed} from "discord.js";
import {
  createEmbedSuppressionTracker,
  discordMaxMessageLength,
  getMessageContentWithinDiscordLimit,
  getSpoilerSpans,
  isEmbedSuppressedLink,
  isInsideSpoiler,
  linkCandidateRegex as twitterUrlRegex,
  messageHasEmbeds,
  messageIsOnlyLinks,
  resolvePosterCredit,
  trimTrailingUrlPunctuation,
  unwrapSpoiler,
  wrapSpoiler,
} from "./discord-link-utils.ts";
import {createTwitterIntrospector, type TwitterIntrospector} from "./twitter-sanity.ts";
import {appendTwitterBadgeText, type TwitterBadge} from "./twitter-badge-text.ts";
import {getTwitterStatusId} from "./twitter-status-url.ts";

const logger = getLogger();
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
  const spans = getSpoilerSpans(content);
  const links = new Map<string, string>();
  for (const match of content.matchAll(twitterUrlRegex)) {
    if (isEmbedSuppressedLink(content, match.index, match[0].length)) {
      continue;
    }
    const cleanUrl = trimTrailingUrlPunctuation(match[0]);
    const repostedUrl = getRepostedTwitterUrl(cleanUrl);
    if (undefined !== repostedUrl) {
      const isSpoilered = isInsideSpoiler(spans, match.index, match.index + match[0].length);
      const link = isSpoilered ? wrapSpoiler(repostedUrl) : repostedUrl;
      const key = getTwitterStatusId(repostedUrl) ?? repostedUrl;
      if (!links.has(key) || isSpoilered) {
        links.set(key, link);
      }
    }
  }
  return [...links.values()];
}

// Link-only messages (supported Twitter/X or proxy URLs plus whitespace and
// wrapper punctuation) are deleted and reposted by the bot rather than
// replied to, so the channel shows a single link response with native previews.
function messageIsOnlyRepostableLinks(content: string): boolean {
  return messageIsOnlyLinks(content, url => undefined !== getRepostedTwitterUrl(url));
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
  const prefix = `From ${resolvePosterCredit(message.author)}: `;
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
  // Assess only delivered links. No inspection delays the initial send.
  const links = delivery.content.split("\n").map(unwrapSpoiler);
  if (undefined !== introspect.observe) {
    let latest: TwitterBadge[] = [];
    let displayed = delivery.messageContent;
    let editing = false;
    let failed = false;
    const flush = async () => {
      if (editing || failed) return;
      editing = true;
      try {
        while (!failed) {
          const content = appendTwitterBadgeText(delivery.messageContent, latest, links.length > 1);
          if (content === displayed) break;
          try {
            await delivery.response.edit({content, allowedMentions: {parse: [], repliedUser: false}});
            displayed = content;
          } catch {
            failed = true;
            logger.log("warn", "Twitter/X badge update failed; keeping the converted link.");
          }
        }
      } finally {
        editing = false;
      }
    };
    await observeLinks(links, introspect.observe, badges => { latest = badges; void flush(); });
    return;
  }
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

async function observeLinks(
  links: string[], observe: NonNullable<TwitterIntrospector["observe"]>, onChange: (badges: TwitterBadge[]) => void,
): Promise<void> {
  const badges = new Map<number, APIEmbed>();
  await Promise.all(links.slice(0, 4).map(async (link, index) => {
    try {
      await observe(link, embed => {
        badges.set(index + 1, embed);
        onChange([...badges].sort(([left], [right]) => left - right)
          .map(([linkNumber, badge]) => ({linkNumber, embed: badge})));
      });
    } catch {
      logger.log("warn", "Twitter/X assessment failed; keeping the link preview.");
    }
  }));
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
  const unwrappedLinks = links.map(unwrapSpoiler);
  if (undefined !== introspect.observe) {
    let latest: TwitterBadge[] = [];
    let response: TwitterLinkResponse | undefined;
    let displayed = "";
    let editing = false;
    let failed = false;
    const flush = async () => {
      if (editing || failed) return;
      editing = true;
      try {
        while (!failed) {
          const content = proxyBadgeContent(latest, unwrappedLinks);
          if (!content || content === displayed) break;
          try {
            if (undefined === response) {
              response = await message.reply({content, allowedMentions: {parse: [], repliedUser: false}});
            } else {
              await response.edit({content, allowedMentions: {parse: [], repliedUser: false}});
            }
            displayed = content;
          } catch {
            failed = true;
            logger.log("warn", "Twitter/X proxy badge reply failed; keeping the original link preview.");
          }
        }
      } finally {
        editing = false;
      }
    };
    await observeLinks(unwrappedLinks, introspect.observe, badges => { latest = badges; void flush(); });
    return;
  }
  const badges = await assessLinks(unwrappedLinks, introspect);
  const content = proxyBadgeContent(badges, unwrappedLinks);
  if (!content) return;
  try {
    await message.reply({content, allowedMentions: {parse: [], repliedUser: false}});
  } catch {
    logger.log("warn", "Twitter/X proxy badge reply failed; keeping the original link preview.");
  }
}

function proxyBadgeContent(badges: TwitterBadge[], links: string[]): string {
  return appendTwitterBadgeText("", badges, links.length > 1).trimStart();
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
  const spans = getSpoilerSpans(content);
  const fixedLinks = new Map<string, string>();
  const matches = content.matchAll(twitterUrlRegex);

  for (const match of matches) {
    const rawUrl = match[0];
    if (isEmbedSuppressedLink(content, match.index, rawUrl.length)) {
      continue;
    }

    const fixedUrl = getFixedTwitterUrl(trimTrailingUrlPunctuation(rawUrl));
    if (fixedUrl) {
      const isSpoilered = isInsideSpoiler(spans, match.index, match.index + rawUrl.length);
      const link = isSpoilered ? wrapSpoiler(fixedUrl) : fixedUrl;
      if (!fixedLinks.has(fixedUrl) || isSpoilered) {
        fixedLinks.set(fixedUrl, link);
      }
    }
  }

  return [...fixedLinks.values()];
}

export function addTwitterLinkRewrites(
  client: TwitterLinkRewriteClient,
  introspect: TwitterIntrospector = createTwitterIntrospector({logger}),
) {
  // The X/Twitter card arrives as a separate messageUpdate; suppression waits
  // for it (see createEmbedSuppressionTracker).
  const pendingEmbedSuppressions = createEmbedSuppressionTracker();

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
      .map(unwrapSpoiler).map(getTwitterStatusId).filter(id => undefined !== id));
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
        pendingEmbedSuppressions.track(message.id);
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

    pendingEmbedSuppressions.stop(newMessage.id);
    await suppressOriginalEmbeds(newMessage);
  });
}
