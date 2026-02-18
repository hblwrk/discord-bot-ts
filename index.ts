/* eslint-disable import/extensions */
import {getLogger} from "./modules/logging.js";
import {readSecret} from "./modules/secrets.js";
import {startBot} from "./modules/startup-orchestrator.js";

const logger = getLogger();
console.log(`Started with loglevel: ${logger.level}`);
const configuredPort = Number.parseInt(readSecret("healthcheck_port").trim(), 10);
const healthcheckPort = Number.isNaN(configuredPort) ? 11312 : configuredPort;
console.log(`Healthcheck port: ${healthcheckPort}`);

void startBot({
  logger,
}).catch(error => {
  logger.log(
    "error",
    `Error starting up: ${error}`,
  );
  process.exit(1);
});
