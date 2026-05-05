import moment from "moment-timezone";
import {normalizeTickerSymbol} from "./earnings-results-format.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

type EarningsResultClient = {
  channels?: {
    cache?: {
      get?: (channelID: string) => unknown;
    };
    fetch?: (channelID: string) => Promise<unknown> | unknown;
  };
};

type FetchableMessageManager = {
  fetch: (options: {limit: number}) => Promise<unknown> | unknown;
};

type FetchedMessageCollection = {
  values: () => Iterable<unknown>;
};

const defaultRecentMessageFetchLimit = 100;
const usEasternTimezone = "US/Eastern";
const dateStampFormat = "YYYY-MM-DD";

export async function seedSeenEarningsResultAnnouncementsFromHistory({
  announcementThreadID,
  channelID,
  client,
  dateStamp,
  logger,
  seenAccessions,
  seenResultKeys,
}: {
  announcementThreadID: string | undefined;
  channelID: string;
  client: EarningsResultClient;
  dateStamp: string;
  logger: Logger;
  seenAccessions: Set<string>;
  seenResultKeys: Set<string>;
}): Promise<boolean> {
  const targetChannelID = announcementThreadID ?? channelID;
  const seededTarget = await seedSeenAccessionsFromChannelHistory(
    client,
    targetChannelID,
    seenAccessions,
    seenResultKeys,
    logger,
    dateStamp,
  );
  if (false === seededTarget) {
    return false;
  }

  if (undefined !== announcementThreadID && announcementThreadID !== channelID) {
    await seedSeenAccessionsFromChannelHistory(
      client,
      channelID,
      seenAccessions,
      seenResultKeys,
      logger,
      dateStamp,
      false,
    );
  }

  return true;
}

export function getEarningsResultKey(ticker: string, dateStamp: string): string {
  return `${dateStamp}:${normalizeTickerSymbol(ticker)}`;
}

async function seedSeenAccessionsFromChannelHistory(
  client: EarningsResultClient,
  channelID: string,
  seenAccessions: Set<string>,
  seenResultKeys: Set<string>,
  logger: Logger,
  dateStamp: string,
  required = true,
): Promise<boolean> {
  const channel = await fetchChannel(client, channelID, logger);
  const messages = isObjectLike(channel) && "messages" in channel
    ? channel.messages
    : undefined;
  if (false === isFetchableMessageManager(messages)) {
    logger.log(
      "warn",
      true === required
        ? `Skipping earnings result scan: channel ${channelID} message history is not fetchable.`
        : `Could not seed earnings result announcements from optional channel ${channelID}: message history is not fetchable.`,
    );
    return false === required;
  }

  const fetchedMessages = await Promise.resolve(messages.fetch({
    limit: defaultRecentMessageFetchLimit,
  })).catch(error => {
    logger.log(
      "warn",
      `Could not seed earnings result announcements from channel history: ${error}`,
    );
    return null;
  });
  if (null === fetchedMessages) {
    return false === required;
  }

  for (const message of getFetchedMessageValues(fetchedMessages)) {
    const content = getMessageContent(message);
    if (null === content) {
      continue;
    }

    for (const accessionNumber of extractSecAccessionNumbers(content)) {
      seenAccessions.add(accessionNumber);
    }

    if (true === isMessageFromDate(message, dateStamp)) {
      for (const ticker of extractEarningsResultTickers(content)) {
        seenResultKeys.add(getEarningsResultKey(ticker, dateStamp));
      }
    }
  }

  return true;
}

async function fetchChannel(
  client: EarningsResultClient,
  channelID: string,
  logger: Logger,
): Promise<unknown> {
  const cachedChannel = client.channels?.cache?.get?.(channelID);
  if (undefined !== cachedChannel) {
    return cachedChannel;
  }

  const fetchChannelFn = client.channels?.fetch;
  if ("function" !== typeof fetchChannelFn) {
    return undefined;
  }

  return Promise.resolve(fetchChannelFn(channelID)).catch(error => {
    logger.log(
      "warn",
      `Could not fetch earnings result channel ${channelID}: ${error}`,
    );
    return undefined;
  });
}

function getFetchedMessageValues(fetchedMessages: unknown): unknown[] {
  if (true === isFetchedMessageCollection(fetchedMessages)) {
    return [...fetchedMessages.values()];
  }

  return [];
}

function isFetchableMessageManager(value: unknown): value is FetchableMessageManager {
  return isObjectLike(value) &&
    "fetch" in value &&
    "function" === typeof value.fetch;
}

function isFetchedMessageCollection(value: unknown): value is FetchedMessageCollection {
  const values = isObjectLike(value) && "values" in value
    ? value.values
    : undefined;
  return "function" === typeof values;
}

function isObjectLike(value: unknown): value is object {
  return Object(value) === value;
}

function getMessageContent(message: unknown): string | null {
  if ("object" !== typeof message || null === message || false === "content" in message) {
    return null;
  }

  return "string" === typeof message.content ? message.content : null;
}

function extractSecAccessionNumbers(content: string): string[] {
  const accessions = new Set<string>();
  for (const match of content.matchAll(/\b\d{10}-\d{2}-\d{6}\b/g)) {
    accessions.add(match[0]);
  }

  for (const match of content.matchAll(/\/Archives\/edgar\/data\/\d+\/(\d{18})\//gi)) {
    const compactAccession = match[1];
    if (undefined === compactAccession) {
      continue;
    }

    accessions.add(formatCompactAccessionNumber(compactAccession));
  }

  return [...accessions];
}

function extractEarningsResultTickers(content: string): string[] {
  const tickers = new Set<string>();
  for (const match of content.matchAll(/\(`([A-Z0-9./-]{1,16})`\)/g)) {
    const ticker = match[1];
    if (undefined !== ticker) {
      tickers.add(normalizeTickerSymbol(ticker));
    }
  }

  return [...tickers];
}

function isMessageFromDate(message: unknown, dateStamp: string): boolean {
  const createdAtMs = getMessageCreatedAtMs(message);
  if (undefined === createdAtMs) {
    return false;
  }

  return moment(createdAtMs).tz(usEasternTimezone).format(dateStampFormat) === dateStamp;
}

function getMessageCreatedAtMs(message: unknown): number | undefined {
  if (false === isObjectLike(message)) {
    return undefined;
  }

  const messageRecord = message as Record<string, unknown>;
  const createdTimestamp = messageRecord["createdTimestamp"];
  if ("number" === typeof createdTimestamp && true === Number.isFinite(createdTimestamp)) {
    return createdTimestamp;
  }

  const createdAt = messageRecord["createdAt"];
  if (createdAt instanceof Date) {
    return createdAt.getTime();
  }

  if ("string" === typeof createdAt) {
    const parsedDate = Date.parse(createdAt);
    return Number.isFinite(parsedDate) ? parsedDate : undefined;
  }

  return undefined;
}

function formatCompactAccessionNumber(value: string): string {
  return `${value.slice(0, 10)}-${value.slice(10, 12)}-${value.slice(12)}`;
}
