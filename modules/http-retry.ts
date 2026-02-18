import axios, {type AxiosRequestConfig, type AxiosResponse} from "axios";

type RetryOptions = {
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
};

const defaultTimeoutMs = 10_000;
const defaultMaxAttempts = 3;
const defaultRetryDelayMs = 500;

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

function getRequestConfig(config: AxiosRequestConfig | undefined, timeoutMs: number): AxiosRequestConfig {
  const newConfig = {
    ...(config ?? {}),
  };

  if (undefined === newConfig.timeout) {
    newConfig.timeout = timeoutMs;
  }

  return newConfig;
}

function wait(delayMs: number) {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs);
  });
}

export async function getWithRetry<T = any>(
  url: string,
  config?: AxiosRequestConfig,
  options?: RetryOptions,
): Promise<AxiosResponse<T>> {
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  const maxAttempts = options?.maxAttempts ?? defaultMaxAttempts;
  const retryDelayMs = options?.retryDelayMs ?? defaultRetryDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.get<T>(url, getRequestConfig(config, timeoutMs));
    } catch (error: unknown) {
      lastError = error;
      if (attempt === maxAttempts || false === shouldRetry(error)) {
        break;
      }

      await wait(attempt * retryDelayMs);
    }
  }

  throw lastError;
}

export async function postWithRetry<T = any>(
  url: string,
  data?: any,
  config?: AxiosRequestConfig,
  options?: RetryOptions,
): Promise<AxiosResponse<T>> {
  const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
  const maxAttempts = options?.maxAttempts ?? defaultMaxAttempts;
  const retryDelayMs = options?.retryDelayMs ?? defaultRetryDelayMs;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.post<T>(url, data, getRequestConfig(config, timeoutMs));
    } catch (error: unknown) {
      lastError = error;
      if (attempt === maxAttempts || false === shouldRetry(error)) {
        break;
      }

      await wait(attempt * retryDelayMs);
    }
  }

  throw lastError;
}
