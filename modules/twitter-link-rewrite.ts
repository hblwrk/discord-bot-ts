import {getLogger} from "./logging.ts";

const logger = getLogger();
const discordMaxMessageLength = 2_000;
const trailingUrlPunctuation = ".,!?;:)]}";
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
  };
  content: string;
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

type TwitterLinkRewriteClient = {
  on: (eventName: "messageCreate", handler: (message: TwitterLinkRewriteMessage) => Promise<void>) => unknown;
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

function getMessageContentWithinDiscordLimit(links: string[]): string {
  const acceptedLinks: string[] = [];
  let messageLength = 0;

  for (const link of links) {
    const nextLength = messageLength + (0 === acceptedLinks.length ? 0 : 1) + link.length;
    if (nextLength > discordMaxMessageLength) {
      break;
    }

    acceptedLinks.push(link);
    messageLength = nextLength;
  }

  return acceptedLinks.join("\n");
}

async function suppressOriginalEmbeds(message: TwitterLinkRewriteMessage) {
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
  client.on("messageCreate", async message => {
    if (true === message.author?.bot || Boolean(message.webhookId)) {
      return;
    }

    const fixedLinks = getFixedTwitterLinks(message.content);
    if (0 === fixedLinks.length) {
      return;
    }

    const content = getMessageContentWithinDiscordLimit(fixedLinks);
    if ("" === content) {
      return;
    }

    await suppressOriginalEmbeds(message);
    await replyWithFixedLinks(message, content);
  });
}
