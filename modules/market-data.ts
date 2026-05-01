import {Client, type GuildMember} from "discord.js";
import ReconnectingWebSocketModule from "reconnecting-websocket";
import WS from "ws";
import {getAssets} from "./assets.ts";
import {getMarketDataClientCacheFactory} from "./discord-client-options.ts";
import {getLogger} from "./logging.ts";
import {readSecret} from "./secrets.ts";
import {
  getClosedMarketNickname,
  getMarketPresenceData,
  isMarketOpen,
  marketClosedPresence,
} from "./market-data-hours.ts";
import {
  getPayloadLogPreview,
  isPotentialMarketDataPayload,
  normalizeEventData,
  parseStreamEvent,
} from "./market-data-stream.ts";
import {
  type AppliedMarketDataUpdateLog,
  type ClientStatusState,
  type DiscordPresenceStatus,
  type IncomingMarketDataUpdateLog,
  type MarketDataAsset,
  type PendingClientStatusUpdate,
} from "./market-data-types.ts";

const logger = getLogger();
const websocketSubscribeDomain = "cmt-1-5-945629:%%domain-1:}";
const discordUpdateIntervalSeconds = 15;
const discordUpdateIntervalMs = discordUpdateIntervalSeconds * 1000;
const pendingStatusFlushIntervalMs = 1000;
const marketStatusCheckIntervalMs = 60_000;
const streamWatchdogIntervalMs = 30_000;
const streamStaleTimeoutMs = 300_000;

type ReconnectingWebSocketInstance = {
  OPEN: number;
  addEventListener: (type: "open" | "close" | "error" | "message", listener: (event: {
    code?: number;
    data?: unknown;
    reason?: string;
  }) => void) => void;
  readyState: number;
  reconnect: () => void;
  send: (data: string) => void;
  url: string;
};
type ReconnectingWebSocketConstructor = new (
  urlProvider: string | (() => string),
  protocols?: string | string[],
  options?: Record<string, unknown>
) => ReconnectingWebSocketInstance;
const ReconnectingWebSocket = ReconnectingWebSocketModule as unknown as ReconnectingWebSocketConstructor;

// Launching multiple bots and websocket stream to display price information.
// Discord-facing updates stay throttled, but the latest parsed tick is retained and flushed when due.
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
  const clientsById = new Map<string, Client<true>>();
  let streamStarted = false;

  for (const marketDataAsset of marketDataAssets) {
    // Create a new client instance. Bots do not need any permissions
    const makeCache = getMarketDataClientCacheFactory();
    const client = new Client({
      intents: [],
      ...(makeCache ? {makeCache} : {}),
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

      // Stay idle until a live tick arrives; the status reconciler flips closed sessions back later.
      const readyClient = client as Client<true>;
      readyClient.user.setPresence({
        activities: [{name: marketClosedPresence}],
        status: "idle",
      });
      clientsById.set(marketDataAsset.botClientId, readyClient);

      if (false === streamStarted) {
        // Start stream as soon as one bot is ready; lagging bots attach later.
        streamStarted = true;
        initInvestingCom(clientsById, marketDataAssets, guildId);
      }
    });
  }
}

function initInvestingCom(clientsById: Map<string, Client<true>>, marketDataAssets: MarketDataAsset[], guildId: string) {
  // Generating multiple Websocket endpoint options in case we get blocked.
  // const wsServerIds = ["265", "68", "104", "226", "103", "220", "47"];
  const wsServerIds = ["714/crhl6wg7", "543/fkv260lc", "145/gdlsxdet", "034/7546_2ip", "145/_g8m6m_l", "560/q2_xpw87", "271/l5mgl1s6", "120/9hovf5kb", "303/0lllaqe7", "859/o3a31oc_"];

  const wsServerUrls: string[] = [];

  for (const wsServerId of wsServerIds) {
    wsServerUrls.push(`wss://streaming.forexpros.com/echo/${wsServerId}/websocket`);
  }

  let urlIndex = 0;

  // Round-robin assignment for Websocket endpoints
  const wsServerUrlProvider = () => wsServerUrls[urlIndex++ % wsServerUrls.length] ?? wsServerUrls[0] ?? "";

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
  const memberByClientId = new Map<string, Promise<GuildMember>>();
  const statusByClientId = new Map<string, ClientStatusState>();
  const pendingStatusByClientId = new Map<string, PendingClientStatusUpdate>();
  let lastMessageAt = Date.now();
  let streamLive = false;

  const pendingStatusFlushTimer = setInterval(() => {
    for (const clientId of pendingStatusByClientId.keys()) {
      void flushPendingClientStatusUpdate(
        clientId,
        clientsById,
        guildId,
        memberByClientId,
        statusByClientId,
        pendingStatusByClientId,
      );
    }
  }, pendingStatusFlushIntervalMs);
  pendingStatusFlushTimer.unref();

  const marketStatusCheckTimer = setInterval(() => {
    for (const marketDataAsset of marketDataAssets) {
      const client = clientsById.get(marketDataAsset.botClientId);
      if ("undefined" === typeof client) {
        continue;
      }

      void applyClosedMarketPresenceIfNeeded(
        client,
        marketDataAsset,
        guildId,
        memberByClientId,
        statusByClientId,
      );
    }
  }, marketStatusCheckIntervalMs);
  marketStatusCheckTimer.unref();

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
  streamWatchdog.unref();

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

  const handleWebsocketMessage = async (event: {data?: unknown}) => {
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

      const client = clientsById.get(marketDataAsset.botClientId);
      logIncomingMarketDataUpdate({
        marketDataAsset,
        botReady: "undefined" !== typeof client,
        nickname: name,
        presence,
        lastNumeric: streamEvent.lastNumeric,
        priceChange: streamEvent.priceChange,
        percentageChange: streamEvent.percentageChange,
      });

      if ("undefined" === typeof client) {
        logger.log(
          "warn",
          `Market data update skipped because bot client ${marketDataAsset.botClientId} is not ready.`,
        );

        return;
      }

      queuePendingClientStatusUpdate(
        client,
        clientsById,
        marketDataAsset,
        name,
        presence,
        streamEvent.lastNumeric,
        streamEvent.priceChange,
        streamEvent.percentageChange,
        guildId,
        memberByClientId,
        statusByClientId,
        pendingStatusByClientId,
      );
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

async function applyClientStatusUpdate(
  client: Client<true>,
  guildId: string,
  memberByClientId: Map<string, Promise<GuildMember>>,
  statusByClientId: Map<string, ClientStatusState>,
  nickname: string,
  presence: string,
  presenceStatus: DiscordPresenceStatus,
) {
  const didPresenceUpdate = applyClientPresenceUpdate(
    client,
    statusByClientId,
    presence,
    presenceStatus,
  );

  const didNicknameUpdate = await applyClientNicknameUpdate(
    client,
    guildId,
    memberByClientId,
    statusByClientId,
    nickname,
  );

  return didPresenceUpdate || didNicknameUpdate;
}

async function applyClientNicknameUpdate(
  client: Client<true>,
  guildId: string,
  memberByClientId: Map<string, Promise<GuildMember>>,
  statusByClientId: Map<string, ClientStatusState>,
  nickname: string,
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
      statusByClientId.set(client.user.id, state);
      return true;
    } catch (error) {
      memberByClientId.delete(client.user.id);
      logger.log(
        "error",
        `Error updating market data bot nickname: ${error}`,
      );
    }
  }

  statusByClientId.set(client.user.id, state);
  return false;
}

function queuePendingClientStatusUpdate(
  client: Client<true>,
  clientsById: Map<string, Client<true>>,
  marketDataAsset: MarketDataAsset,
  nickname: string,
  openPresence: string,
  lastNumeric: number,
  priceChange: number,
  percentageChange: number,
  guildId: string,
  memberByClientId: Map<string, Promise<GuildMember>>,
  statusByClientId: Map<string, ClientStatusState>,
  pendingStatusByClientId: Map<string, PendingClientStatusUpdate>,
) {
  const pendingStatusUpdate = pendingStatusByClientId.get(client.user.id);

  if ("undefined" === typeof pendingStatusUpdate) {
    pendingStatusByClientId.set(client.user.id, {
      marketDataAsset,
      nickname,
      openPresence,
      lastNumeric,
      priceChange,
      percentageChange,
      applying: false,
    });
  } else {
    pendingStatusUpdate.marketDataAsset = marketDataAsset;
    pendingStatusUpdate.nickname = nickname;
    pendingStatusUpdate.openPresence = openPresence;
    pendingStatusUpdate.lastNumeric = lastNumeric;
    pendingStatusUpdate.priceChange = priceChange;
    pendingStatusUpdate.percentageChange = percentageChange;
  }

  void flushPendingClientStatusUpdate(
    client.user.id,
    clientsById,
    guildId,
    memberByClientId,
    statusByClientId,
    pendingStatusByClientId,
  );
}

async function flushPendingClientStatusUpdate(
  clientId: string,
  clientsById: Map<string, Client<true>>,
  guildId: string,
  memberByClientId: Map<string, Promise<GuildMember>>,
  statusByClientId: Map<string, ClientStatusState>,
  pendingStatusByClientId: Map<string, PendingClientStatusUpdate>,
) {
  const pendingStatusUpdate = pendingStatusByClientId.get(clientId);
  if ("undefined" === typeof pendingStatusUpdate || true === pendingStatusUpdate.applying) {
    return;
  }

  if (false === isDiscordUpdateDue(pendingStatusUpdate.marketDataAsset.lastUpdate)) {
    return;
  }

  const client = clientsById.get(pendingStatusUpdate.marketDataAsset.botClientId);
  if ("undefined" === typeof client) {
    logger.log(
      "warn",
      `Pending market data update skipped because bot client ${pendingStatusUpdate.marketDataAsset.botClientId} is not ready.`,
    );

    return;
  }

  pendingStatusUpdate.applying = true;
  const {nickname, openPresence, lastNumeric, priceChange, percentageChange} = pendingStatusUpdate;
  const marketPresenceData = getMarketPresenceData(
    pendingStatusUpdate.marketDataAsset,
    nickname,
    openPresence,
    priceChange,
  );
  let didApply = false;
  let shouldFlushNextPendingUpdate = true;

  try {
    const didUpdate = await applyClientStatusUpdate(
      client,
      guildId,
      memberByClientId,
      statusByClientId,
      marketPresenceData.nickname,
      marketPresenceData.presence,
      marketPresenceData.presenceStatus,
    );
    pendingStatusUpdate.marketDataAsset.lastUpdate = Date.now() / 1000;

    if (true === didUpdate) {
      logAppliedMarketDataUpdate({
        source: "stream-flush",
        marketDataAsset: pendingStatusUpdate.marketDataAsset,
        nickname: marketPresenceData.nickname,
        presence: marketPresenceData.presence,
        presenceStatus: marketPresenceData.presenceStatus,
        lastNumeric,
        priceChange,
        percentageChange,
      });
    }

    didApply = true;
  } catch (error) {
    logger.log(
      "error",
      `Error updating market data bot status: ${error}`,
    );
  } finally {
    const latestPendingStatusUpdate = pendingStatusByClientId.get(clientId);
    if ("undefined" === typeof latestPendingStatusUpdate) {
      shouldFlushNextPendingUpdate = false;
    } else {
      latestPendingStatusUpdate.applying = false;

      if (
        true === didApply
        && latestPendingStatusUpdate.nickname === nickname
        && latestPendingStatusUpdate.openPresence === openPresence
        && latestPendingStatusUpdate.priceChange === priceChange
      ) {
        pendingStatusByClientId.delete(clientId);
        shouldFlushNextPendingUpdate = false;
      }
    }
  }

  if (false === shouldFlushNextPendingUpdate) {
    return;
  }

  void flushPendingClientStatusUpdate(
    clientId,
    clientsById,
    guildId,
    memberByClientId,
    statusByClientId,
    pendingStatusByClientId,
  );
}

function isDiscordUpdateDue(lastUpdate: number): boolean {
  return (Date.now() - (lastUpdate * 1000)) >= discordUpdateIntervalMs;
}

async function applyClosedMarketPresenceIfNeeded(
  client: Client<true>,
  marketDataAsset: MarketDataAsset,
  guildId: string,
  memberByClientId: Map<string, Promise<GuildMember>>,
  statusByClientId: Map<string, ClientStatusState>,
) {
  if (true === isMarketOpen(marketDataAsset)) {
    return;
  }

  const didPresenceUpdate = applyClientPresenceUpdate(
    client,
    statusByClientId,
    marketClosedPresence,
    "idle",
  );

  const state = statusByClientId.get(client.user.id) ?? {};
  const closedMarketNickname = getClosedMarketNickname(
    marketDataAsset,
    state.nickname,
  );
  const didNicknameUpdate = null === closedMarketNickname
    ? false
    : await applyClientNicknameUpdate(
      client,
      guildId,
      memberByClientId,
      statusByClientId,
      closedMarketNickname,
    );

  if (false === didPresenceUpdate && false === didNicknameUpdate) {
    return;
  }

  logAppliedMarketDataUpdate({
    source: "market-close-reconciler",
    marketDataAsset,
    nickname: closedMarketNickname ?? state.nickname ?? null,
    presence: marketClosedPresence,
    presenceStatus: "idle",
  });
}

function applyClientPresenceUpdate(
  client: Client<true>,
  statusByClientId: Map<string, ClientStatusState>,
  presence: string,
  presenceStatus: DiscordPresenceStatus,
) {
  const state = statusByClientId.get(client.user.id) ?? {};

  if (state.presence === presence && state.presenceStatus === presenceStatus) {
    statusByClientId.set(client.user.id, state);
    return false;
  }

  try {
    client.user.setPresence({
      activities: [{name: presence}],
      status: presenceStatus,
    });
    state.presence = presence;
    state.presenceStatus = presenceStatus;
    statusByClientId.set(client.user.id, state);
    return true;
  } catch (error) {
    logger.log(
      "error",
      `Error updating market data bot presence: ${error}`,
    );
  }

  statusByClientId.set(client.user.id, state);
  return false;
}

function logAppliedMarketDataUpdate(logData: AppliedMarketDataUpdateLog) {
  logger.log("debug", {
    message: "market-data:update-applied",
    source: logData.source,
    asset_name: logData.marketDataAsset.name,
    bot_name: logData.marketDataAsset.botName,
    bot_client_id: logData.marketDataAsset.botClientId,
    market_data_pid: logData.marketDataAsset.id,
    market_hours: logData.marketDataAsset.marketHours ?? "us_futures",
    nickname: logData.nickname,
    presence: logData.presence,
    presence_status: logData.presenceStatus,
    last_numeric: logData.lastNumeric,
    price_change: logData.priceChange,
    percentage_change: logData.percentageChange,
    unit: logData.marketDataAsset.unit,
    suffix: logData.marketDataAsset.suffix,
  });
}

function logIncomingMarketDataUpdate(logData: IncomingMarketDataUpdateLog) {
  logger.log("debug", {
    message: "market-data:stream-received",
    asset_name: logData.marketDataAsset.name,
    bot_name: logData.marketDataAsset.botName,
    bot_client_id: logData.marketDataAsset.botClientId,
    market_data_pid: logData.marketDataAsset.id,
    market_hours: logData.marketDataAsset.marketHours ?? "us_futures",
    bot_ready: logData.botReady,
    nickname: logData.nickname,
    presence: logData.presence,
    last_numeric: logData.lastNumeric,
    price_change: logData.priceChange,
    percentage_change: logData.percentageChange,
    unit: logData.marketDataAsset.unit,
    suffix: logData.marketDataAsset.suffix,
  });
}
