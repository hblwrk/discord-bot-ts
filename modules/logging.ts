import winston from "winston";
import DiscordTransport from "./discord-logger";

export function getDiscordLogger(client) {
  const loglevel = {
    levels: {
      error: 0,
      warn: 1,
      info: 2,
      http: 3,
      verbose: 4,
      debug: 5,
      silly: 6,
    },
  };

  const logger = winston.createLogger({
    levels: loglevel.levels,
    level: "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    defaultMeta: {
      service: "user-service",
    },
    transports: [
      new DiscordTransport({
        format: winston.format.json(),
        client,
      }),
    ],
  });

  return logger;
}

export function getLogger() {
  const loglevel = {
    levels: {
      error: 0,
      warn: 1,
      info: 2,
      http: 3,
      verbose: 4,
      debug: 5,
      silly: 6,
    },
  };

  const logger = winston.createLogger({
    levels: loglevel.levels,
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    defaultMeta: {
      service: "user-service",
    },
    transports: [
      new winston.transports.Console({
        format: winston.format.json(),
      }),
    ],
  });

  return logger;
}
