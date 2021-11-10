import winston from "winston";

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
      timestamp: true,
    },
    transports: [
      new winston.transports.Console({
        format: winston.format.json(),
      }),
    ],
  });

  return logger;
}
