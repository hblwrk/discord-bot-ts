const defaultHealthcheckPort = 11312;
const maxPortNumber = 65535;

export function getHealthcheckPort(): number {
  const configuredPort = process.env.HEALTHCHECK_PORT;
  if ("undefined" === typeof configuredPort) {
    return defaultHealthcheckPort;
  }

  const parsedPort = Number.parseInt(configuredPort, 10);
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= maxPortNumber) {
    return parsedPort;
  }

  return defaultHealthcheckPort;
}
