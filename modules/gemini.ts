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
};

type GeminiConfig = {
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
const defaultGeminiModel = "gemini-2.5-flash-lite";
const defaultGeminiCallsPerMinute = 14;
const maxGeminiCallsPerMinute = 30;
const geminiWindowMs = 60_000;

const geminiCallTimestampsMs: number[] = [];

export function clearGeminiState() {
  geminiCallTimestampsMs.splice(0, geminiCallTimestampsMs.length);
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
  const response = await postWithRetryFn<GeminiGenerateContentResponse>(
    `${geminiApiEndpoint}/${getGeminiModelPath(config.model)}:generateContent`,
    {
      contents: [{
        parts,
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema,
        temperature: 0,
      },
    },
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
  );

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
  return {
    apiKey,
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

function reserveGeminiCall(
  config: GeminiConfig,
  dependencies: GeminiDependencies,
  task: string,
): boolean {
  const nowMs = dependencies.nowMs?.() ?? Date.now();
  const windowStartMs = nowMs - geminiWindowMs;
  while (0 < geminiCallTimestampsMs.length && (geminiCallTimestampsMs[0] ?? 0) <= windowStartMs) {
    geminiCallTimestampsMs.shift();
  }

  if (geminiCallTimestampsMs.length >= config.callsPerMinute) {
    dependencies.logger.log(
      "warn",
      `Skipping Gemini ${task}: local ${config.callsPerMinute}/minute rate limit is exhausted.`,
    );
    return false;
  }

  geminiCallTimestampsMs.push(nowMs);
  return true;
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
