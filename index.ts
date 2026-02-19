/* eslint-disable import/extensions */
import {getHealthcheckPort} from "./modules/health-check-config.js";
import {getLogger} from "./modules/logging.js";
import {startBot} from "./modules/startup-orchestrator.js";

const healthcheckPort = getHealthcheckPort();

const logger = getLogger();
logger.log("info", `Started with loglevel: ${logger.level}`);
logger.log("info", `Healthcheck port: ${healthcheckPort}`);

void startBot({
  logger,
}).catch(error => {
  logger.log(
    "error",
    `Error starting up: ${error}`,
  );
  process.exit(1);
});
