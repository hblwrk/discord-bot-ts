import {Client} from "discord.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WS from "ws";
import {getAssets} from "./assets";
import {getLogger} from "./logging";
import {readSecret} from "./secrets";

const logger = getLogger();

// Launching multiple bots and Websocket stream to display price information
// Bot nickname and presence status updates have acceptable rate-limits (~5s)
export async function updateMarketData() {
  const marketDataAssets = getAssets("marketdata");

  await marketDataAssets.then(marketDataAssets => {
    const clients = [];

    for (const marketDataAsset of marketDataAssets) {
      // Create a new client instance. Bots do not need any permissions
      const client = new Client({
        intents: [],
      });

      // Login to Discord
      client.login(marketDataAsset.botToken).catch(error => {
        logger.log(
          "error",
          error,
        );
      });

      client.on("ready", () => {
        // Bot connection successful
        logger.log(
          "info",
          `Launched market data bot (${marketDataAsset.botName})`,
        );

        // Setting bot presence status to a default value
        client.user.setPresence({activities: [{name: "Market closed."}]});
        clients.push(client);
        if (marketDataAssets.length === clients.length) {
          // All bots are ready, launching Websocket connections
          initInvestingCom(clients, marketDataAssets);
        }
      });
    }
  });
}

function initInvestingCom(clients, marketDataAssets) {
  // Generating multiple Websocket endpoint options in case we get blocked.
  // const wsServerIds = ["265", "68", "104", "226", "103", "220", "47"];
  const wsServerIds = ["714/crhl6wg7", "543/fkv260lc", "145/gdlsxdet", "034/7546_2ip", "145/_g8m6m_l", "560/q2_xpw87", "271/l5mgl1s6", "120/9hovf5kb", "303/0lllaqe7", "859/o3a31oc_"]

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
  const subscribeMessage = ["{\"_event\":\"bulk-subscribe\",\"tzID\":8,\"message\":\"" + pids + "cmt-1-5-945629:%%domain-1:}\"}"];

  // Allowing maximum retries and timeout, afterwards a new Websocket endpoint is used.
  const options = {
    WebSocket: WS,
    connectionTimeout: 5000,
    maxRetries: 10,
    //debug: true,
  };

  const wsClient = new ReconnectingWebSocket(wsServerUrlProvider, [], options);

  // Respond to "connection open" event by sending subscription message
  wsClient.addEventListener("open", () => {
    logger.log(
      "info",
      `Subscribing to stream ${wsClient.url}...`,
    );
    wsClient.send(JSON.stringify(subscribeMessage));
  });

  // We retry anyway
  wsClient.addEventListener("close", () => {
    logger.log(
      "info",
      "Closing websocket connection...",
    );
  });

  // We retry anyway
  wsClient.addEventListener("error", () => {
    logger.log(
      "error",
      "Error at websocket connection...",
    );
  });

  // Responding to Websocket message
  wsClient.addEventListener("message", event => {
    // Transforming odd Websocket service response "format" to valid JSON
    const regex = /::(.*)/gm;

    const rawEventData = event.data.replaceAll("a[\"", "").replaceAll("\\", "").replaceAll("\"]", "").replaceAll("\"}", "");

    const m = rawEventData.match(regex);

    if (null !== m) {
      try {
        const eventData = JSON.parse(m[0].replace("::", ""));
        for (const marketDataAsset of marketDataAssets) {
          // Discord blocks updates more frequent than ~15s
          if (marketDataAsset.id === Number(eventData.pid) && Math.floor((Date.now() / 1000) - marketDataAsset.lastUpdate) > 15) {
            for (const client of clients) {
              if (marketDataAsset.botClientId === client.user.id) {
                // Always show two decimals
                const lastPrice = Number.parseFloat(eventData.last_numeric).toFixed(marketDataAsset.decimals);
                let lastPriceChange = Number.parseFloat(eventData.pc).toFixed(marketDataAsset.decimals);
                const lastPercentageChange = Number.parseFloat(eventData.pcp).toFixed(2);

                // Setting trend and presence information
                let trend = "🟩";
                if (lastPriceChange.startsWith("-")) {
                  trend = "🟥";
                } else {
                  lastPriceChange = "+" + lastPriceChange;
                }

                let presence = `${lastPriceChange} (${lastPercentageChange}%)`;

                // Add ticker sorting
                const name = `${marketDataAsset.order}${trend} ${lastPrice}`;

                // % chg suggeriert dass die veränderung von 10 auf 15 (50%+) das selbe sind wie die veränderung von 100 auf 150. das ergibt aber nur bei einer stationären zeitreihe sinn. der vix ist nicht stationär. also quotiert man veränderungen in vol punkten
                if ("PTS" === marketDataAsset.unit) {
                  presence = `${lastPriceChange}`;
                }

                // Updating nickname and presence status
                logger.log(
                  "debug",
                  `${marketDataAsset.botName} ${name} ${presence}`,
                );

                try {
                  client.guilds.cache.get(readSecret("discord_guildID")).members.fetch(client.user.id).then(member => {
                    member.setNickname(name);
                  });

                  client.user.setPresence({activities: [{name: presence}]});
                } catch (error: unknown) {
                  logger.log(
                    "error",
                    error,
                  );
                }

                marketDataAsset.lastUpdate = Date.now() / 1000;
              }
            }
          }
        }
      } catch (error) {
        logger.log(
          "error",
          error,
        );
      }
    } else if ("o" === event.data) {
      // "o" message actually means a successful connection and streaming begins
      logger.log(
        "info",
        "Websocket connection live.",
      );
    } else {
      // Anything else should be a unexpected error
      logger.log(
        "error",
        event,
      );
    }
  });
}
