import {Client} from "discord.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WS from "ws";
import {getAssets} from "./assets.js";
import {getLogger} from "./logging.js";
import {readSecret} from "./secrets.js";

const logger = getLogger();
const websocketSubscribeDomain = "cmt-1-5-945629:%%domain-1:}";
const discordUpdateIntervalSeconds = 15;
const streamWatchdogIntervalMs = 30_000;
const streamStaleTimeoutMs = 300_000;

type MarketDataAsset = {
  botToken: string;
  botClientId: string;
  botName: string;
  id: number;
  suffix: string;
  unit: string;
  decimals: number;
  lastUpdate: number;
  order: number;
};

type MarketStreamEvent = {
  pid: number;
  lastNumeric: number;
  priceChange: number;
  percentageChange: number;
};

// Launching multiple bots and Websocket stream to display price information
// Bot nickname and presence status updates have acceptable rate-limits (~5s)
export async function updateMarketData() {
  const marketDataAssets = await getAssets("marketdata") as MarketDataAsset[];
  if (0 === marketDataAssets.length) {
    logger.log(
      "warn",
      "No market data assets configured. Skipping stream startup.",
    );

    return;
  }

  const guildId = readSecret("discord_guildID").trim();
  const clientsById = new Map<string, Client>();
  let streamStarted = false;

  for (const marketDataAsset of marketDataAssets) {
    // Create a new client instance. Bots do not need any permissions
    const client = new Client({
      intents: [],
    });

    // Login to Discord
    client.login(marketDataAsset.botToken).catch(error => {
      logger.log(
        "error",
        `Error logging in market data bot: ${error}`,
      );
    });

    client.on("clientReady", () => {
      // Bot connection successful
      logger.log(
        "info",
        `Launched market data bot (${marketDataAsset.botName})`,
      );

      // Setting bot presence status to a default value
      client.user.setPresence({activities: [{name: "Market closed."}]});
      clientsById.set(marketDataAsset.botClientId, client);

      if (false === streamStarted) {
        // Start stream as soon as one bot is ready; lagging bots attach later.
        streamStarted = true;
        initInvestingCom(clientsById, marketDataAssets, guildId);
      }
    });
  }
}

function initInvestingCom(clientsById: Map<string, Client>, marketDataAssets: MarketDataAsset[], guildId: string) {
  // Generating multiple Websocket endpoint options in case we get blocked.
  // const wsServerIds = ["265", "68", "104", "226", "103", "220", "47"];
  const wsServerIds = ["714/crhl6wg7", "543/fkv260lc", "145/gdlsxdet", "034/7546_2ip", "145/_g8m6m_l", "560/q2_xpw87", "271/l5mgl1s6", "120/9hovf5kb", "303/0lllaqe7", "859/o3a31oc_"];

  const wsServerUrls: string[] = [];

  for (const wsServerId of wsServerIds) {
    wsServerUrls.push(`wss://streaming.forexpros.com/echo/${wsServerId}/websocket`);
  }

  let urlIndex = 0;

  // Round-robin assignment for Websocket endpoints
  const wsServerUrlProvider = () => wsServerUrls[urlIndex++ % wsServerUrls.length];

  let pids = "";

  // Building a list of "pids", aka. symbols that get requested for streaming real-time market data
  for (const marketDataAsset of marketDataAssets) {
    pids = `${pids}pid-${marketDataAsset.id}:%%`;
  }

  // Odd formatting required for Websocket service to start streaming
  const subscribeMessage = [`{"_event":"bulk-subscribe","tzID":8,"message":"${pids}${websocketSubscribeDomain}"}`];

  // Keep retrying with bounded backoff; endpoint provider rotates URLs.
  const options = {
    WebSocket: WS,
    connectionTimeout: 5000,
    maxRetries: Number.POSITIVE_INFINITY,
    minReconnectionDelay: 1000,
    maxReconnectionDelay: 15_000,
    reconnectionDelayGrowFactor: 1.5,
  };

  const wsClient = new ReconnectingWebSocket(wsServerUrlProvider, [], options);
  const memberByClientId = new Map<string, Promise<any>>();
  const statusByClientId = new Map<string, {nickname?: string; presence?: string;}>();
  let lastMessageAt = Date.now();
  let streamLive = false;

  const streamWatchdog = setInterval(() => {
    const messageAgeMs = Date.now() - lastMessageAt;
    if (true === streamLive && wsClient.OPEN === wsClient.readyState && messageAgeMs > streamStaleTimeoutMs) {
      logger.log(
        "warn",
        `No websocket payload for ${Math.floor(messageAgeMs / 1000)}s on ${wsClient.url}. Reconnecting...`,
      );
      wsClient.reconnect();
      lastMessageAt = Date.now();
    }
  }, streamWatchdogIntervalMs);
  (streamWatchdog as any).unref?.();

  // Respond to "connection open" event by sending subscription message
  wsClient.addEventListener("open", () => {
    logger.log(
      "info",
      `Subscribing to stream ${wsClient.url}...`,
    );
    wsClient.send(JSON.stringify(subscribeMessage));
  });

  wsClient.addEventListener("close", event => {
    logger.log(
      "warn",
      `Closing websocket connection at ${wsClient.url}: code=${event.code}, reason=${event.reason || "n/a"}`,
    );
    streamLive = false;
  });

  wsClient.addEventListener("error", event => {
    logger.log(
      "error",
      `Error at websocket connection ${wsClient.url}: ${JSON.stringify(event)}`,
    );
  });

  const handleWebsocketMessage = async event => {
    try {
      const rawMessage = normalizeEventData(event.data);
      if (null === rawMessage) {
        logger.log(
          "warn",
          "Ignoring websocket event with non-text payload.",
        );

        return;
      }

      lastMessageAt = Date.now();
      if ("o" === rawMessage) {
        // "o" message actually means a successful connection and streaming begins
        streamLive = true;
        logger.log(
          "info",
          "Websocket connection live.",
        );

        return;
      }

      const streamEvent = parseStreamEvent(rawMessage);
      if (null === streamEvent) {
        return;
      }

      const marketDataAsset = marketDataAssets.find(asset => asset.id === streamEvent.pid);
      if ("undefined" === typeof marketDataAsset) {
        return;
      }

      // Discord blocks updates more frequent than ~15s
      if (Math.floor((Date.now() / 1000) - marketDataAsset.lastUpdate) <= discordUpdateIntervalSeconds) {
        return;
      }

      const client = clientsById.get(marketDataAsset.botClientId);
      if ("undefined" === typeof client) {
        logger.log(
          "warn",
          `Market data update skipped because bot client ${marketDataAsset.botClientId} is not ready.`,
        );

        return;
      }

      // Always show configured decimals
      const lastPrice = streamEvent.lastNumeric.toFixed(marketDataAsset.decimals);
      let lastPriceChange = streamEvent.priceChange.toFixed(marketDataAsset.decimals);
      const lastPercentageChange = streamEvent.percentageChange.toFixed(2);

      // Setting trend and presence information
      let trend = "🟩";
      if (lastPriceChange.startsWith("-")) {
        trend = "🟥";
      } else {
        lastPriceChange = `+${lastPriceChange}`;
      }

      let presence = `${lastPriceChange} (${lastPercentageChange}%)`;

      // Add ticker sorting
      const name = `${marketDataAsset.order}${trend} ${lastPrice}${marketDataAsset.suffix}`;

      // Wisdom by yolohama:
      // % chg suggeriert dass die veränderung von 10 auf 15 (50%+) das selbe sind wie die veränderung von 100 auf 150. das ergibt aber nur bei einer stationären zeitreihe sinn. der vix ist nicht stationär. also quotiert man veränderungen in vol punkten
      if ("PTS" === marketDataAsset.unit) {
        presence = `${lastPriceChange}`;
      }

      // Updating nickname and presence status
      logger.log(
        "debug",
        `${marketDataAsset.botName} ${name} ${presence}`,
      );

      await applyClientStatusUpdate(
        client,
        guildId,
        memberByClientId,
        statusByClientId,
        name,
        presence,
      );
      marketDataAsset.lastUpdate = Date.now() / 1000;
      streamLive = true;
    } catch (error) {
      logger.log(
        "error",
        `Error updating market data bot status: ${error}`,
      );
    }
  };

  // Responding to Websocket message
  wsClient.addEventListener("message", event => {
    void handleWebsocketMessage(event);
  });
}

function normalizeEventData(rawData: unknown): string | null {
  if ("string" === typeof rawData) {
    return rawData;
  }

  if (Array.isArray(rawData) && rawData.every(chunk => Buffer.isBuffer(chunk))) {
    return Buffer.concat(rawData).toString("utf8");
  }

  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8");
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString("utf8");
  }

  if (ArrayBuffer.isView(rawData)) {
    return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString("utf8");
  }

  return null;
}

function parseStreamEvent(rawMessage: string): MarketStreamEvent | null {
  const frames = extractFrames(rawMessage);

  for (const frame of frames) {
    const streamEvent = parseEventCandidate(frame);
    if (null !== streamEvent) {
      return streamEvent;
    }
  }

  return null;
}

function parseEventCandidate(candidate: unknown, depth = 0): MarketStreamEvent | null {
  if (depth > 6) {
    return null;
  }

  if ("string" === typeof candidate) {
    const trimmedCandidate = candidate.trim();
    if (0 === trimmedCandidate.length) {
      return null;
    }

    const parsedJson = tryParseJson(trimmedCandidate);
    if (null !== parsedJson) {
      const jsonEvent = parseEventCandidate(parsedJson, depth + 1);
      if (null !== jsonEvent) {
        return jsonEvent;
      }
    }

    const unescapedCandidate = trimmedCandidate.replaceAll("\\\"", "\"");
    if (unescapedCandidate !== trimmedCandidate) {
      const unescapedEvent = parseEventCandidate(unescapedCandidate, depth + 1);
      if (null !== unescapedEvent) {
        return unescapedEvent;
      }
    }

    const embeddedJson = extractFirstJsonObject(trimmedCandidate);
    if (null !== embeddedJson && embeddedJson !== trimmedCandidate) {
      const embeddedJsonEvent = parseEventCandidate(embeddedJson, depth + 1);
      if (null !== embeddedJsonEvent) {
        return embeddedJsonEvent;
      }
    }

    for (const payloadFragment of extractPayloadFragments(trimmedCandidate)) {
      const payloadEvent = parseEventCandidate(payloadFragment, depth + 1);
      if (null !== payloadEvent) {
        return payloadEvent;
      }
    }

    return null;
  }

  if (Array.isArray(candidate)) {
    for (const nestedCandidate of candidate) {
      const nestedEvent = parseEventCandidate(nestedCandidate, depth + 1);
      if (null !== nestedEvent) {
        return nestedEvent;
      }
    }

    return null;
  }

  if (false === isPlainObject(candidate)) {
    return null;
  }

  const directEvent = getStreamEventFromObject(candidate);
  if (null !== directEvent) {
    return directEvent;
  }

  for (const nestedPayload of getNestedPayloads(candidate)) {
    const nestedEvent = parseEventCandidate(nestedPayload, depth + 1);
    if (null !== nestedEvent) {
      return nestedEvent;
    }
  }

  return null;
}

function tryParseJson(rawValue: string): unknown | null {
  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function extractPayloadFragments(frame: string): string[] {
  const payloadFragments: string[] = [];
  let nextSearchStartIndex = 0;

  while (nextSearchStartIndex < frame.length) {
    const delimiterIndex = frame.indexOf("::", nextSearchStartIndex);
    if (-1 === delimiterIndex) {
      break;
    }

    payloadFragments.push(frame.slice(delimiterIndex + 2));
    nextSearchStartIndex = delimiterIndex + 2;
  }

  return payloadFragments;
}

function extractFirstJsonObject(rawValue: string): string | null {
  const startIndex = rawValue.indexOf("{");
  if (-1 === startIndex) {
    return null;
  }

  let depth = 0;
  let escaped = false;
  let inString = false;

  for (let index = startIndex; index < rawValue.length; index++) {
    const currentCharacter = rawValue[index];

    if (true === escaped) {
      escaped = false;
      continue;
    }

    if ("\\" === currentCharacter) {
      escaped = true;
      continue;
    }

    if ("\"" === currentCharacter) {
      inString = !inString;
      continue;
    }

    if (true === inString) {
      continue;
    }

    if ("{" === currentCharacter) {
      depth++;
      continue;
    }

    if ("}" === currentCharacter) {
      depth--;
      if (0 === depth) {
        return rawValue.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function isPlainObject(candidate: unknown): candidate is Record<string, unknown> {
  return "object" === typeof candidate && null !== candidate && false === Array.isArray(candidate);
}

function getNestedPayloads(payload: Record<string, unknown>): unknown[] {
  const prioritizedKeys = new Set(["message", "data", "payload"]);
  const prioritizedNestedPayloads: unknown[] = [];
  const otherNestedPayloads: unknown[] = [];

  for (const [key, value] of Object.entries(payload)) {
    if ("string" !== typeof value && false === Array.isArray(value) && false === isPlainObject(value)) {
      continue;
    }

    if (prioritizedKeys.has(key)) {
      prioritizedNestedPayloads.push(value);
    } else {
      otherNestedPayloads.push(value);
    }
  }

  return [...prioritizedNestedPayloads, ...otherNestedPayloads];
}

function getStreamEventFromObject(eventData: Record<string, unknown>): MarketStreamEvent | null {
  const pid = getFirstFiniteNumber(eventData, ["pid"]);
  const lastNumeric = getFirstFiniteNumber(eventData, ["last_numeric", "last", "lastPrice", "last_price"]);
  const priceChange = getFirstFiniteNumber(eventData, ["pc", "chg", "change", "price_change"]);
  const percentageChange = getFirstFiniteNumber(eventData, ["pcp", "chg_perc", "change_percent", "percentage_change"]);

  if (false === [pid, lastNumeric, priceChange, percentageChange].every(Number.isFinite)) {
    return null;
  }

  return {
    pid,
    lastNumeric,
    priceChange,
    percentageChange,
  };
}

function getFirstFiniteNumber(
  eventData: Record<string, unknown>,
  fieldCandidates: string[]
): number {
  for (const fieldCandidate of fieldCandidates) {
    if (false === Object.prototype.hasOwnProperty.call(eventData, fieldCandidate)) {
      continue;
    }

    const numericValue = Number(eventData[fieldCandidate]);
    if (true === Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return Number.NaN;
}

function extractFrames(rawMessage: string): string[] {
  if (false === rawMessage.startsWith("a[")) {
    return [rawMessage];
  }

  try {
    const payload = JSON.parse(rawMessage);
    if (Array.isArray(payload)) {
      return payload.filter(frame => "string" === typeof frame);
    }
  } catch {
    // Fall through and allow caller to ignore payload.
  }

  return [rawMessage];
}

async function applyClientStatusUpdate(
  client: Client,
  guildId: string,
  memberByClientId: Map<string, Promise<any>>,
  statusByClientId: Map<string, {nickname?: string; presence?: string;}>,
  nickname: string,
  presence: string,
) {
  const state = statusByClientId.get(client.user.id) ?? {};

  if (state.nickname !== nickname) {
    try {
      let memberPromise = memberByClientId.get(client.user.id);
      if ("undefined" === typeof memberPromise) {
        const guild = client.guilds.cache.get(guildId);
        if ("undefined" === typeof guild) {
          throw new Error(`Guild ${guildId} not found in cache.`);
        }

        memberPromise = guild.members.fetch(client.user.id);
        memberByClientId.set(client.user.id, memberPromise);
      }

      const member = await memberPromise;
      await member.setNickname(nickname);
      state.nickname = nickname;
    } catch (error) {
      memberByClientId.delete(client.user.id);
      logger.log(
        "error",
        `Error updating market data bot nickname: ${error}`,
      );
    }
  }

  if (state.presence !== presence) {
    try {
      client.user.setPresence({activities: [{name: presence}]});
      state.presence = presence;
    } catch (error) {
      logger.log(
        "error",
        `Error updating market data bot presence: ${error}`,
      );
    }
  }

  statusByClientId.set(client.user.id, state);
}
