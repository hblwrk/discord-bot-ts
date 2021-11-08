import {Client, Intents} from "discord.js";
import ReconnectingWebSocket from "reconnecting-websocket";
import WS from "ws";
global.WebSocket = require('ws');
import Paho from "paho-mqtt";
import {readSecret} from "./secrets";

export function updateSecurityQuotes() {
  const botBtcUsd = readSecret("discord_token_btcusd");
  const botEthUsd = readSecret("discord_token_ethusd");
  const botSpx = readSecret("discord_token_spx");
  const botNq = readSecret("discord_token_nq");
  const botRty = readSecret("discord_token_rty");
  const botVix = readSecret("discord_token_vix");
  const botDax = readSecret("discord_token_dax");

  const bots = [];
  bots.push(botBtcUsd);
  bots.push(botEthUsd);
  bots.push(botSpx);
  bots.push(botNq);
  bots.push(botRty);
  bots.push(botVix);
  bots.push(botDax);

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

  initIV(clients);
  //initWs(clients);
  //initWb(clients);
}

function initIV(clients) {
  const options = {
    WebSocket: WS,
    connectionTimeout: 1000,
    maxRetries: 10,
  };

  const conn1 = "{\"_event\":\"bulk-subscribe\",\"tzID\":8,\"message\":\"pid-8826:%%pid-8884:%%pid-1174944:%%pid-1175151:%%pid-1175153:%%pid-1057391:%%pid-1061443:\"}";
  // 1175153 = SPX
  // 1175151 = NQ
  // 1174944 = RTY
  // 8884 = VIX
  // 8826 = DAX
  // 1057391 = BTCUSD
  // 1061443 = ETHUSD

  const wsServerIds = ["265", "68", "104", "226", "36", "103", "220", "47"];
  const wsServerId = wsServerIds[Math.floor(Math.random() * wsServerIds.length)];

  const wsClient = new ReconnectingWebSocket(`wss://stream${wsServerId}.forexpros.com/echo/271/2q3afamt/websocket`, [], options);
  wsClient.addEventListener("open", () => {
    console.log(`Subscribing to stream${wsServerId}.forexpros.com websocket...`);
    wsClient.send(JSON.stringify(conn1));
  });

  wsClient.addEventListener("close", () => {
    console.log("Closing websocket connection...");
  });

  wsClient.addEventListener("error", (event) => {
    console.log("Error at websocket connection...");
    console.log(event);
  });

  let lastUpdateBtc = Date.now() / 1000;
  let lastUpdateEth = Date.now() / 1000;
  let lastUpdateSpx = Date.now() / 1000;
  let lastUpdateNq = Date.now() / 1000;
  let lastUpdateRty = Date.now() / 1000;
  let lastUpdateVix = Date.now() / 1000;
  let lastUpdateDax = Date.now() / 1000;
  wsClient.addEventListener("message", (event) => {
    const regex = /::(.*)/gm;
    const rawEventData = event.data.replaceAll("a[\"", "").replaceAll("\\", "").replaceAll("\"]", "").replaceAll("\"}", "");
    const m = rawEventData.match(regex);
    if (null !== m) {
      const eventData = JSON.parse(m[0].replace("::", ""));
      if ("1057391" === eventData.pid && null !== eventData.pc) { // Bitcoin
        if (Math.floor((Date.now() / 1000) - lastUpdateBtc) > 5) { // Discord blocks updates more frequent than ~5s
          for (const client of clients) {
            if ("Bitcoin/USD" === client.user.username) {
              const string = `📈 ${eventData.last_numeric} (${eventData.pc})`;
              console.log(client.user.username + " " + string);
              client.user.setPresence({activities: [{name: string}]});
              lastUpdateBtc = Date.now() / 1000;
            }
          }
        }
      } else if ("1061443" === eventData.pid && null !== eventData.pc) { // Ether
        if (Math.floor((Date.now() / 1000) - lastUpdateEth) > 5) {
          for (const client of clients) {
            if ("Ether/USD" === client.user.username) {
              const string = `📈 ${eventData.last_numeric} (${eventData.pc})`;
              console.log(client.user.username + " " + string);
              client.user.setPresence({activities: [{name: string}]});
              lastUpdateEth = Date.now() / 1000;
            }
          }
        }
      } else if ("1175153" === eventData.pid && null !== eventData.pc) { // SPX
        if (Math.floor((Date.now() / 1000) - lastUpdateSpx) > 5) {
          for (const client of clients) {
            if ("S&P500 Futures" === client.user.username) {
              const string = `📈 ${eventData.last_numeric} (${eventData.pc})`;
              console.log(client.user.username + " " + string);
              client.user.setPresence({activities: [{name: string}]});
              lastUpdateSpx = Date.now() / 1000;
            }
          }
        }
      } else if ("1175151" === eventData.pid && null !== eventData.pc) { // NQ
        if (Math.floor((Date.now() / 1000) - lastUpdateNq) > 5) {
          for (const client of clients) {
            if ("Nasdaq 100 Futures" === client.user.username) {
              const string = `📈 ${eventData.last_numeric} (${eventData.pc})`;
              console.log(client.user.username + " " + string);
              client.user.setPresence({activities: [{name: string}]});
              lastUpdateNq = Date.now() / 1000;
            }
          }
        }
      } else if ("1174944" === eventData.pid && null !== eventData.pc) { // RTY
        if (Math.floor((Date.now() / 1000) - lastUpdateRty) > 5) {
          for (const client of clients) {
            if ("Russel 2000 Futures" === client.user.username) {
              const string = `📈 ${eventData.last_numeric} (${eventData.pc})`;
              console.log(client.user.username + " " + string);
              client.user.setPresence({activities: [{name: string}]});
              lastUpdateRty = Date.now() / 1000;
            }
          }
        }
      } else if ("8884" === eventData.pid && null !== eventData.pc) { // VIX
        if (Math.floor((Date.now() / 1000) - lastUpdateVix) > 5) {
          for (const client of clients) {
            if ("VIX Futures" === client.user.username) {
              const string = `📈 ${eventData.last_numeric} (${eventData.pc})`;
              console.log(client.user.username + " " + string);
              client.user.setPresence({activities: [{name: string}]});
              lastUpdateVix = Date.now() / 1000;
            }
          }
        }
      } else if ("8826" === eventData.pid && null !== eventData.pc) { // DAX
        if (Math.floor((Date.now() / 1000) - lastUpdateDax) > 5) {
          for (const client of clients) {
            if ("DAX Futures" === client.user.username) {
              const string = `📈 ${eventData.last_numeric} (${eventData.pc})`;
              console.log(client.user.username + " " + string);
              client.user.setPresence({activities: [{name: string}]});
              lastUpdateDax = Date.now() / 1000;
            }
          }
        }
      } else {
        console.log(event);
      }
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
