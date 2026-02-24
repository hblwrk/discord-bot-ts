/* eslint-disable import/extensions */
import {getHealthcheckPort} from "./modules/health-check-config.js";
import {getLogger} from "./modules/logging.js";
import {startBot} from "./modules/startup-orchestrator.js";

type Logger = {
  log: (level: string, message: any) => void;
};

type ProcessWarning = Error & {
  code?: string;
  count?: number;
  emitter?: {
    constructor?: {
      name?: string;
    };
  };
  type?: string;
};

const warningLoggerSymbol = Symbol.for("hblwrk.discord-bot-ts.warning-logger");
const warningHandlerSymbol = Symbol.for("hblwrk.discord-bot-ts.warning-handler");

type ProcessWithWarningLogging = NodeJS.Process & {
  [warningLoggerSymbol]?: Logger;
  [warningHandlerSymbol]?: (warning: ProcessWarning) => void;
};

function installProcessWarningLogger(logger: Logger) {
  const processWithWarningLogging = process as ProcessWithWarningLogging;
  processWithWarningLogging[warningLoggerSymbol] = logger;

  if ("function" === typeof processWithWarningLogging[warningHandlerSymbol]) {
    return;
  }

  const warningHandler = (warning: ProcessWarning) => {
    processWithWarningLogging[warningLoggerSymbol]?.log(
      "warn",
      {
        source: "process-warning",
        warning_name: warning.name,
        warning_code: warning.code,
        warning_type: warning.type,
        warning_listener_count: warning.count,
        warning_emitter: warning.emitter?.constructor?.name,
        warning_message: warning.message,
        warning_stack: warning.stack,
      },
    );
  };

  processWithWarningLogging[warningHandlerSymbol] = warningHandler;
  process.on("warning", warningHandler);
}

const healthcheckPort = getHealthcheckPort();

const logger = getLogger();
installProcessWarningLogger(logger);
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
