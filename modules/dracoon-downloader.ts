import axios from "axios";

const retryDelayMs = 500;
const maxAttempts = 3;

function shouldRetry(error: unknown): boolean {
  if (false === axios.isAxiosError(error)) {
    return false;
  }

  const statusCode = error.response?.status;
  if (undefined === statusCode) {
    return true;
  }

  return statusCode >= 500 || 429 === statusCode;
}

export async function getFromDracoon(secret: string, downloadToken: string) {
  const data = JSON.stringify({
    password: secret,
  });

  const config = {
    headers: {
      "Content-Type": "application/json",
    },
    timeout: 10_000,
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const urlResponse = await axios.post(`https://dracoon.team/api/v4/public/shares/downloads/${downloadToken}`, data, config);
      const getResponse = await axios.get(urlResponse.data.downloadUrl, {
        responseType: "arraybuffer",
        timeout: 10_000,
      });

      const dataResponse = Buffer.from(getResponse.data, "binary");
      return dataResponse;
    } catch (error: unknown) {
      lastError = error;
      if (attempt === maxAttempts || false === shouldRetry(error)) {
        break;
      }

      await new Promise(resolve => {
        setTimeout(resolve, attempt * retryDelayMs);
      });
    }
  }

  throw lastError;
}
