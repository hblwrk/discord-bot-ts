import http from "node:http";
import express from "express";
import {readSecret} from "./secrets.js";
import {type StartupStateSnapshot} from "./startup-state.js";

function getHealthcheckPort(): number {
  try {
    const configuredPort = Number.parseInt(readSecret("healthcheck_port").trim(), 10);
    return Number.isNaN(configuredPort) ? 11312 : configuredPort;
  } catch {
    return 11312;
  }
}

export function runHealthCheck(getStartupState: () => StartupStateSnapshot) {
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
  const port = getHealthcheckPort();
  server.listen(port, "0.0.0.0");
  return server;
}
