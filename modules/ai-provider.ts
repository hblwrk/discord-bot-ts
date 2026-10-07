import {
  callGeminiJson,
  clearGeminiState,
  isGeminiAvailable,
  type GeminiCallOptions,
  type GeminiDependencies,
} from "./gemini.ts";
import {callOpenAiJson, clearOpenAiState, isOpenAiAvailable, type OpenAiCallOptions, type OpenAiDependencies} from "./openai.ts";
import {readSecret} from "./secrets.ts";

export type AiProviderDependencies = GeminiDependencies & OpenAiDependencies;

export type AiProviderInlineData = {
  data: string;
  filename?: string | undefined;
  mimeType: string;
};

export type AiProviderCallOptions = {
  onWebSources?: ((urls: string[]) => void) | undefined;
  timeoutMs?: number | undefined;
  useWebSearch?: boolean | undefined;
};

type AiProviderName = "gemini" | "openai" | "none";

const aiProviderSecret = "ai_provider";

export function clearAiProviderState() {
  clearGeminiState();
  clearOpenAiState();
}

export function isAiProviderAvailable(dependencies: AiProviderDependencies): boolean {
  const provider = getAiProviderName({...dependencies, logger: {log: () => {}}});
  if ("none" === provider) {
    return false;
  }
  return "openai" === provider ? isOpenAiAvailable(dependencies) : isGeminiAvailable(dependencies);
}

export async function callAiProviderJson(
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  dependencies: AiProviderDependencies,
  task: string,
  inlineData?: AiProviderInlineData,
  options: AiProviderCallOptions = {},
): Promise<string | null> {
  const provider = getAiProviderName(dependencies);
  if ("none" === provider) {
    return null;
  }
  if ("openai" === provider) {
    const openAiOptions: OpenAiCallOptions = {};
    if (undefined !== options.timeoutMs) {
      openAiOptions.timeoutMs = options.timeoutMs;
    }

    if (true === options.useWebSearch) {
      openAiOptions.useWebSearch = true;
    }
    if (undefined !== options.onWebSources) {
      openAiOptions.onWebSources = options.onWebSources;
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
  if (undefined !== options.onWebSources) {
    geminiOptions.onWebSources = options.onWebSources;
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

  if (["none", "off", "disabled"].includes(configuredProvider)) {
    return "none";
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
