import http from "node:http";
import express from "express";
import {getHealthcheckPort} from "./health-check-config.js";
import {getLogger} from "./logging.js";
import {type StartupStateSnapshot} from "./startup-state.js";

type HealthcheckLogger = {
  log: (level: string, message: any) => void;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    return "string" === typeof errorCode ? errorCode : "UNKNOWN";
  }

  return "UNKNOWN";
}

export function runHealthCheck(
  getStartupState: () => StartupStateSnapshot,
  logger: HealthcheckLogger = getLogger(),
) {
  const app = express();
  const router = express.Router();

  router.use((_request, response, next) => {
    response.header("Access-Control-Allow-Methods", "GET");
    next();
  });

  router.get("/health", (_request, response) => {
    response.status(200).send("stonks");
  });

  router.get("/ready", (_request, response) => {
    const startupState = getStartupState();
    if (true === startupState.ready) {
      response.status(200).json({
        ready: true,
        discordLoggedIn: startupState.discordLoggedIn,
        handlersAttached: startupState.handlersAttached,
      });
      return;
    }

    response.status(503).json({
      ready: false,
      discordLoggedIn: startupState.discordLoggedIn,
      handlersAttached: startupState.handlersAttached,
    });
  });

  router.get("/startup", (_request, response) => {
    response.status(200).json(getStartupState());
  });

  app.use("/api/v1", router);

  const server = http.createServer(app);
  const healthcheckPort = getHealthcheckPort();

  server.on("error", (error: unknown) => {
    logger.log(
      "error",
      {
        startup_phase: "health",
        bind_host: "127.0.0.1",
        bind_port: healthcheckPort,
        error_code: toErrorCode(error),
        error_message: toErrorMessage(error),
        message: "Health-check server failed to bind.",
      },
    );
  });

  server.listen(healthcheckPort, "127.0.0.1");
  return server;
}
