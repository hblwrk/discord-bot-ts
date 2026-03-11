import winston from "winston";
import DiscordTransport from "./discord-logger.js";
import {readSecret} from "./secrets.js";

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
};
const discordLoggerByClient = new WeakMap<object, winston.Logger>();

function getConfiguredLogLevel(): string {
  const loglevelFromEnvironment = process.env.LOGLEVEL?.trim().toLowerCase();
  if (loglevelFromEnvironment in levels) {
    return loglevelFromEnvironment;
  }

  try {
    const configuredLogLevel = readSecret("loglevel").trim().toLowerCase();
    if (configuredLogLevel in levels) {
      return configuredLogLevel;
    }
  } catch {
    // Fall back to default when optional config/secret is missing.
  }

  return "info";
}

export function getDiscordLogger(client) {
  if ("object" === typeof client && null !== client) {
    const cachedLogger = discordLoggerByClient.get(client);
    if (cachedLogger) {
      return cachedLogger;
    }
  }

  const logger = winston.createLogger({
    levels,
    level: getConfiguredLogLevel(),
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

  if ("object" === typeof client && null !== client) {
    discordLoggerByClient.set(client, logger);
  }

  return logger;
}

export function getLogger() {
  const logger = winston.createLogger({
    levels,
    level: getConfiguredLogLevel(),
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
