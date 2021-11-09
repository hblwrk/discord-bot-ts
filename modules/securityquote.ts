import {Client, Intents} from "discord.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WS from "ws";
import {getAssets} from "./assets";
import {readSecret} from "./secrets";

export function updateSecurityQuotes() {
  const securityQuoteAssets = getAssets("securityquote");

  securityQuoteAssets.then(securityQuoteAssets => {
    const clients = [];
    for (const securityQuoteAsset of securityQuoteAssets) {
      // Create a new client instance
      const client = new Client({
        intents: [
          Intents.FLAGS.GUILDS,
        ],
      });

      // Login to Discord
      client.login(securityQuoteAsset.botToken).catch(console.error);
      client.on("ready", () => {
        // Updating security quotes
        const botName = client.user.username;
        console.log(`Launched security quotes (${botName})`);
        client.user.setPresence({activities: [{name: "Ready."}]});
        clients.push(client);
        if (securityQuoteAssets.length === clients.length) {
          initIV(clients, securityQuoteAssets);
        }
      });
    }
  });
}

function initIV(clients, securityQuoteAssets) {
  const options = {
    WebSocket: WS,
    connectionTimeout: 1000,
    maxRetries: 10,
  };

  let pids: string = "";
  for (const securityQuoteAsset of securityQuoteAssets) {
    pids = pids + "pid-" + securityQuoteAsset.id + ":%%";
  }

  // Generating multiple Websocket endpoint options in case we get blocked.
  const wsServerIds = ["265", "68", "104", "226", "36", "103", "220", "47"];

  let wsServerUrls: string[] = [];

  for (const wsServerId of wsServerIds) {
    wsServerUrls.push(`wss://stream${wsServerId}.forexpros.com/echo/271/2q3afamt/websocket`);
  }

  let urlIndex = 0;
  const wsServerUrlProvider = () => wsServerUrls[urlIndex++ % wsServerUrls.length];
  const subscribe = "{\"_event\":\"bulk-subscribe\",\"tzID\":8,\"message\":\"" + pids + "}\"}";
  const wsClient = new ReconnectingWebSocket(wsServerUrlProvider, [], options);

  wsClient.addEventListener("open", () => {
    console.log(`Subscribing to stream ${wsClient.url}...`);
    wsClient.send(JSON.stringify(subscribe));
  });

  wsClient.addEventListener("close", () => {
    console.log("Closing websocket connection...");
  });

  wsClient.addEventListener("error", (event) => {
    console.log("Error at websocket connection...");
  });

  wsClient.addEventListener("message", (event) => {
    const regex = /::(.*)/gm;
    const rawEventData = event.data.replaceAll("a[\"", "").replaceAll("\\", "").replaceAll("\"]", "").replaceAll("\"}", "");
    const m = rawEventData.match(regex);
    if (null !== m) {
      const eventData = JSON.parse(m[0].replace("::", ""));
      for (const securityQuoteAsset of securityQuoteAssets) {
        if (securityQuoteAsset.id === Number(eventData.pid)) {
          if (Math.floor((Date.now() / 1000) - securityQuoteAsset.lastUpdate) > 5) { // Discord blocks updates more frequent than ~5s
            for (const client of clients) {
              if (securityQuoteAsset.botClientId === client.user.id) {
                let trend: string = "🟩";
                if (eventData.pc.startsWith("-")) {
                  trend = "🟥";
                }
                const name = `${trend} ${eventData.last_numeric}`;
                let presence = `${eventData.pc} (${eventData.pcp})`;
                if ("PTS" === securityQuoteAsset.unit) { // % chg suggeriert dass die veränderung von 10 auf 15 (50%+) das selbe sind wie die veränderung von 100 auf 150. das ergibt aber nur bei einer stationären zeitreihe sinn. der vix ist nicht stationär. also quotiert man veränderungen in vol punkten
                  presence = `${eventData.pc}`;
                }
                console.log(securityQuoteAsset.botName + " " + name + " " + presence);
                client.guilds.cache.get(readSecret("discord_guildID")).members.fetch(client.user.id).then(member => {
                  member.setNickname(name);
                });
                client.user.setPresence({activities: [{name: presence}]});
                securityQuoteAsset.lastUpdate = Date.now() / 1000;
              }
            }
          }
        }
      }
    } else if ("o" === event.data) {
      console.log("Websocket connection live.");
    } else {
      console.log(event);
    }
  });
}
