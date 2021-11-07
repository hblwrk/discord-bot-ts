import {Client, Intents} from "discord.js";
import {client as WebSocketClient} from "websocket";
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

  var wsClient = new WebSocketClient();

  wsClient.on("connectFailed", function(error) {
    console.log(`Connect Error: ${error.toString()}`);
  });

  wsClient.on("connect", function(connection) {
    console.log("twelvedata WebSocket client connected");
    connection.on("error", function(error) {
      console.log(`Connection Error: ${error.toString()}`);
    });
    connection.on("close", function() {
      console.log("Connection closed");
    });
    connection.on("message", function(message) {
      if (message.type === "utf8") {
        const response = JSON.parse(message.utf8Data);
        if ("price" === response.event) {
          if ("BTC/USD" === response.symbol) {
            for (const client of clients) {
              if ("Bitcoin/USD" === client.user.username) {
                const string = `📈 ${response.price}`;
                client.user.setPresence({activities: [{name: string}]});
              }
            }
          } else if ("ETH/USD" === response.symbol) {
            for (const client of clients) {
              if ("Ether/USD" === client.user.username) {
                const string = `📈 ${response.price}`;
                client.user.setPresence({activities: [{name: string}]});
              }
            }
          }
        }
      }
    });

    function subscribe() {
      if (connection.connected) {
        connection.sendUTF(JSON.stringify(subscribeCall));
        setTimeout(subscribe, 1000);
      }
    }
    subscribe();
  });

  wsClient.connect(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${tdApiKey}`);
}
