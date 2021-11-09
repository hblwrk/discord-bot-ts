import {Client} from "discord.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WS from "ws";
import {getAssets} from "./assets";
import {readSecret} from "./secrets";

// Launching multiple bots and Websocket stream to display price information
// Bot nickname and presence status updates have acceptable rate-limits (~5s)
export async function updateSecurityQuotes() {
  const securityQuoteAssets = getAssets("securityquote");

  await securityQuoteAssets.then(securityQuoteAssets => {
    const clients = [];

    for (const securityQuoteAsset of securityQuoteAssets) {
      // Create a new client instance. Bots do not need any permissions
      const client = new Client({
        intents: [],
      });

      // Login to Discord
      client.login(securityQuoteAsset.botToken).catch(console.error);

      client.on("ready", () => {
        // Bot connection successful
        console.log(`Launched security quotes (${securityQuoteAsset.botName})`);

        // Setting bot presence status to a default value
        client.user.setPresence({activities: [{name: "Ready."}]});
        clients.push(client);
        if (securityQuoteAssets.length === clients.length) {
          // All bots are ready, launching Websocket connections
          initInvestingCom(clients, securityQuoteAssets);
        }
      });
    }
  });
}

function initInvestingCom(clients, securityQuoteAssets) {
  // Generating multiple Websocket endpoint options in case we get blocked.
  const wsServerIds = ["265", "68", "104", "226", "36", "103", "220", "47"];

  const wsServerUrls: string[] = [];

  for (const wsServerId of wsServerIds) {
    wsServerUrls.push(`wss://stream${wsServerId}.forexpros.com/echo/271/2q3afamt/websocket`);
  }

  let urlIndex = 0;

  // Round-robin assignment for Websocket endpoints
  const wsServerUrlProvider = () => wsServerUrls[urlIndex++ % wsServerUrls.length];

  let pids = "";

  // Building a list of "pids", aka. symbols that get requested for streaming real-time market data
  for (const securityQuoteAsset of securityQuoteAssets) {
    pids = `${pids}pid-${securityQuoteAsset.id}:%%`;
  }

  // Odd formatting required for Websocket service to start streaming
  const subscribeMessage = "{\"_event\":\"bulk-subscribe\",\"tzID\":8,\"message\":\"" + pids + "}\"}";

  // Allowing maximum retries and timeout, afterwards a new Websocket endpoint is used.
  const options = {
    WebSocket: WS,
    connectionTimeout: 1000,
    maxRetries: 10,
  };

  const wsClient = new ReconnectingWebSocket(wsServerUrlProvider, [], options);

  // Respond to "connection open" event by sending subscription message
  wsClient.addEventListener("open", () => {
    console.log(`Subscribing to stream ${wsClient.url}...`);
    wsClient.send(JSON.stringify(subscribeMessage));
  });

  // We retry anyway
  wsClient.addEventListener("close", () => {
    console.log("Closing websocket connection...");
  });

  // We retry anyway
  wsClient.addEventListener("error", () => {
    console.log("Error at websocket connection...");
  });

  // Responding to Websocket message
  wsClient.addEventListener("message", event => {
    // Transforming odd Websocket service response "format" to valid JSON
    const regex = /::(.*)/gm;

    const rawEventData = event.data.replaceAll("a[\"", "").replaceAll("\\", "").replaceAll("\"]", "").replaceAll("\"}", "");

    const m = rawEventData.match(regex);

    if (null !== m) {
      const eventData = JSON.parse(m[0].replace("::", ""));
      for (const securityQuoteAsset of securityQuoteAssets) {
        if (securityQuoteAsset.id === Number(eventData.pid) && Math.floor((Date.now() / 1000) - securityQuoteAsset.lastUpdate) > 5) { // Discord blocks updates more frequent than ~5s
          for (const client of clients) {
            if (securityQuoteAsset.botClientId === client.user.id) {
              // Setting trend and presence information
              let trend = "🟩";
              if (eventData.pc.startsWith("-")) {
                trend = "🟥";
              }

              // Always show two decimals
              const lastPrice = Number.parseFloat(eventData.last_numeric).toFixed(2);
              const lastPriceChange = Number.parseFloat(eventData.pc).toFixed(2);
              const lastPercentageChange = Number.parseFloat(eventData.pcp).toFixed(2);

              const name = `${trend} ${lastPrice}`;
              let presence = `${lastPriceChange} (${lastPercentageChange})`;

              if ("PTS" === securityQuoteAsset.unit) { // % chg suggeriert dass die veränderung von 10 auf 15 (50%+) das selbe sind wie die veränderung von 100 auf 150. das ergibt aber nur bei einer stationären zeitreihe sinn. der vix ist nicht stationär. also quotiert man veränderungen in vol punkten
                presence = `${eventData.pc}`;
              }

              // Updating nickname and presence status
              // console.log(`${securityQuoteAsset.botName} ${name} ${presence}`);
              client.guilds.cache.get(readSecret("discord_guildID")).members.fetch(client.user.id).then(member => {
                member.setNickname(name);
              });

              client.user.setPresence({activities: [{name: presence}]});

              securityQuoteAsset.lastUpdate = Date.now() / 1000;
            }
          }
        }
      }
    } else if ("o" === event.data) {
      // "o" message actually means a successful connection and streaming begins
      console.log("Websocket connection live.");
    } else {
      // Anything else should be a unexpected error
      console.log(event);
    }
  });
}
