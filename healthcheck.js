const healthcheckPort = process.env.HEALTHCHECK_PORT ?? "11312";
const healthcheckUrl = `http://127.0.0.1:${healthcheckPort}/api/v1/health`;

try {
  const response = await fetch(healthcheckUrl);
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
