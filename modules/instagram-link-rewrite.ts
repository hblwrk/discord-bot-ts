import {getLogger} from "./logging.ts";
import {
  createEmbedSuppressionTracker,
  discordMaxMessageLength,
  getMessageContentWithinDiscordLimit,
  getSpoilerSpans,
  isEmbedSuppressedLink,
  isInsideSpoiler,
  linkCandidateRegex,
  messageHasEmbeds,
  messageIsOnlyLinks,
  resolvePosterCredit,
  trimTrailingUrlPunctuation,
  wrapSpoiler,
} from "./discord-link-utils.ts";

const logger = getLogger();

// Kirkstagram serves Discord the post metadata and media that instagram.com
// withholds from link crawlers.
const rewriteHost = "kirkstagram.com";
const instagramHosts = new Set(["instagram.com", "m.instagram.com", "instagr.am"]);
// Embed proxies whose previews already work; their links keep their host.
const instagramProxyHosts = new Set(["kirkstagram.com", "kkinstagram.com"]);
// Posts, reels and IGTV, optionally under a /<username>/ prefix, with the
// optional carousel position segment that the embed proxies accept.
const postPathRegex = /^\/(?:([\w.]{1,30})\/)?(p|reels?|tv)\/([\w-]{5,64})(?:\/([1-9]\d?))?\/?$/u;
// /share/p/<token> and /share/reel/<token> carry an opaque token that
// identifies the sharing account instead of the post shortcode.
const sharePathPrefix = "share";
// Instagram carousels hold at most 20 items.
const carouselIndexRegex = /^(?:[1-9]|1\d|20)$/u;

export type InstagramLink = {
  // Cleaned URL, spoiler-wrapped when the original was inside a spoiler.
  link: string;
  source: "instagram" | "proxy";
  // Whether cleaning altered the pasted URL. Raw Instagram links always change.
  changed: boolean;
};

type ParsedInstagramLink = {
  url: string;
  source: InstagramLink["source"];
  key: string;
};

type InstagramLinkRewriteMessage = {
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
      reply?: {
        failIfNotExists: boolean;
        messageReference: string;
      };
    }) => Promise<unknown>;
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
  }) => Promise<unknown>;
  suppressEmbeds: (suppress?: boolean) => Promise<unknown>;
  webhookId?: string | null;
};

type InstagramLinkSuppressibleMessage = {
  embeds?: readonly unknown[] | null;
  id: string;
  suppressEmbeds: (suppress?: boolean) => Promise<unknown>;
};

type InstagramLinkRewriteClient = {
  on: {
    (eventName: "messageCreate", handler: (message: InstagramLinkRewriteMessage) => Promise<void>): unknown;
    (eventName: "messageUpdate", handler: (oldMessage: unknown, newMessage: InstagramLinkSuppressibleMessage) => Promise<void>): unknown;
  };
};

function getCarouselIndex(url: URL): string | undefined {
  const index = url.searchParams.get("img_index");
  return null !== index && carouselIndexRegex.test(index) ? index : undefined;
}

// Rebuilds a post link from its host, path and carousel position alone. Every
// other query parameter (igsh/igshid share ids that tie a link to the account
// that shared it, utm_* campaign tags), the fragment and any credentials are
// discarded. URLs with credentials or a port are left alone.
function parseInstagramLink(value: string): ParsedInstagramLink | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if ("" !== url.username || "" !== url.password || "" !== url.port) {
    return undefined;
  }

  const host = url.hostname.startsWith("www.") ? url.hostname.slice(4) : url.hostname;
  const isRawInstagram = instagramHosts.has(host);
  if (false === isRawInstagram && false === instagramProxyHosts.has(host)) {
    return undefined;
  }

  const match = postPathRegex.exec(url.pathname);
  if (null === match || sharePathPrefix === match[1]?.toLowerCase()) {
    return undefined;
  }

  const [, , kindSegment, shortcode, pathIndex] = match;
  const index = pathIndex ?? getCarouselIndex(url);
  const key = `${shortcode}:${index ?? ""}`;
  if (isRawInstagram) {
    const kind = "reels" === kindSegment ? "reel" : kindSegment;
    const query = undefined === index ? "" : `?img_index=${index}`;
    return {url: `https://${rewriteHost}/${kind}/${shortcode}/${query}`, source: "instagram", key};
  }

  // Proxies keep their own path, including a carousel position segment.
  const query = undefined === pathIndex && undefined !== index ? `?img_index=${index}` : "";
  return {url: `https://${url.hostname}${url.pathname}${query}`, source: "proxy", key};
}

// Instagram post links in paste order, cleaned and deduplicated by post and
// carousel position. Bracket-suppressed links are skipped; spoilers are kept.
export function getInstagramLinks(content: string): InstagramLink[] {
  const spans = getSpoilerSpans(content);
  const links = new Map<string, InstagramLink>();
  for (const match of content.matchAll(linkCandidateRegex)) {
    if (isEmbedSuppressedLink(content, match.index, match[0].length)) {
      continue;
    }

    const pastedUrl = trimTrailingUrlPunctuation(match[0]);
    const parsed = parseInstagramLink(pastedUrl);
    if (undefined === parsed) {
      continue;
    }

    const isSpoilered = isInsideSpoiler(spans, match.index, match.index + match[0].length);
    if (false === links.has(parsed.key) || isSpoilered) {
      links.set(parsed.key, {
        link: isSpoilered ? wrapSpoiler(parsed.url) : parsed.url,
        source: parsed.source,
        changed: parsed.url !== pastedUrl,
      });
    }
  }

  return [...links.values()];
}

function isRepostableInstagramUrl(url: string): boolean {
  return undefined !== parseInstagramLink(url);
}

async function suppressOriginalEmbeds(message: InstagramLinkSuppressibleMessage) {
  try {
    await message.suppressEmbeds(true);
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error suppressing Instagram embed: ${error}`,
    );
  }
}

async function replyWithFixedLinks(message: InstagramLinkRewriteMessage, content: string) {
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
      `Error sending fixed Instagram link: ${error}`,
    );
  }
}

// Delete a link-only message and repost its cleaned links in the bot's name,
// crediting the original poster by mention ("From <@id>: <link>"). Removing
// the original also removes its tracking parameters from the channel. When the
// deleted message was a reply, the replacement replies to the same message.
// Returns whether the original was removed; a failed deletion falls back to
// the reply flow.
async function replaceLinkOnlyMessage(message: InstagramLinkRewriteMessage, links: string[]): Promise<boolean> {
  const prefix = `From ${resolvePosterCredit(message.author)}: `;
  // Cleaned links are short, so at least the first one always fits.
  const content = getMessageContentWithinDiscordLimit(links, discordMaxMessageLength - prefix.length);
  const referencedMessageId = message.reference?.messageId;

  try {
    await message.delete();
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error deleting original Instagram message: ${error}`,
    );
    return false;
  }

  try {
    await message.channel.send({
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
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error posting replacement Instagram message: ${error}`,
    );
  }

  return true;
}

export function addInstagramLinkRewrites(client: InstagramLinkRewriteClient) {
  // The Instagram card arrives as a separate messageUpdate; suppression waits
  // for it (see createEmbedSuppressionTracker).
  const pendingEmbedSuppressions = createEmbedSuppressionTracker();

  client.on("messageCreate", async message => {
    if (true === message.author?.bot || Boolean(message.webhookId)) {
      return;
    }

    const links = getInstagramLinks(message.content);
    // Link-only pastes are replaced when cleaning changes something: raw links
    // gain a working preview, proxy links lose their tracking parameters.
    if (links.some(link => link.changed)
      && messageIsOnlyLinks(message.content, isRepostableInstagramUrl)
      && await replaceLinkOnlyMessage(message, links.map(link => link.link))) {
      return;
    }

    const fixedLinks = links.filter(link => "instagram" === link.source).map(link => link.link);
    if (0 === fixedLinks.length) {
      return;
    }

    // Suppression affects every embed on a message. Preserve existing proxy
    // previews when raw Instagram links are pasted alongside them.
    if (false === links.some(link => "proxy" === link.source)) {
      if (messageHasEmbeds(message)) {
        void suppressOriginalEmbeds(message);
      } else {
        pendingEmbedSuppressions.track(message.id);
      }
    }

    await replyWithFixedLinks(message, getMessageContentWithinDiscordLimit(fixedLinks));
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
