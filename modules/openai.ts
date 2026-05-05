import {postWithRetry} from "./http-retry.ts";
import {readSecret} from "./secrets.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

export type OpenAiDependencies = {
  logger: Logger;
  nowMs?: () => number;
  postWithRetryFn?: typeof postWithRetry;
  readSecretFn?: typeof readSecret;
};

export type OpenAiInlineData = {
  data: string;
  filename?: string | undefined;
  mimeType: string;
};

export type OpenAiCallOptions = {
  timeoutMs?: number | undefined;
  useWebSearch?: boolean | undefined;
};

type OpenAiConfig = {
  apiKey: string;
  callsPerDay: number;
  callsPerMinute: number;
  model: string;
};

type OpenAiInputPart = {
  text: string;
  type: "input_text";
} | {
  file_data: string;
  filename: string;
  type: "input_file";
};

type OpenAiResponse = {
  output?: {
    content?: {
      text?: string;
      type?: string;
    }[];
  }[];
  output_text?: string;
};

const openAiResponsesEndpoint = "https://api.openai.com/v1/responses";
const openAiApiKeySecret = "openai_api_key";
const openAiModelSecret = "openai_model";
const openAiCallsPerMinuteSecret = "openai_calls_per_minute";
const openAiCallsPerDaySecret = "openai_calls_per_day";
const defaultOpenAiModel = "gpt-5.4-mini";
const defaultOpenAiCallsPerMinute = 20;
const defaultOpenAiCallsPerDay = 200;
const maxOpenAiCallsPerMinute = 1_000;
const maxOpenAiCallsPerDay = 100_000;
const openAiWindowMs = 60_000;
const openAiDayWindowMs = 24 * 60 * 60_000;
const defaultOpenAiRateLimitCooldownMs = 60_000;

const openAiCallTimestampsMs: number[] = [];
const openAiDailyCallTimestampsMs: number[] = [];
let openAiCooldownUntilMs = 0;

export function clearOpenAiState() {
  openAiCallTimestampsMs.splice(0, openAiCallTimestampsMs.length);
  openAiDailyCallTimestampsMs.splice(0, openAiDailyCallTimestampsMs.length);
  openAiCooldownUntilMs = 0;
}

export async function callOpenAiJson(
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  dependencies: OpenAiDependencies,
  task: string,
  inlineData?: OpenAiInlineData,
  options: OpenAiCallOptions = {},
): Promise<string | null> {
  const config = getOpenAiConfig(dependencies);
  if (null === config) {
    return null;
  }

  if (false === reserveOpenAiCall(config, dependencies, task)) {
    return null;
  }

  const postWithRetryFn = dependencies.postWithRetryFn ?? postWithRetry;
  const requestBody = {
    input: [{
      content: getOpenAiInputParts(prompt, inlineData),
      role: "user",
    }],
    model: config.model,
    text: {
      format: {
        name: "bot_response",
        schema: responseJsonSchema,
        strict: true,
        type: "json_schema",
      },
    },
    ...(true === options.useWebSearch ? {
      tool_choice: "required",
      tools: [{
        search_context_size: "low",
        type: "web_search",
      }],
    } : {}),
  };

  const response = await postWithRetryFn<OpenAiResponse>(
    openAiResponsesEndpoint,
    requestBody,
    {
      headers: {
        "Authorization": `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
    },
    {
      maxAttempts: 1,
      timeoutMs: options.timeoutMs ?? 15_000,
    },
  ).catch(error => {
    activateOpenAiCooldownOnRateLimit(error, dependencies);
    throw error;
  });

  return getOpenAiOutputText(response.data);
}

function getOpenAiInputParts(prompt: string, inlineData: OpenAiInlineData | undefined): OpenAiInputPart[] {
  const promptPart: OpenAiInputPart = {
    text: prompt,
    type: "input_text",
  };
  if (undefined === inlineData) {
    return [promptPart];
  }

  return [{
    file_data: `data:${inlineData.mimeType};base64,${inlineData.data}`,
    filename: inlineData.filename ?? getDefaultInlineFileName(inlineData.mimeType),
    type: "input_file",
  }, promptPart];
}

function getDefaultInlineFileName(mimeType: string): string {
  if ("application/pdf" === mimeType) {
    return "attachment.pdf";
  }

  return "attachment.bin";
}

function getOpenAiConfig(dependencies: OpenAiDependencies): OpenAiConfig | null {
  const readSecretFn = dependencies.readSecretFn ?? readSecret;
  const apiKey = readOptionalSecret(readSecretFn, openAiApiKeySecret);
  if (undefined === apiKey) {
    return null;
  }

  const model = readOptionalSecret(readSecretFn, openAiModelSecret) ?? defaultOpenAiModel;
  const callsPerMinute = getOpenAiCallsPerMinute(readOptionalSecret(readSecretFn, openAiCallsPerMinuteSecret));
  const callsPerDay = getOpenAiCallsPerDay(readOptionalSecret(readSecretFn, openAiCallsPerDaySecret));
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

function getOpenAiCallsPerMinute(value: string | undefined): number {
  if (undefined === value) {
    return defaultOpenAiCallsPerMinute;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (false === Number.isFinite(parsedValue)) {
    return defaultOpenAiCallsPerMinute;
  }

  return Math.min(Math.max(parsedValue, 1), maxOpenAiCallsPerMinute);
}

function getOpenAiCallsPerDay(value: string | undefined): number {
  if (undefined === value) {
    return defaultOpenAiCallsPerDay;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (false === Number.isFinite(parsedValue)) {
    return defaultOpenAiCallsPerDay;
  }

  return Math.min(Math.max(parsedValue, 1), maxOpenAiCallsPerDay);
}

function reserveOpenAiCall(
  config: OpenAiConfig,
  dependencies: OpenAiDependencies,
  task: string,
): boolean {
  const nowMs = dependencies.nowMs?.() ?? Date.now();
  if (nowMs < openAiCooldownUntilMs) {
    dependencies.logger.log(
      "warn",
      `Skipping OpenAI ${task}: API rate-limit cooldown is active for ${Math.ceil((openAiCooldownUntilMs - nowMs) / 1000)}s.`,
    );
    return false;
  }

  const windowStartMs = nowMs - openAiWindowMs;
  while (0 < openAiCallTimestampsMs.length && (openAiCallTimestampsMs[0] ?? 0) <= windowStartMs) {
    openAiCallTimestampsMs.shift();
  }

  const dayWindowStartMs = nowMs - openAiDayWindowMs;
  while (0 < openAiDailyCallTimestampsMs.length && (openAiDailyCallTimestampsMs[0] ?? 0) <= dayWindowStartMs) {
    openAiDailyCallTimestampsMs.shift();
  }

  if (openAiCallTimestampsMs.length >= config.callsPerMinute) {
    dependencies.logger.log(
      "warn",
      `Skipping OpenAI ${task}: local ${config.callsPerMinute}/minute rate limit is exhausted.`,
    );
    return false;
  }

  if (openAiDailyCallTimestampsMs.length >= config.callsPerDay) {
    dependencies.logger.log(
      "warn",
      `Skipping OpenAI ${task}: local ${config.callsPerDay}/day rate limit is exhausted.`,
    );
    return false;
  }

  openAiCallTimestampsMs.push(nowMs);
  openAiDailyCallTimestampsMs.push(nowMs);
  return true;
}

function activateOpenAiCooldownOnRateLimit(error: unknown, dependencies: OpenAiDependencies) {
  if (429 !== getHttpStatus(error)) {
    return;
  }

  const nowMs = dependencies.nowMs?.() ?? Date.now();
  const retryAfterMs = getRetryAfterMs(error, nowMs) ?? defaultOpenAiRateLimitCooldownMs;
  openAiCooldownUntilMs = Math.max(openAiCooldownUntilMs, nowMs + retryAfterMs);
  dependencies.logger.log(
    "warn",
    `OpenAI API returned 429; cooling down OpenAI calls for ${Math.ceil(retryAfterMs / 1000)}s.`,
  );
}

function getOpenAiOutputText(response: OpenAiResponse): string | null {
  if ("string" === typeof response.output_text) {
    return response.output_text;
  }

  const outputTexts = response.output
    ?.flatMap(outputItem => outputItem.content ?? [])
    .flatMap(contentPart => "output_text" === contentPart.type && "string" === typeof contentPart.text ? [contentPart.text] : []) ?? [];
  return 0 === outputTexts.length ? null : outputTexts.join("\n");
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

function getRetryAfterMs(error: unknown, nowMs: number): number | undefined {
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

  return Math.max(1_000, retryAfterTimestampMs - nowMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}
