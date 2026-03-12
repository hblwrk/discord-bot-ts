function toFinitePositiveNumber(rawValue: unknown): number | undefined {
  const parsedValue = "number" === typeof rawValue
    ? rawValue
    : "string" === typeof rawValue && "" !== rawValue.trim()
      ? Number(rawValue)
      : Number.NaN;

  if (false === Number.isFinite(parsedValue) || parsedValue <= 0) {
    return undefined;
  }

  return parsedValue;
}

function getHeaderValue(headers: unknown, headerName: string): string | undefined {
  if ("object" !== typeof headers || null === headers) {
    return undefined;
  }

  const normalizedHeaderName = headerName.toLowerCase();
  const headerBag = headers as {
    get?: (headerName: string) => unknown;
  } & Record<string, unknown>;

  if ("function" === typeof headerBag.get) {
    const headerValue = normalizeHeaderValue(
      headerBag.get(headerName) ?? headerBag.get(normalizedHeaderName),
    );
    if (undefined !== headerValue) {
      return headerValue;
    }
  }

  for (const [candidateHeaderName, candidateHeaderValue] of Object.entries(headerBag)) {
    if (candidateHeaderName.toLowerCase() === normalizedHeaderName) {
      return normalizeHeaderValue(candidateHeaderValue);
    }
  }

  return undefined;
}

function normalizeHeaderValue(rawValue: unknown): string | undefined {
  if (Array.isArray(rawValue)) {
    return normalizeHeaderValue(rawValue[0]);
  }

  if ("string" === typeof rawValue && "" !== rawValue.trim()) {
    return rawValue.trim();
  }

  if ("number" === typeof rawValue && Number.isFinite(rawValue)) {
    return String(rawValue);
  }

  return undefined;
}

export function toDiscordTimerMs(rawDelay: unknown): number | undefined {
  const parsedDelay = toFinitePositiveNumber(rawDelay);
  if (undefined === parsedDelay) {
    return undefined;
  }

  return Math.ceil(parsedDelay);
}

export function toDiscordRetryAfterFieldMs(rawRetryAfter: unknown): number | undefined {
  const parsedRetryAfter = toFinitePositiveNumber(rawRetryAfter);
  if (undefined === parsedRetryAfter) {
    return undefined;
  }

  return Math.ceil(parsedRetryAfter * 1_000);
}

export function toDiscordRetryAfterHeaderMs(rawRetryAfterHeader: unknown, nowMs: number = Date.now()): number | undefined {
  const normalizedRetryAfterHeader = normalizeHeaderValue(rawRetryAfterHeader);
  if (undefined === normalizedRetryAfterHeader) {
    return undefined;
  }

  const retryAfterSeconds = toFinitePositiveNumber(normalizedRetryAfterHeader);
  if (undefined !== retryAfterSeconds) {
    return Math.ceil(retryAfterSeconds * 1_000);
  }

  const retryAfterDateMs = Date.parse(normalizedRetryAfterHeader);
  if (true === Number.isNaN(retryAfterDateMs)) {
    return undefined;
  }

  const delayMs = retryAfterDateMs - nowMs;
  if (delayMs <= 0) {
    return undefined;
  }

  return Math.ceil(delayMs);
}

export function getDiscordRetryAfterHeaderMs(headers: unknown, nowMs: number = Date.now()): number | undefined {
  return toDiscordRetryAfterHeaderMs(getHeaderValue(headers, "retry-after"), nowMs);
}

export function getDiscordRateLimitRetryAfterMs(error: unknown, nowMs: number = Date.now()): number | undefined {
  if (false === (error instanceof Error)) {
    return undefined;
  }

  const unknownError = error as Error & {
    retryAfterMs?: unknown;
    retryAfter?: unknown;
    retry_after?: unknown;
    rawError?: {
      retryAfter?: unknown;
      retry_after?: unknown;
    };
    headers?: unknown;
    response?: {
      headers?: unknown;
    };
  };

  return toDiscordTimerMs(unknownError.retryAfterMs)
    ?? toDiscordTimerMs(unknownError.retryAfter)
    ?? toDiscordRetryAfterFieldMs(unknownError.retry_after)
    ?? toDiscordTimerMs(unknownError.rawError?.retryAfter)
    ?? toDiscordRetryAfterFieldMs(unknownError.rawError?.retry_after)
    ?? getDiscordRetryAfterHeaderMs(unknownError.headers, nowMs)
    ?? getDiscordRetryAfterHeaderMs(unknownError.response?.headers, nowMs);
}
