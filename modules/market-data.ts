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
const maxLoggedPayloadLength = 500;

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

  const guildId = readSecret("discord_guild_ID").trim();
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
        if (true === isPotentialMarketDataPayload(rawMessage)) {
          logger.log(
            "warn",
            `Ignoring unparseable market data payload: ${getPayloadLogPreview(rawMessage)}`,
          );
        }

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

  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8");
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString("utf8");
  }

  return null;
}

function parseStreamEvent(rawMessage: string): MarketStreamEvent | null {
  const rawEventData = extractStreamEventPayload(rawMessage);
  if (null === rawEventData) {
    return null;
  }

  const pid = parseNumericValue(rawEventData.pid);
  const lastNumeric = parseNumericValue(rawEventData.last_numeric);
  const priceChange = parseNumericValue(rawEventData.pc);
  const percentageChange = parseNumericValue(rawEventData.pcp);

  if ([pid, lastNumeric, priceChange, percentageChange].every(Number.isFinite)) {
    return {
      pid,
      lastNumeric,
      priceChange,
      percentageChange,
    };
  }

  return null;
}

function isPotentialMarketDataPayload(rawMessage: string): boolean {
  const normalizedMessage = rawMessage.toLowerCase();

  return normalizedMessage.includes("pid-")
    || normalizedMessage.includes("last_numeric")
    || normalizedMessage.includes("\"pid\"")
    || normalizedMessage.includes("\\\"pid\\\"");
}

function getPayloadLogPreview(rawMessage: string): string {
  const normalizedWhitespace = rawMessage
    .replace(/\s+/g, " ")
    .trim();

  if (normalizedWhitespace.length <= maxLoggedPayloadLength) {
    return normalizedWhitespace;
  }

  return `${normalizedWhitespace.slice(0, maxLoggedPayloadLength)}...`;
}

function extractStreamEventPayload(rawMessage: string): Record<string, unknown> | null {
  const frameCandidates = unwrapSocketFrames(rawMessage);

  for (const frameCandidate of frameCandidates) {
    const payload = parsePayloadCandidate(frameCandidate, 0);
    if (null !== payload) {
      return payload;
    }
  }

  return null;
}

function unwrapSocketFrames(rawMessage: string): string[] {
  const trimmedMessage = rawMessage.trim();
  if (false === trimmedMessage.startsWith("a[")) {
    return [trimmedMessage];
  }

  try {
    const parsedFrames = JSON.parse(trimmedMessage.slice(1));
    if (Array.isArray(parsedFrames)) {
      return parsedFrames
        .map(frame => {
          if ("string" === typeof frame) {
            return frame.trim();
          }

          if ("object" === typeof frame && null !== frame) {
            return JSON.stringify(frame);
          }

          return null;
        })
        .filter((frame): frame is string => "string" === typeof frame && "" !== frame);
    }
  } catch {
    // Ignore malformed frame envelope and let parser continue with raw text.
  }

  return [trimmedMessage];
}

function parsePayloadCandidate(candidate: string, depth: number): Record<string, unknown> | null {
  if (depth > 6) {
    return null;
  }

  const trimmedCandidate = candidate.trim();
  if ("" === trimmedCandidate) {
    return null;
  }

  if (trimmedCandidate.startsWith("a[")) {
    const unwrappedFrames = unwrapSocketFrames(trimmedCandidate);
    for (const unwrappedFrame of unwrappedFrames) {
      if (unwrappedFrame !== trimmedCandidate) {
        const parsedUnwrappedFrame = parsePayloadCandidate(unwrappedFrame, depth + 1);
        if (null !== parsedUnwrappedFrame) {
          return parsedUnwrappedFrame;
        }
      }
    }
  }

  const parsedCandidate = tryParseJsonValue(trimmedCandidate);
  if (null !== parsedCandidate) {
    if ("string" === typeof parsedCandidate) {
      const parsedStringPayload = parsePayloadCandidate(parsedCandidate, depth + 1);
      if (null !== parsedStringPayload) {
        return parsedStringPayload;
      }
    } else if (Array.isArray(parsedCandidate)) {
      for (const frameCandidate of parsedCandidate) {
        if ("string" === typeof frameCandidate) {
          const parsedFrameCandidate = parsePayloadCandidate(frameCandidate, depth + 1);
          if (null !== parsedFrameCandidate) {
            return parsedFrameCandidate;
          }
        } else if ("object" === typeof frameCandidate && null !== frameCandidate) {
          const parsedFrameCandidate = parsePayloadCandidate(JSON.stringify(frameCandidate), depth + 1);
          if (null !== parsedFrameCandidate) {
            return parsedFrameCandidate;
          }
        }
      }
    } else {
      const parsedObjectCandidate = parsedCandidate as Record<string, unknown>;
      if ("string" === typeof parsedObjectCandidate.message) {
        const parsedMessage = parsePayloadCandidate(parsedObjectCandidate.message, depth + 1);
        if (null !== parsedMessage) {
          return parsedMessage;
        }
      }

      if (true === hasStreamEventFields(parsedObjectCandidate)) {
        return parsedObjectCandidate;
      }
    }
  }

  const delimiterPosition = trimmedCandidate.lastIndexOf("::");
  if (-1 !== delimiterPosition) {
    const parsedAfterDelimiter = parsePayloadCandidate(trimmedCandidate.slice(delimiterPosition + 2), depth + 1);
    if (null !== parsedAfterDelimiter) {
      return parsedAfterDelimiter;
    }
  }

  const extractedObject = extractJsonObject(trimmedCandidate);
  if (null !== extractedObject && extractedObject !== trimmedCandidate) {
    const extractedPayload = parsePayloadCandidate(extractedObject, depth + 1);
    if (null !== extractedPayload) {
      return extractedPayload;
    }
  }

  return null;
}

function tryParseJsonValue(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    // Ignore malformed payloads and let caller continue.
  }

  return null;
}

function hasStreamEventFields(candidate: Record<string, unknown>): boolean {
  return "pid" in candidate && "last_numeric" in candidate && "pc" in candidate && "pcp" in candidate;
}

function extractJsonObject(candidate: string): string | null {
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (-1 === firstBrace || -1 === lastBrace || lastBrace <= firstBrace) {
    return null;
  }

  return candidate.slice(firstBrace, lastBrace + 1);
}

function parseNumericValue(value: unknown): number {
  if ("number" === typeof value) {
    return Number.isFinite(value) ? value : Number.NaN;
  }

  if ("string" === typeof value) {
    const normalizedValue = value
      .replaceAll(",", "")
      .trim()
      .replace(/%$/, "");

    if ("" === normalizedValue) {
      return Number.NaN;
    }

    const parsedValue = Number(normalizedValue);
    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }

    const parsedFloat = Number.parseFloat(normalizedValue);
    if (Number.isFinite(parsedFloat)) {
      return parsedFloat;
    }
  }

  return Number.NaN;
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
