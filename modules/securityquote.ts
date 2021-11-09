import {Client, Intents} from "discord.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WS from "ws";
import {getAssets} from "./assets";

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
    pids = pids + "%%pid-" + securityQuoteAsset.id + ":";
  }

  const subscribe = "{\"_event\":\"bulk-subscribe\",\"tzID\":8,\"message\":\"" + pids + "}\"}";
  const wsServerIds = ["265", "68", "104", "226", "36", "103", "220", "47"];
  const wsServerId = wsServerIds[Math.floor(Math.random() * wsServerIds.length)];

  const wsClient = new ReconnectingWebSocket(`wss://stream${wsServerId}.forexpros.com/echo/271/2q3afamt/websocket`, [], options);
  wsClient.addEventListener("open", () => {
    console.log(`Subscribing to stream${wsServerId}.forexpros.com websocket...`);
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
              if (securityQuoteAsset.botName === client.user.username) {
                let trend: string = "📈";
                let change: string = eventData.pcp;
                if (eventData.pc.startsWith("-")) {
                  trend = "📉";
                }
                if ("PTS" === securityQuoteAsset.unit) {
                  change = eventData.pc;
                }
                const string = `${trend} ${eventData.last_numeric} (${change})`;
                console.log(client.user.username + " " + string);
                client.user.setPresence({activities: [{name: string}]});
                securityQuoteAsset.lastUpdate = Date.now() / 1000;
              }
            }
          }
        }
      }
    } else {
      console.log(event);
    }
  });
}

// TwelveData experiment
/*
function initTd(clients) {
  const tdApiKey = readSecret("twelvedata_apikey");
  const subscribeCall = {
    action: "subscribe",
    params: {
      symbols: "SPX,NDX",
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
    console.log(event);
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
*/

// Webull experiment
/*
function initWb(clients) {
  const conn = {
    header: {
      os: "web",
      osType: "windows",
      app: "desktop",
      hl: "en",
      did: "7v6101x1b6j7hnzu6k5191fxsg52d8lb",
      access_token: "dc_us1.17cfca08d18-110217bc75d541fd955023a61fa64b75",
    },
  };

  const conn2 = {
    tickerIds: [
      913420438,
    ],
    type: "102",
    flag: "1",
  };

  const client = new Paho.Client("wspush.webullbroker.com", Number(443), "/mqtt", "clientId");

  const opts = {
    useSSL: true,
    userName: "test",
    password: "test",
    onSuccess: onConnect,
    onFailure: onFailure,
  };

  client.onConnectionLost = onConnectionLost;
  client.onMessageArrived = onMessageArrived;
  client.onMessageDelivered = onMessageDelivered;

  client.connect(opts);

  function onConnect() {
    console.log("onConnect");
    client.subscribe(JSON.stringify(conn));
    //client.subscribe(JSON.stringify(conn2));
  }

  function onFailure(message) {
    console.log("onFailure"+message);
  }

  // called when the client loses its connection
  function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
      console.log("onConnectionLost:"+responseObject.errorMessage);
    }
  }

  // called when a message arrives
  function onMessageArrived(message) {
    console.log("onMessageArrived:" + message.payloadString);
  }

  // called when a message arrives
  function onMessageDelivered(message) {
    console.log("onMessageDelivered:" + message.payloadString);
  }
}
*/
