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

// "original" links point at the site itself, whose previews do not work in
// Discord; "proxy" links already point at an embed proxy.
export type RewriteSource = "original" | "proxy";

export type ParsedRewriteLink = {
  // Cleaned URL.
  url: string;
  source: RewriteSource;
  // Links that show the same content share a key and are posted once.
  key: string;
};

export type RewrittenLink = {
  // Cleaned URL, spoiler-wrapped when the original was inside a spoiler.
  link: string;
  source: RewriteSource;
  // Whether cleaning altered the pasted URL. Original links always change.
  changed: boolean;
};

export type LinkCandidate = {
  // Pasted URL without trailing punctuation.
  url: string;
  spoilered: boolean;
};

export type LinkRewriteResult = {
  links: RewrittenLink[];
  // Pasted URLs that produced a link. Other URLs count as message text.
  rewrittenUrls: ReadonlySet<string>;
};

export type LinkRewriteMessage = {
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

export type LinkSuppressibleMessage = {
  embeds?: readonly unknown[] | null;
  id: string;
  suppressEmbeds: (suppress?: boolean) => Promise<unknown>;
};

export type LinkRewriteClient = {
  on: {
    (eventName: "messageCreate", handler: (message: LinkRewriteMessage) => Promise<void>): unknown;
    (eventName: "messageUpdate", handler: (oldMessage: unknown, newMessage: LinkSuppressibleMessage) => Promise<void>): unknown;
  };
};

export type LinkRewriteFeature = {
  // Site name used in log messages.
  siteName: string;
  getLinks: (content: string) => LinkRewriteResult | Promise<LinkRewriteResult>;
};

// URLs in paste order. Bracket-suppressed links are skipped.
export function getLinkCandidates(content: string): LinkCandidate[] {
  const spans = getSpoilerSpans(content);
  const candidates: LinkCandidate[] = [];
  for (const match of content.matchAll(linkCandidateRegex)) {
    if (isEmbedSuppressedLink(content, match.index, match[0].length)) {
      continue;
    }

    candidates.push({
      url: trimTrailingUrlPunctuation(match[0]),
      spoilered: isInsideSpoiler(spans, match.index, match.index + match[0].length),
    });
  }

  return candidates;
}

// Cleaned links in paste order, deduplicated by key. A spoilered duplicate
// replaces an earlier plain one so that the spoiler is kept.
export function buildLinkRewriteResult(
  entries: readonly {candidate: LinkCandidate; parsed: ParsedRewriteLink | undefined}[],
): LinkRewriteResult {
  const links = new Map<string, RewrittenLink>();
  const rewrittenUrls = new Set<string>();
  for (const {candidate, parsed} of entries) {
    if (undefined === parsed) {
      continue;
    }

    rewrittenUrls.add(candidate.url);
    if (false === links.has(parsed.key) || candidate.spoilered) {
      links.set(parsed.key, {
        link: candidate.spoilered ? wrapSpoiler(parsed.url) : parsed.url,
        source: parsed.source,
        changed: parsed.url !== candidate.url,
      });
    }
  }

  return {links: [...links.values()], rewrittenUrls};
}

async function suppressOriginalEmbeds(message: LinkSuppressibleMessage, siteName: string) {
  try {
    await message.suppressEmbeds(true);
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error suppressing ${siteName} embed: ${error}`,
    );
  }
}

async function replyWithFixedLinks(message: LinkRewriteMessage, content: string, siteName: string) {
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
      `Error sending fixed ${siteName} link: ${error}`,
    );
  }
}

// Delete a link-only message and repost its cleaned links in the bot's name,
// crediting the original poster by mention ("From <@id>: <link>"). Removing
// the original also removes its tracking parameters from the channel. When the
// deleted message was a reply, the replacement replies to the same message.
// Returns whether the original was removed; a failed deletion falls back to
// the reply flow.
async function replaceLinkOnlyMessage(message: LinkRewriteMessage, links: string[], siteName: string): Promise<boolean> {
  const prefix = `From ${resolvePosterCredit(message.author)}: `;
  // Cleaned links are short, so at least the first one always fits.
  const content = getMessageContentWithinDiscordLimit(links, discordMaxMessageLength - prefix.length);
  const referencedMessageId = message.reference?.messageId;

  try {
    await message.delete();
  } catch (error: unknown) {
    logger.log(
      "error",
      `Error deleting original ${siteName} message: ${error}`,
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
      `Error posting replacement ${siteName} message: ${error}`,
    );
  }

  return true;
}

// Link-only messages are replaced when cleaning changes a link: original links
// gain a working preview, proxy links lose their tracking parameters. Other
// messages get a reply with the fixed original links, and the broken preview
// on the message is suppressed.
export function addLinkRewriteHandlers(client: LinkRewriteClient, feature: LinkRewriteFeature) {
  const {siteName} = feature;
  // The site's card arrives as a separate messageUpdate; suppression waits
  // for it (see createEmbedSuppressionTracker).
  const pendingEmbedSuppressions = createEmbedSuppressionTracker();

  client.on("messageCreate", async message => {
    if (true === message.author?.bot || Boolean(message.webhookId)) {
      return;
    }

    const {links, rewrittenUrls} = await feature.getLinks(message.content);
    if (links.some(link => link.changed)
      && messageIsOnlyLinks(message.content, url => rewrittenUrls.has(url))
      && await replaceLinkOnlyMessage(message, links.map(link => link.link), siteName)) {
      return;
    }

    const fixedLinks = links.filter(link => "original" === link.source).map(link => link.link);
    if (0 === fixedLinks.length) {
      return;
    }

    // Suppression affects every embed on a message. Preserve existing proxy
    // previews when original links are pasted alongside them.
    if (false === links.some(link => "proxy" === link.source)) {
      if (messageHasEmbeds(message)) {
        void suppressOriginalEmbeds(message, siteName);
      } else {
        pendingEmbedSuppressions.track(message.id);
      }
    }

    await replyWithFixedLinks(message, getMessageContentWithinDiscordLimit(fixedLinks), siteName);
  });

  client.on("messageUpdate", async (_oldMessage, newMessage) => {
    if (false === pendingEmbedSuppressions.has(newMessage.id)) {
      return;
    }

    if (false === messageHasEmbeds(newMessage)) {
      return;
    }

    pendingEmbedSuppressions.stop(newMessage.id);
    await suppressOriginalEmbeds(newMessage, siteName);
  });
}
