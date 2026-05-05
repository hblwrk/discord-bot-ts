import {postWithRetry} from "./http-retry.ts";
import {readSecret} from "./secrets.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

export type GeminiDependencies = {
  logger: Logger;
  nowMs?: () => number;
  postWithRetryFn?: typeof postWithRetry;
  readSecretFn?: typeof readSecret;
};

export type GeminiInlineData = {
  data: string;
  mimeType: string;
};

export type GeminiCallOptions = {
  timeoutMs?: number | undefined;
  useGoogleSearch?: boolean | undefined;
};

type GeminiConfig = {
  callsPerDay: number;
  apiKey: string;
  callsPerMinute: number;
  model: string;
};

type GeminiContentPart = {
  text: string;
} | {
  inline_data: {
    data: string;
    mime_type: string;
  };
};

type GeminiGenerateContentResponse = {
  candidates?: {
    content?: {
      parts?: {
        text?: string;
      }[];
    };
  }[];
};

const geminiApiEndpoint = "https://generativelanguage.googleapis.com/v1beta";
const geminiApiKeySecret = "gemini_api_key";
const geminiModelSecret = "gemini_model";
const geminiCallsPerMinuteSecret = "gemini_calls_per_minute";
const geminiCallsPerDaySecret = "gemini_calls_per_day";
const defaultGeminiModel = "gemini-2.5-flash-lite";
const defaultGeminiCallsPerMinute = 9;
const defaultGeminiCallsPerDay = 18;
const maxGeminiCallsPerMinute = 1_000;
const maxGeminiCallsPerDay = 100_000;
const geminiWindowMs = 60_000;
const geminiDayWindowMs = 24 * 60 * 60_000;
const defaultGeminiRateLimitCooldownMs = 60_000;

const geminiCallTimestampsMs: number[] = [];
const geminiDailyCallTimestampsMs: number[] = [];
let geminiCooldownUntilMs = 0;

export function clearGeminiState() {
  geminiCallTimestampsMs.splice(0, geminiCallTimestampsMs.length);
  geminiDailyCallTimestampsMs.splice(0, geminiDailyCallTimestampsMs.length);
  geminiCooldownUntilMs = 0;
}

export async function callGeminiJson(
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  dependencies: GeminiDependencies,
  task: string,
  inlineData?: GeminiInlineData,
  options: GeminiCallOptions = {},
): Promise<string | null> {
  const config = getGeminiConfig(dependencies);
  if (null === config) {
    return null;
  }

  if (false === reserveGeminiCall(config, dependencies, task)) {
    return null;
  }

  const postWithRetryFn = dependencies.postWithRetryFn ?? postWithRetry;
  const parts = getGeminiContentParts(prompt, inlineData);
  const requestBody = {
    contents: [{
      parts,
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema,
      temperature: 0,
    },
    ...(true === options.useGoogleSearch ? {
      tools: [{
        google_search: {},
      }],
    } : {}),
  };
  const response = await postWithRetryFn<GeminiGenerateContentResponse>(
    `${geminiApiEndpoint}/${getGeminiModelPath(config.model)}:generateContent`,
    requestBody,
    {
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.apiKey,
      },
    },
    {
      maxAttempts: 1,
      timeoutMs: options.timeoutMs ?? 15_000,
    },
  ).catch(error => {
    activateGeminiCooldownOnRateLimit(error, dependencies);
    throw error;
  });

  const firstCandidate = response.data.candidates?.[0];
  const textPart = firstCandidate?.content?.parts?.find(part => "string" === typeof part.text);
  return textPart?.text ?? null;
}

function getGeminiContentParts(
  prompt: string,
  inlineData: GeminiInlineData | undefined,
): GeminiContentPart[] {
  if (undefined === inlineData) {
    return [{
      text: prompt,
    }];
  }

  return [{
    inline_data: {
      data: inlineData.data,
      mime_type: inlineData.mimeType,
    },
  }, {
    text: prompt,
  }];
}

function getGeminiConfig(dependencies: GeminiDependencies): GeminiConfig | null {
  const readSecretFn = dependencies.readSecretFn ?? readSecret;
  const apiKey = readOptionalSecret(readSecretFn, geminiApiKeySecret);
  if (undefined === apiKey) {
    return null;
  }

  const model = readOptionalSecret(readSecretFn, geminiModelSecret) ?? defaultGeminiModel;
  const callsPerMinute = getGeminiCallsPerMinute(readOptionalSecret(readSecretFn, geminiCallsPerMinuteSecret));
  const callsPerDay = getGeminiCallsPerDay(readOptionalSecret(readSecretFn, geminiCallsPerDaySecret));
  return {
    apiKey,
    callsPerDay,
    callsPerMinute,
    model,
  };
}

function readOptionalSecret(readSecretFn: typeof readSecret, secretName: string): string | undefined {
  try {
    const value = readSecretFn(secretName).trim();
    return "" === value ? undefined : value;
  } catch {
    return undefined;
  }
}

function getGeminiCallsPerMinute(value: string | undefined): number {
  if (undefined === value) {
    return defaultGeminiCallsPerMinute;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (false === Number.isFinite(parsedValue)) {
    return defaultGeminiCallsPerMinute;
  }

  return Math.min(Math.max(parsedValue, 1), maxGeminiCallsPerMinute);
}

function getGeminiCallsPerDay(value: string | undefined): number {
  if (undefined === value) {
    return defaultGeminiCallsPerDay;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (false === Number.isFinite(parsedValue)) {
    return defaultGeminiCallsPerDay;
  }

  return Math.min(Math.max(parsedValue, 1), maxGeminiCallsPerDay);
}

function reserveGeminiCall(
  config: GeminiConfig,
  dependencies: GeminiDependencies,
  task: string,
): boolean {
  const nowMs = dependencies.nowMs?.() ?? Date.now();
  if (nowMs < geminiCooldownUntilMs) {
    dependencies.logger.log(
      "warn",
      `Skipping Gemini ${task}: API rate-limit cooldown is active for ${Math.ceil((geminiCooldownUntilMs - nowMs) / 1000)}s.`,
    );
    return false;
  }

  const windowStartMs = nowMs - geminiWindowMs;
  while (0 < geminiCallTimestampsMs.length && (geminiCallTimestampsMs[0] ?? 0) <= windowStartMs) {
    geminiCallTimestampsMs.shift();
  }

  const dayWindowStartMs = nowMs - geminiDayWindowMs;
  while (0 < geminiDailyCallTimestampsMs.length && (geminiDailyCallTimestampsMs[0] ?? 0) <= dayWindowStartMs) {
    geminiDailyCallTimestampsMs.shift();
  }

  if (geminiCallTimestampsMs.length >= config.callsPerMinute) {
    dependencies.logger.log(
      "warn",
      `Skipping Gemini ${task}: local ${config.callsPerMinute}/minute rate limit is exhausted.`,
    );
    return false;
  }

  if (geminiDailyCallTimestampsMs.length >= config.callsPerDay) {
    dependencies.logger.log(
      "warn",
      `Skipping Gemini ${task}: local ${config.callsPerDay}/day rate limit is exhausted.`,
    );
    return false;
  }

  geminiCallTimestampsMs.push(nowMs);
  geminiDailyCallTimestampsMs.push(nowMs);
  return true;
}

function activateGeminiCooldownOnRateLimit(error: unknown, dependencies: GeminiDependencies) {
  if (429 !== getHttpStatus(error)) {
    return;
  }

  const nowMs = dependencies.nowMs?.() ?? Date.now();
  const retryAfterMs = getRetryAfterMs(error) ?? defaultGeminiRateLimitCooldownMs;
  geminiCooldownUntilMs = Math.max(geminiCooldownUntilMs, nowMs + retryAfterMs);
  dependencies.logger.log(
    "warn",
    `Gemini API returned 429; cooling down Gemini calls for ${Math.ceil(retryAfterMs / 1000)}s.`,
  );
}

function getHttpStatus(error: unknown): number | undefined {
  if (false === isRecord(error)) {
    return undefined;
  }

  const response = error["response"];
  if (false === isRecord(response)) {
    return undefined;
  }

  const status = response["status"];
  return "number" === typeof status ? status : undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (false === isRecord(error)) {
    return undefined;
  }

  const response = error["response"];
  if (false === isRecord(response)) {
    return undefined;
  }

  const headers = response["headers"];
  if (false === isRecord(headers)) {
    return undefined;
  }

  const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
  if ("number" === typeof retryAfter && Number.isFinite(retryAfter)) {
    return Math.max(1, retryAfter) * 1_000;
  }

  if ("string" !== typeof retryAfter || "" === retryAfter.trim()) {
    return undefined;
  }

  const retryAfterSeconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(retryAfterSeconds)) {
    return Math.max(1, retryAfterSeconds) * 1_000;
  }

  const retryAfterTimestampMs = Date.parse(retryAfter);
  if (false === Number.isFinite(retryAfterTimestampMs)) {
    return undefined;
  }

  return Math.max(1_000, retryAfterTimestampMs - Date.now());
}

function getGeminiModelPath(model: string): string {
  const normalizedModel = model.trim();
  if ("" === normalizedModel || /[^a-z0-9._/-]/i.test(normalizedModel)) {
    return `models/${defaultGeminiModel}`;
  }

  return normalizedModel.startsWith("models/")
    ? normalizedModel
    : `models/${normalizedModel}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}
