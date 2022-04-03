import {Client, Intents} from "discord.js";
import {readSecret} from "./modules/secrets";
import {runHealthCheck} from "./modules/health-check";
import {startNyseTimers, startMncTimers, startOtherTimers} from "./modules/timers";
import {updateMarketData} from "./modules/market-data";
import {getLogger} from "./modules/logging";
import {defineSlashCommands, interactSlashCommands} from "./modules/slash-commands";
import {addInlineResponses} from "./modules/inline-response";
import {addTriggerResponses} from "./modules/trigger-response";
import {getGenericAssets, getAssets} from "./modules/assets";
import {roleManager} from "./modules/role-manager";
import {getTickers, Ticker} from "./modules/tickers";

const token = readSecret("discord_token");

const logger = getLogger();

// Create a new client instance
const client = new Client({
  intents: [
    Intents.FLAGS.GUILDS,
    Intents.FLAGS.GUILD_MESSAGES,
    Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
  ],
});

// Log one-time events, e.g. log-in
const eventReady = {
  name: "ready",
  once: true,
  execute() {
    logger.log(
      "info",
      "Logged in.",
    );
  },
};

client.once(eventReady.name, (...args) => {
  eventReady.execute.apply(null, ...args);
});

// Login to Discord
client.login(token).catch(error => {
  logger.log(
    "error",
    error,
  );
});

// Updating market data
if ("production" === readSecret("environment")) {
  updateMarketData().catch(error => {
    logger.log(
      "error",
      error,
    );
  });
}

logger.log(
  "info",
  "Caching assets...",
);

const assets = getGenericAssets();
assets.then(async assets => {
  logger.log(
    "info",
    `Loaded and cached ${assets.length} generic assets.`,
  );

  const tickers: Ticker[] = await getTickers("all");
  logger.log(
    "info",
    `Loaded and cached ${tickers.length} tickers.`,
  );

  // Set timers, e.g. for stock exchange open/close notifications
  startNyseTimers(client, readSecret("hblwrk_channel_NYSEAnnouncement_ID"));
  startMncTimers(client, readSecret("hblwrk_channel_MNCAnnouncement_ID"));
  startOtherTimers(client, readSecret("hblwrk_channel_OtherAnnouncement_ID"), assets, tickers);
  logger.log(
    "info",
    "Successfully set timers.",
  );

  const whatIsAssets = await getAssets("whatis");
  logger.log(
    "info",
    `Loaded and cached ${whatIsAssets.length} whatis assets.`,
  );

  const userAssets = await getAssets("user");
  logger.log(
    "info",
    `Loaded and cached ${userAssets.length} user assets.`,
  );

  const roleAssets = await getAssets("role");
  logger.log(
    "info",
    `Loaded and cached ${roleAssets.length} role assets.`,
  );

  const assetCommands = [];
  const assetCommandsWithPrefix = [];
  for (const asset of assets) {
    for (const trigger of asset.trigger) {
      assetCommands.push(trigger.replaceAll(" ", "_"));
      assetCommandsWithPrefix.push(`!${trigger}`);
    }
  }

  // Inline and trigger !commands
  addInlineResponses(client, assets, assetCommands);
  addTriggerResponses(client, assets, assetCommandsWithPrefix, whatIsAssets);

  // Slash-commands
  defineSlashCommands(assets, whatIsAssets, userAssets);
  interactSlashCommands(client, assets, assetCommands, whatIsAssets, tickers);

  // Role assignment
  await roleManager(client, roleAssets);

  runHealthCheck();
}).then(() => {
  logger.log(
    "info",
    "Bot ready.",
  );
}).catch(error => {
  logger.log(
    "error",
    error,
  );
});
