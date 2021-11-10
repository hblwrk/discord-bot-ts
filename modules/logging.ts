import winston from "winston";

export function getLogger() {
  const level = {
    error: "0",
    warn: "1",
    info: "2",
    http: "3",
    verbose: "4",
    debug: "5",
    silly: "6",
  };

  const logger = winston.createLogger({
    level: "debug",
    format: winston.format.json(),
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
