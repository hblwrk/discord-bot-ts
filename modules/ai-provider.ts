import {
  callGeminiJson,
  clearGeminiState,
  type GeminiCallOptions,
  type GeminiDependencies,
} from "./gemini.ts";
import {callOpenAiJson, clearOpenAiState, type OpenAiCallOptions, type OpenAiDependencies} from "./openai.ts";
import {readSecret} from "./secrets.ts";

export type AiProviderDependencies = GeminiDependencies & OpenAiDependencies;

export type AiProviderInlineData = {
  data: string;
  filename?: string | undefined;
  mimeType: string;
};

export type AiProviderCallOptions = {
  timeoutMs?: number | undefined;
  useWebSearch?: boolean | undefined;
};

type AiProviderName = "gemini" | "openai";

const aiProviderSecret = "ai_provider";

export function clearAiProviderState() {
  clearGeminiState();
  clearOpenAiState();
}

export async function callAiProviderJson(
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  dependencies: AiProviderDependencies,
  task: string,
  inlineData?: AiProviderInlineData,
  options: AiProviderCallOptions = {},
): Promise<string | null> {
  if ("openai" === getAiProviderName(dependencies)) {
    const openAiOptions: OpenAiCallOptions = {};
    if (undefined !== options.timeoutMs) {
      openAiOptions.timeoutMs = options.timeoutMs;
    }

    if (true === options.useWebSearch) {
      openAiOptions.useWebSearch = true;
    }

    return callOpenAiJson(
      prompt,
      responseJsonSchema,
      dependencies,
      task,
      inlineData,
      openAiOptions,
    );
  }

  const geminiOptions: GeminiCallOptions = {};
  if (undefined !== options.timeoutMs) {
    geminiOptions.timeoutMs = options.timeoutMs;
  }

  if (true === options.useWebSearch) {
    geminiOptions.useGoogleSearch = true;
  }

  return callGeminiJson(
    prompt,
    responseJsonSchema,
    dependencies,
    task,
    undefined === inlineData ? undefined : {
      data: inlineData.data,
      mimeType: inlineData.mimeType,
    },
    geminiOptions,
  );
}

function getAiProviderName(dependencies: AiProviderDependencies): AiProviderName {
  const readSecretFn = dependencies.readSecretFn ?? readSecret;
  const configuredProvider = readOptionalSecret(readSecretFn, aiProviderSecret)?.toLowerCase();
  if (undefined === configuredProvider || "" === configuredProvider || "gemini" === configuredProvider) {
    return "gemini";
  }

  if ("openai" === configuredProvider) {
    return "openai";
  }

  dependencies.logger.log(
    "warn",
    `Unsupported AI provider "${configuredProvider}"; using Gemini.`,
  );
  return "gemini";
}

function readOptionalSecret(readSecretFn: typeof readSecret, secretName: string): string | undefined {
  try {
    const value = readSecretFn(secretName).trim();
    return "" === value ? undefined : value;
  } catch {
    return undefined;
  }
}
