/* eslint-disable import/extensions */
import {getLogger} from "./modules/logging.js";
import {startBot} from "./modules/startup-orchestrator.js";

const healthcheckPort = 11312;

const logger = getLogger();
console.log(`Started with loglevel: ${logger.level}`);
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
