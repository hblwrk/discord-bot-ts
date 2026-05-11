import moment from "moment-timezone";
import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";
import {type getWithRetry} from "./http-retry.ts";
import {
  formatMarketCloseTickerFactsForPrompt,
  hasRequiredMarketCloseTickerFacts,
  getTickerFactValidationIssue,
  loadMarketCloseTickerFacts,
  type MarketCloseTickerFact,
} from "./market-close-ticker-facts.ts";

export type MarketCloseSentimentAnswer = "Risk-on" | "Risk-off" | "Cash" | "Chaos";

export type MarketCloseRecapPayload = {
  allowedUserIds: string[];
  content: string;
};

export type MarketCloseRecapDependencies = AiProviderDependencies & {
  getWithRetryFn?: typeof getWithRetry | undefined;
};

export type MarketCloseRecapOptions = {
  date?: Date | undefined;
  maxFetchedWinners?: number | undefined;
  maxMentionedWinners?: number | undefined;
  requireTickerFacts?: boolean | undefined;
  tickerFacts?: MarketCloseTickerFact[] | null | undefined;
};

type PollAnswerFetchOptions = {
  after?: string | undefined;
  limit?: number | undefined;
};

type PollAnswerVoters = {
  fetch?: (options?: PollAnswerFetchOptions) => Promise<unknown> | unknown;
};

type PollAnswerLike = {
  answer_id?: number | undefined;
  answerId?: number | undefined;
  id?: number | undefined;
  media?: {
    text?: string | null | undefined;
  } | undefined;
  poll_media?: {
    text?: string | null | undefined;
  } | undefined;
  pollMedia?: {
    text?: string | null | undefined;
  } | undefined;
  text?: string | null | undefined;
  voters?: PollAnswerVoters | undefined;
};

type PollLike = {
  answers?: unknown;
  question?: {
    text?: string | null | undefined;
  } | undefined;
};

type PollMessageLike = {
  createdAt?: Date | undefined;
  createdTimestamp?: number | undefined;
  poll?: PollLike | null | undefined;
};

type AiMarketCloseRecap = {
  sentimentTitle?: string | undefined;
  summaryMarkdown: string;
  winningPollAnswer: MarketCloseSentimentAnswer;
};

const usEasternTimezone = "US/Eastern";
const defaultMaxFetchedWinners = 200;
const defaultMaxMentionedWinners = 20;
const marketOpenSentimentPollQuestion = "Opening Sentiment: Wie geht ihr in den Handel?";
const marketOpenPollHistoryLimit = 50;
const maxSummaryMarkdownLength = 1_100;
const maxRecapContentLength = 1_950;

const sentimentLabels = {
  "Risk-on": "🟢 Risk-on",
  "Risk-off": "🔴 Risk-off",
  "Cash": "💵 Cash",
  "Chaos": "🎢 Chaos",
} satisfies Record<MarketCloseSentimentAnswer, string>;
const sentimentAnswerIds = {
  "Risk-on": 1,
  "Risk-off": 2,
  "Cash": 3,
  "Chaos": 4,
} satisfies Record<MarketCloseSentimentAnswer, number>;

const marketCloseRecapSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summaryMarkdown: {
      type: "string",
      description: "A short German market-close summary in Discord-compatible Markdown.",
    },
    winningPollAnswer: {
      type: "string",
      enum: ["Risk-on", "Risk-off", "Cash", "Chaos"],
      description: "The opening sentiment poll answer that best matched the US cash session from open to close.",
    },
    sentimentTitle: {
      type: "string",
      description: "A concise German label for the session, without mentioning any AI provider.",
    },
  },
  required: ["summaryMarkdown", "winningPollAnswer", "sentimentTitle"],
} satisfies Record<string, unknown>;

export async function getMarketCloseRecap(
  pollMessage: unknown,
  dependencies: MarketCloseRecapDependencies,
  options: MarketCloseRecapOptions = {},
): Promise<MarketCloseRecapPayload | undefined> {
  const date = options.date ?? new Date();
  const tickerFacts = await getTickerFacts(date, dependencies, options);
  if (true === options.requireTickerFacts && false === hasRequiredMarketCloseTickerFacts(tickerFacts)) {
    dependencies.logger.log(
      "warn",
      "Skipping market close recap: required market-data bot facts are unavailable.",
    );
    return undefined;
  }

  const jsonText = await callAiProviderJson(
    getMarketCloseRecapPrompt(date, tickerFacts),
    marketCloseRecapSchema,
    dependencies,
    "market close recap",
    undefined,
    {
      timeoutMs: 45_000,
      useWebSearch: true,
    },
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `AI market close recap failed: ${error}`,
    );
    return null;
  });
  if (null === jsonText) {
    return undefined;
  }

  const recap = parseAiMarketCloseRecap(jsonText, dependencies, tickerFacts);
  if (undefined === recap) {
    return undefined;
  }

  const rightVoterIds = await getRightVoterIds(pollMessage, recap.winningPollAnswer, dependencies, options);
  const mentionedUserIds = rightVoterIds?.slice(0, options.maxMentionedWinners ?? defaultMaxMentionedWinners) ?? [];
  const content = buildMarketCloseRecapContent(recap, rightVoterIds?.length, mentionedUserIds);
  return {
    allowedUserIds: mentionedUserIds,
    content,
  };
}

export async function findMarketOpenSentimentPollMessage(
  channel: unknown,
  dependencies: Pick<MarketCloseRecapDependencies, "logger">,
  options: Pick<MarketCloseRecapOptions, "date"> = {},
): Promise<PollMessageLike | undefined> {
  const messages = getMessageManager(channel);
  const fetchMessages = messages?.fetch;
  if ("function" !== typeof fetchMessages) {
    return undefined;
  }

  const fetchedMessages = await Promise.resolve(fetchMessages({
    limit: marketOpenPollHistoryLimit,
  })).catch(error => {
    dependencies.logger.log(
      "warn",
      `Could not recover NYSE opening sentiment poll from message history: ${error}`,
    );
    return undefined;
  });
  const targetDate = options.date ?? new Date();
  return getMessages(fetchedMessages)
    .filter(message => true === isSentimentPollMessage(message))
    .filter(message => true === isSameUsEasternDate(message, targetDate))
    .sort((left, right) => getMessageTimestamp(right) - getMessageTimestamp(left))[0];
}

function getMessageManager(channel: unknown): {fetch?: (options?: {limit?: number | undefined}) => Promise<unknown> | unknown} | undefined {
  if (false === isRecord(channel)) {
    return undefined;
  }

  const messages = channel["messages"];
  if (false === isRecord(messages)) {
    return undefined;
  }

  const fetch = messages["fetch"];
  if ("function" !== typeof fetch) {
    return {};
  }

  const fetchFn = fetch as (this: unknown, options?: {limit?: number | undefined}) => Promise<unknown> | unknown;
  return {
    fetch: options => fetchFn.call(messages, options),
  };
}

async function getTickerFacts(
  date: Date,
  dependencies: MarketCloseRecapDependencies,
  options: MarketCloseRecapOptions,
): Promise<MarketCloseTickerFact[]> {
  if (Array.isArray(options.tickerFacts)) {
    return options.tickerFacts;
  }

  if (null === options.tickerFacts || undefined === dependencies.getWithRetryFn) {
    return [];
  }

  return loadMarketCloseTickerFacts(date, {
    getWithRetryFn: dependencies.getWithRetryFn,
    logger: dependencies.logger,
  });
}

function getMarketCloseRecapPrompt(date: Date, tickerFacts: MarketCloseTickerFact[]): string {
  const usEasternDate = moment(date).tz(usEasternTimezone).format("YYYY-MM-DD");
  const tickerFactsPrompt = formatMarketCloseTickerFactsForPrompt(tickerFacts);
  return [
    `Heute ist nach US-Börsenschluss am ${usEasternDate} (US/Eastern).`,
    "Nutze Websuche, um den US-Handelstag realitätsnah einzuordnen.",
    "Priorisiere bei schnellen Markt-Wrapups offizielle Börsen-/Indexanbieter und etablierte Finanznachrichten wie Reuters, Bloomberg, CNBC, MarketWatch, WSJ, Nasdaq, NYSE, Cboe und S&P Dow Jones Indices.",
    "Ignoriere Blogs, Social Posts, SEO-Seiten und fachfremde Nachrichtenportale, wenn sie den Ticker-Daten oder autoritativen Finanzquellen widersprechen.",
    tickerFactsPrompt,
    "Bewerte den Handelstag fuer die konfigurierten Market-Data-Bot-Instrumente; bei Bot-Snapshots ist die Bot-Veraenderung massgeblich.",
    "Für die Poll-Sentiment-Auswahl ist die Veraenderung aus den Ticker-Fakten maßgeblich; Close-to-close oder Bot-Veraenderung darf als Tagesveränderung genannt werden.",
    "Berücksichtige ausschließlich `ES`, `NQ`, `RTY` sowie zwingend den `VIX`.",
    "Erwähne nicht die Cash-/ETF-Pendants `SPX`, `SPY`, `NDX`, `RUT`, `QQQ` oder `IWM`.",
    "Der `VIX` darf niemals als Prozentwert beschrieben werden. Beschreibe ihn nur als Stand, Veränderung in Punkten oder Richtung, z.B. `18,4` auf `20,1` oder `+1,7 Punkte`.",
    "Wähle genau eine passende Antwort aus dem Opening-Sentiment-Poll:",
    "- Risk-on: breite Stärke, fallender oder ruhiger `VIX`, Risikoappetit.",
    "- Risk-off: breite Schwäche, steigender `VIX`, Defensive/Absicherung dominiert.",
    "- Cash: wenig Richtung, dünne Signale, abwartender Handel.",
    "- Chaos: starke Reversals, gemischte Indizes, hohe Intraday-Spanne, headline-getriebener oder schwer lesbarer Handel.",
    "Return only JSON matching the schema. Do not include Markdown outside JSON strings.",
    "Schreibe `summaryMarkdown` auf Deutsch für einen Discord-Trading-Channel.",
    "Halte `summaryMarkdown` unter 1.000 Zeichen.",
    "Nutze 2-4 kurze Absätze oder Bulletpoints.",
    "Nenne die Poll-Sentiment-Labels `Risk-on`, `Risk-off`, `Cash` und `Chaos` nicht in `summaryMarkdown`; das gewählte Sentiment steht nur in der separaten Sentiment-Zeile.",
    "Formatiere Ticker und konkrete Kennzahlen als Inline-Code, z.B. `ES`, `NQ`, `RTY`, `+0,4%`, `1,7 Punkte`.",
    "Erwähne weder KI-Anbieter, KI, Modell, Websuche, Quellen, Grounding noch Rechercheprozess.",
    "Keine Disclaimer, keine Links, keine Tabellen, keine Codeblöcke.",
  ].filter(line => "" !== line).join("\n");
}

function parseAiMarketCloseRecap(
  jsonText: string,
  dependencies: MarketCloseRecapDependencies,
  tickerFacts: MarketCloseTickerFact[],
): AiMarketCloseRecap | undefined {
  const parsedJson = parseJson(jsonText);
  if (false === isRecord(parsedJson)) {
    dependencies.logger.log(
      "warn",
      "AI market close recap returned invalid JSON.",
    );
    return undefined;
  }

  const summaryMarkdown = parsedJson["summaryMarkdown"];
  const winningPollAnswer = parsedJson["winningPollAnswer"];
  const sentimentTitle = parsedJson["sentimentTitle"];
  if ("string" !== typeof summaryMarkdown ||
      false === isMarketCloseSentimentAnswer(winningPollAnswer) ||
      "string" !== typeof sentimentTitle) {
    dependencies.logger.log(
      "warn",
      "AI market close recap response missed required fields.",
    );
    return undefined;
  }

  const normalizedSummary = truncateSummary(normalizeMarkdown(summaryMarkdown));
  const normalizedTitle = normalizeSingleLine(sentimentTitle);
  const combinedText = `${normalizedSummary}\n${normalizedTitle}`;
  if ("" === normalizedSummary ||
      false === /\bVIX\b/i.test(combinedText) ||
      true === hasPollSentimentLabel(normalizedSummary) ||
      true === hasForbiddenProviderMention(combinedText) ||
      true === hasForbiddenMarketProxyMention(combinedText) ||
      true === hasVixPercent(combinedText)) {
    dependencies.logger.log(
      "warn",
      "AI market close recap failed output validation.",
    );
    return undefined;
  }

  const tickerValidationIssue = getTickerFactValidationIssue(combinedText, winningPollAnswer, tickerFacts);
  if (undefined !== tickerValidationIssue) {
    dependencies.logger.log(
      "warn",
      `AI market close recap contradicted ticker facts: ${tickerValidationIssue}.`,
    );
    return undefined;
  }

  return {
    sentimentTitle: normalizedTitle,
    summaryMarkdown: normalizedSummary,
    winningPollAnswer,
  };
}

function buildMarketCloseRecapContent(
  recap: AiMarketCloseRecap,
  totalRightVoterCount: number | undefined,
  mentionedUserIds: string[],
): string {
  const sentimentLine = getSentimentLine(recap);
  const voterSection = getVoterSection(totalRightVoterCount, mentionedUserIds);
  return truncateRecapContent([
    "**Börsenschluss - Kurzüberblick**",
    recap.summaryMarkdown,
    sentimentLine,
    voterSection,
  ].filter(line => "" !== line).join("\n"));
}

function getSentimentLine(recap: AiMarketCloseRecap): string {
  const answerLabel = sentimentLabels[recap.winningPollAnswer];
  if (undefined === recap.sentimentTitle || "" === recap.sentimentTitle) {
    return `Das heutige Sentiment war: **${answerLabel}**`;
  }

  return `Das heutige Sentiment war: **${answerLabel}** - ${recap.sentimentTitle}`;
}

function getVoterSection(totalRightVoterCount: number | undefined, mentionedUserIds: string[]): string {
  if (undefined === totalRightVoterCount) {
    return "";
  }

  if (0 === totalRightVoterCount) {
    return "Richtig gelegen hat heute niemand im Opening-Poll.";
  }

  const suffix = totalRightVoterCount > mentionedUserIds.length
    ? `\nund \`${totalRightVoterCount - mentionedUserIds.length}\` weitere.`
    : "";
  return `Richtig gelegen haben:\n${mentionedUserIds.map(userId => `<@${userId}>`).join(" ")}${suffix}`;
}

async function getRightVoterIds(
  pollMessage: unknown,
  winningPollAnswer: MarketCloseSentimentAnswer,
  dependencies: MarketCloseRecapDependencies,
  options: MarketCloseRecapOptions,
): Promise<string[] | undefined> {
  const answer = getPollAnswerByText(pollMessage, winningPollAnswer);
  if (undefined === answer) {
    dependencies.logger.log(
      "warn",
      `Skipping market close recap voter mentions: poll answer ${winningPollAnswer} was not found.`,
    );
    return undefined;
  }

  const fetchVoters = answer.voters?.fetch;
  if ("function" !== typeof fetchVoters) {
    dependencies.logger.log(
      "warn",
      `Skipping market close recap voter mentions: poll answer ${winningPollAnswer} is not fetchable.`,
    );
    return undefined;
  }

  const maxFetchedWinners = options.maxFetchedWinners ?? defaultMaxFetchedWinners;
  const voterIds: string[] = [];
  let after: string | undefined;
  while (voterIds.length < maxFetchedWinners) {
    const limit = Math.min(100, maxFetchedWinners - voterIds.length);
    const voters = await Promise.resolve(fetchVoters.call(answer.voters, {
      ...(undefined === after ? {} : {after}),
      limit,
    })).catch(error => {
      dependencies.logger.log(
        "warn",
        `Could not fetch market close recap poll voters: ${error}`,
      );
      return undefined;
    });
    if (undefined === voters) {
      return undefined;
    }

    const pageUserIds = getUserIds(voters).filter(userId => false === voterIds.includes(userId));
    if (0 === pageUserIds.length) {
      break;
    }

    voterIds.push(...pageUserIds);
    if (pageUserIds.length < limit) {
      break;
    }

    after = pageUserIds[pageUserIds.length - 1];
  }

  return voterIds;
}

function getPollAnswerByText(
  pollMessage: unknown,
  answerText: MarketCloseSentimentAnswer,
): PollAnswerLike | undefined {
  const answers = getPollAnswers(pollMessage);
  const normalizedAnswerText = normalizePollAnswerText(answerText);
  const textMatch = answers.find(answer => normalizePollAnswerText(getPollAnswerText(answer)) === normalizedAnswerText);
  if (undefined !== textMatch) {
    return textMatch;
  }

  const fallbackAnswerId = sentimentAnswerIds[answerText];
  return answers.find(answer => getPollAnswerId(answer) === fallbackAnswerId);
}

function isSentimentPollMessage(message: PollMessageLike): boolean {
  return message.poll?.question?.text === marketOpenSentimentPollQuestion &&
    0 < getPollAnswers(message).length;
}

function isSameUsEasternDate(message: PollMessageLike, date: Date): boolean {
  const timestamp = getMessageTimestamp(message);
  if (0 === timestamp) {
    return true;
  }

  return moment(timestamp).tz(usEasternTimezone).format("YYYY-MM-DD") ===
    moment(date).tz(usEasternTimezone).format("YYYY-MM-DD");
}

function getMessageTimestamp(message: PollMessageLike): number {
  if ("number" === typeof message.createdTimestamp && Number.isFinite(message.createdTimestamp)) {
    return message.createdTimestamp;
  }

  const createdAtTime = message.createdAt?.getTime();
  return "number" === typeof createdAtTime && Number.isFinite(createdAtTime) ? createdAtTime : 0;
}

function getMessages(value: unknown): PollMessageLike[] {
  if (undefined === value || null === value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter(isPollMessageLike);
  }

  if (isRecord(value)) {
    const values = value["values"];
    if ("function" === typeof values) {
      const valuesFn = values as (this: unknown) => Iterable<unknown>;
      return Array.from(valuesFn.call(value)).filter(isPollMessageLike);
    }

    return Object.values(value).filter(isPollMessageLike);
  }

  return [];
}

function getPollAnswers(pollMessage: unknown): PollAnswerLike[] {
  if (false === isPollMessageLike(pollMessage)) {
    return [];
  }

  const answers = pollMessage.poll?.answers;
  if (undefined === answers || null === answers) {
    return [];
  }

  if (Array.isArray(answers)) {
    return answers.filter(isPollAnswerLike);
  }

  if (isRecord(answers)) {
    const values = answers["values"];
    if ("function" === typeof values) {
      const valuesFn = values as (this: unknown) => Iterable<unknown>;
      return Array.from(valuesFn.call(answers)).filter(isPollAnswerLike);
    }

    return Object.values(answers).filter(isPollAnswerLike);
  }

  return [];
}

function getUserIds(value: unknown): string[] {
  if (undefined === value || null === value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(getUserIds);
  }

  if (isRecord(value)) {
    const id = value["id"];
    if ("string" === typeof id && "" !== id.trim()) {
      return [id.trim()];
    }

    const values = value["values"];
    if ("function" === typeof values) {
      const valuesFn = values as (this: unknown) => Iterable<unknown>;
      return Array.from(valuesFn.call(value)).flatMap(getUserIds);
    }

    const users = value["users"];
    if (Array.isArray(users)) {
      return users.flatMap(getUserIds);
    }
  }

  return [];
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trimEnd())
    .filter(line => false === /^```/.test(line.trim()))
    .join("\n")
    .trim();
}

function normalizeSingleLine(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function truncateSummary(value: string): string {
  if (value.length <= maxSummaryMarkdownLength) {
    return value;
  }

  const truncatedValue = value.slice(0, maxSummaryMarkdownLength - 8);
  const lastLineBreak = truncatedValue.lastIndexOf("\n");
  const summary = lastLineBreak > 0
    ? truncatedValue.slice(0, lastLineBreak)
    : truncatedValue;
  return `${summary.trimEnd()}\n...`;
}

function truncateRecapContent(value: string): string {
  if (value.length <= maxRecapContentLength) {
    return value;
  }

  return `${value.slice(0, maxRecapContentLength - 4).trimEnd()}\n...`;
}

function hasForbiddenProviderMention(value: string): boolean {
  return /\b(Gemini|OpenAI|GPT|ChatGPT|KI|Künstliche Intelligenz|Modell|Google Search|Websuche|Grounding)\b/iu.test(value);
}

function hasPollSentimentLabel(value: string): boolean {
  return /\b(?:Risk-on|Risk-off|Cash|Chaos)\b/iu.test(value);
}

function hasForbiddenMarketProxyMention(value: string): boolean {
  return /\b(?:SPX|SPY|NDX|RUT|QQQ|IWM)\b/iu.test(value);
}

function hasVixPercent(value: string): boolean {
  return /\bVIX\b[^\n.?!;:]*[+-]?\d+(?:[,.]\d+)?\s*%/iu.test(value);
}

function isMarketCloseSentimentAnswer(value: unknown): value is MarketCloseSentimentAnswer {
  return "Risk-on" === value ||
    "Risk-off" === value ||
    "Cash" === value ||
    "Chaos" === value;
}

function isPollAnswerLike(value: unknown): value is PollAnswerLike {
  if (false === isRecord(value)) {
    return false;
  }

  return undefined !== getPollAnswerText(value) || undefined !== getPollAnswerId(value);
}

function getPollAnswerText(answer: unknown): string | undefined {
  if (false === isRecord(answer)) {
    return undefined;
  }

  for (const textContainer of [answer, answer["poll_media"], answer["pollMedia"], answer["media"]]) {
    if (false === isRecord(textContainer)) {
      continue;
    }

    const text = textContainer["text"];
    if ("string" === typeof text) {
      return text;
    }
  }

  return undefined;
}

function getPollAnswerId(answer: unknown): number | undefined {
  if (false === isRecord(answer)) {
    return undefined;
  }

  const id = answer["id"];
  if ("number" === typeof id && Number.isFinite(id)) {
    return id;
  }

  const answerId = answer["answer_id"];
  if ("number" === typeof answerId && Number.isFinite(answerId)) {
    return answerId;
  }

  const camelCaseAnswerId = answer["answerId"];
  if ("number" === typeof camelCaseAnswerId && Number.isFinite(camelCaseAnswerId)) {
    return camelCaseAnswerId;
  }

  return undefined;
}

function normalizePollAnswerText(value: string | undefined): string {
  return value
    ?.replace(/[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu, "")
    .replace(/[‐‑‒–—―]/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase() ?? "";
}

function isPollMessageLike(value: unknown): value is PollMessageLike {
  return isRecord(value) && "poll" in value;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}
