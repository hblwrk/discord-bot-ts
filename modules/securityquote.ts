import {Client, Intents} from "discord.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WS from "ws";
import {readSecret} from "./secrets";

export function updateSecurityQuotes() {
  const botBtcUsd = readSecret("discord_token_btcusd");
  const botEthUsd = readSecret("discord_token_ethusd");

  const bots = [];
  bots.push(botBtcUsd);
  bots.push(botEthUsd);

  const clients = [];

  for (const bot of bots) {
    // Create a new client instance
    const client = new Client({
      intents: [
        Intents.FLAGS.GUILDS,
      ],
    });

    clients.push(client);

    // Login to Discord
    client.login(bot).catch(console.error);

    client.on("ready", () => {
      // Updating security quotes
      const botName = client.user.username;
      console.log(`Launched security quotes (${botName})`);
      client.user.setPresence({activities: [{name: "Ready."}]});
    });
  }

  initWs(clients);
}

function initWs(clients) {
  const tdApiKey = readSecret("twelvedata_apikey");
  const subscribeCall = {
    action: "subscribe",
    params: {
      symbols: "SPX,NDX,TFZ16,VIX,GDAXI,BTC/USD,ETH/USD",
    },
  };

  const options = {
    WebSocket: WS,
    connectionTimeout: 1000,
    maxRetries: 10,
  };

  var wsClient = new ReconnectingWebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${tdApiKey}`, [], options);

  wsClient.addEventListener("open", () => {
    console.log("Subscribing to twelvedata websocket...");
    wsClient.send(JSON.stringify(subscribeCall));
  });

  wsClient.addEventListener("close", () => {
    console.log("Closing websocket connection...");
  });

  wsClient.addEventListener("error", (event) => {
    console.log("Error at websocket connection...");
    console.log(event);
  });

  wsClient.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if ("price" === data.event) {
      if ("BTC/USD" === data.symbol) {
        for (const client of clients) {
          if ("Bitcoin/USD" === client.user.username) {
            const string = `📈 ${data.price}`;
            client.user.setPresence({activities: [{name: string}]});
          }
        }
      } else if ("ETH/USD" === data.symbol) {
        for (const client of clients) {
          if ("Ether/USD" === client.user.username) {
            const string = `📈 ${data.price}`;
            client.user.setPresence({activities: [{name: string}]});
          }
        }
      } else {
        console.log(event);
      }
    }
  });
}
