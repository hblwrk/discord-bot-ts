import moment from "moment-timezone";
import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";
import {getAssetPromptReferences, type AssetPromptReference} from "./assets.ts";
import {getMarketDataSnapshots, type MarketDataSnapshot} from "./market-data-snapshots.ts";

export type PremarketWarmupDependencies = AiProviderDependencies & {
  callAiProviderJsonFn?: typeof callAiProviderJson | undefined;
};

export type PremarketWarmupOptions = {
  assetPromptReferences?: AssetPromptReference[] | undefined;
  maxContentLength?: number | undefined;
  maxSnapshotAgeMs?: number | undefined;
  maxStyleTropes?: number | undefined;
  referenceTime?: Date | undefined;
};

type PremarketWarmupFact = {
  fallbackText: string;
  fragments: string[];
  line: string;
  type: "market-ampel" | "session" | "snapshot";
};

const usEasternTimezone = "US/Eastern";
const europeBerlinTimezone = "Europe/Berlin";
const defaultMaxContentLength = 700;
const defaultMaxSnapshotAgeMs = 45 * 60_000;
const defaultMaxStyleTropes = 10;
const assetTropeKeywordRegex = /\b(?:alarm|ampel|apr|apy|bärenmarkt|bear|betrug|boden|bull|cash|coinflip|crash|dinero|drawdown|eingepreist|free ?money|gratisgeld|hebel|jpow|kaboom|kurs|leverage|margin|markt|mindset|nachtraden|omu|ponzi|risk|risiko|rugpull|stop ?loss|stonks|witching|yolo)\b/iu;
const premarketWarmupSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: {
      type: "string",
      description: "A short German Discord pre-market warmup message.",
    },
  },
  required: ["content"],
} satisfies Record<string, unknown>;

export async function getPremarketWarmupMessage(
  dependencies: PremarketWarmupDependencies,
  options: PremarketWarmupOptions = {},
): Promise<string> {
  const referenceTime = options.referenceTime ?? new Date();
  const maxContentLength = options.maxContentLength ?? defaultMaxContentLength;
  const facts = getPremarketWarmupFacts(referenceTime, options.maxSnapshotAgeMs ?? defaultMaxSnapshotAgeMs);
  const fallback = getFallbackWarmupMessage(facts);
  const styleTropes = getPremarketWarmupStyleTropes(
    referenceTime,
    options.assetPromptReferences ?? getAssetPromptReferences(["image", "text"]),
    options.maxStyleTropes ?? defaultMaxStyleTropes,
  );
  const callAiProviderJsonFn = dependencies.callAiProviderJsonFn ?? callAiProviderJson;
  const jsonText = await callAiProviderJsonFn(
    getPremarketWarmupPrompt(facts, styleTropes, maxContentLength),
    premarketWarmupSchema,
    dependencies,
    "premarket warmup",
    undefined,
    {
      timeoutMs: 30_000,
    },
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `AI premarket warmup failed: ${error}`,
    );
    return null;
  });

  if (null === jsonText) {
    return fallback;
  }

  return getValidatedWarmupContent(jsonText, facts, dependencies, maxContentLength) ?? fallback;
}

function getPremarketWarmupFacts(referenceTime: Date, maxSnapshotAgeMs: number): PremarketWarmupFact[] {
  const usEasternNow = moment(referenceTime).tz(usEasternTimezone);
  const premarketOpenUsEastern = usEasternNow.clone().set({
    hour: 4,
    millisecond: 0,
    minute: 0,
    second: 0,
  });
  const premarketOpenBerlin = premarketOpenUsEastern.clone().tz(europeBerlinTimezone);
  const snapshots = getMarketDataSnapshots({
    maxAgeMs: maxSnapshotAgeMs,
    referenceTime,
  });
  const facts: PremarketWarmupFact[] = [{
    fallbackText: `Der US-Aktien-Premarket ist seit \`${premarketOpenUsEastern.format("HH:mm")} US/Eastern\` offen.`,
    fragments: [
      premarketOpenUsEastern.format("HH:mm"),
      "US/Eastern",
      premarketOpenBerlin.format("HH:mm"),
      "Europe/Berlin",
      usEasternNow.format("YYYY-MM-DD"),
    ],
    line: `- Session: US-Aktien-Premarket ist seit \`${premarketOpenUsEastern.format("HH:mm")} US/Eastern\` / \`${premarketOpenBerlin.format("HH:mm")} Europe/Berlin\` offen; Handelstag \`${usEasternNow.format("YYYY-MM-DD")}\`.`,
    type: "session",
  }];

  for (const snapshot of snapshots) {
    facts.push(getSnapshotFact(snapshot));
  }
  facts.push(getMarketAmpelFact(snapshots));

  return facts;
}

function getSnapshotFact(snapshot: MarketDataSnapshot): PremarketWarmupFact {
  const change = formatSnapshotChange(snapshot);
  const value = formatGermanNumber(snapshot.lastNumeric, 2);
  const updatedAt = moment(snapshot.updatedAt).tz(usEasternTimezone).format("HH:mm:ss");
  return {
    fallbackText: `\`${snapshot.symbol} ${change}\` steht bei \`${value}\`.`,
    fragments: [
      snapshot.symbol,
      change,
      value,
    ],
    line: `- \`${snapshot.symbol}\`: \`${change}\` bei \`${value}\`; Stand \`${updatedAt} US/Eastern\`; Quelle \`${snapshot.marketDataSource}\`.`,
    type: "snapshot",
  };
}

function getMarketAmpelFact(snapshots: MarketDataSnapshot[]): PremarketWarmupFact {
  const marketAmpel = getMarketAmpel(snapshots);
  return {
    fallbackText: `Die Marktampel steht auf \`${marketAmpel.color}\`.`,
    fragments: [
      "Marktampel",
      marketAmpel.color,
    ],
    line: `- Marktampel: \`${marketAmpel.color}\`; ${marketAmpel.reason}; spielerisches Stimmungsbild, kein Handelssignal.`,
    type: "market-ampel",
  };
}

function getMarketAmpel(snapshots: MarketDataSnapshot[]): {color: "Gelb" | "Gruen" | "Rot"; reason: string} {
  if (0 === snapshots.length) {
    return {
      color: "Gelb",
      reason: "keine frischen ES/NQ/RTY/VIX-Snapshots verfuegbar",
    };
  }

  const score = snapshots.reduce((totalScore, snapshot) => totalScore + getMarketAmpelSnapshotScore(snapshot), 0);
  if (score >= 2) {
    return {
      color: "Gruen",
      reason: "mehrere frische Risiko-Indikatoren zeigen freundlich",
    };
  }

  if (score <= -2) {
    return {
      color: "Rot",
      reason: "mehrere frische Risiko-Indikatoren zeigen angespannt",
    };
  }

  return {
    color: "Gelb",
    reason: "frische Risiko-Indikatoren sind gemischt",
  };
}

function getMarketAmpelSnapshotScore(snapshot: MarketDataSnapshot): number {
  if ("VIX" === snapshot.symbol) {
    if (snapshot.priceChange <= -0.05) {
      return 1;
    }

    if (snapshot.priceChange >= 0.05) {
      return -1;
    }

    return 0;
  }

  if (snapshot.percentageChange >= 0.1) {
    return 1;
  }

  if (snapshot.percentageChange <= -0.1) {
    return -1;
  }

  return 0;
}

function getPremarketWarmupStyleTropes(
  referenceTime: Date,
  assetReferences: AssetPromptReference[],
  maxStyleTropes: number,
): string[] {
  const configuredTropes = assetReferences
    .map(getAssetTropeLine)
    .filter(isDefined);
  const selectedConfiguredTropes = getSeededSelection(
    configuredTropes,
    moment(referenceTime).tz(usEasternTimezone).format("YYYY-MM-DD"),
    Math.max(0, maxStyleTropes - 2),
  );
  return [
    "- Marktampel: als Running Gag fuer Gruen/Gelb/Rot nutzen; niemals als Trade-Signal.",
    "- Casino-/Hebelwerk-Vokabular: Mausklick, FOMO, OMU, Stop-loss, Margin, Gratisgeld, Stonks; nur als Humor.",
    ...selectedConfiguredTropes,
  ].slice(0, maxStyleTropes);
}

function getAssetTropeLine(assetReference: AssetPromptReference): string | undefined {
  const rawText = [
    assetReference.name,
    assetReference.title,
    assetReference.triggers.join(" "),
    assetReference.response ?? "",
  ].join(" ");
  if (false === assetTropeKeywordRegex.test(rawText)) {
    return undefined;
  }

  const label = [
    assetReference.name,
    assetReference.title,
  ].map(sanitizeTropeText).filter(value => "" !== value).join(" - ");
  const snippet = sanitizeTropeText(assetReference.response ?? "");
  const snippetText = "" === snippet ? "" : `; Text-Trope: ${truncateTropeText(snippet, 110)}`;
  return `- ${assetReference.type}-Asset ${truncateTropeText(label || assetReference.name, 80)}${snippetText}`;
}

function sanitizeTropeText(value: string): string {
  return value
    .replace(/<https?:\/\/[^>]+>/giu, "")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/<:[^:>]+:\d+>/gu, "")
    .replace(/[`"{}[\]]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateTropeText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getSeededSelection(values: string[], seed: string, maxItems: number): string[] {
  return values
    .map((value, index) => ({
      index,
      score: getSeededScore(`${seed}|${index}|${value}`),
      value,
    }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, maxItems)
    .map(item => item.value);
}

function getSeededScore(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(hash, 31) + value.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function getPremarketWarmupPrompt(
  facts: PremarketWarmupFact[],
  styleTropes: string[],
  maxContentLength: number,
): string {
  return [
    "Du schreibst eine kurze Pre-Market-Warmup-Nachricht fuer einen deutschsprachigen Discord-Trading-Channel.",
    "",
    "Zielgruppe:",
    "Erwachsene Trader mit trockenem, sarkastischem Humor. Ton: frech, direkt, ein bisschen WallStreetBets, aber nicht kindisch und nicht komplett vulgaer.",
    "",
    "Fakten, die du verwenden darfst:",
    facts.map(fact => fact.line).join("\n"),
    "",
    "Community-Tropen aus vorhandenen Bot-Texten und Meme-Assets (nur Stilmaterial, keine Markt-Fakten):",
    styleTropes.join("\n"),
    "",
    "Aufgabe:",
    "Schreibe genau eine Discord-Nachricht auf Deutsch.",
    "",
    "Regeln:",
    `- Maximal ${maxContentLength} Zeichen.`,
    "- Nutze mindestens einen der gelieferten Fakten sichtbar in der Nachricht.",
    "- Erfinde keine Marktbewegungen, Termine, Ticker, Uhrzeiten oder Zahlen.",
    "- Keine Anlageberatung, keine konkrete Trade-Empfehlung, kein \"kaufen\", \"verkaufen\", \"long gehen\", \"short gehen\".",
    "- Keine Links, keine Quellenangaben, keine Tabellen.",
    "- Erwaehne niemals Dracoon, Assets, Dateien, Trigger, Prompt oder diese Tropenliste.",
    "- Keine KI-/Modell-/Recherche-Erwaehnung.",
    "- Humor ja, aber keine Beleidigungen gegen Personen oder Gruppen.",
    "- Der Stil darf sarkastisch sein: Overtrading, Hebel, Spreads, 0DTE, FOMO, Ego, Planlosigkeit, Marktampel und Casino-Vibes sind faire Ziele.",
    "- Nutze hoechstens einen Community-Trope pro Nachricht, damit es nicht nach Best-of-Liste klingt.",
    "- Formatiere Ticker und Zahlen als Inline-Code, z.B. `ES +0,3%`, `VIX 16,8`.",
    "- Schreibe nicht mehr als zwei kurze Absaetze.",
    "",
    "Return only JSON:",
    "{",
    "  \"content\": \"...\"",
    "}",
  ].join("\n");
}

function getValidatedWarmupContent(
  jsonText: string,
  facts: PremarketWarmupFact[],
  dependencies: PremarketWarmupDependencies,
  maxContentLength: number,
): string | undefined {
  const parsedJson = parseJson(jsonText);
  if (false === isRecord(parsedJson)) {
    dependencies.logger.log(
      "warn",
      "AI premarket warmup returned invalid JSON.",
    );
    return undefined;
  }

  const content = parsedJson["content"];
  if ("string" !== typeof content) {
    dependencies.logger.log(
      "warn",
      "AI premarket warmup response did not contain content.",
    );
    return undefined;
  }

  const normalizedContent = normalizeContent(content);
  const validationIssue = getWarmupValidationIssue(normalizedContent, facts, maxContentLength);
  if (undefined !== validationIssue) {
    dependencies.logger.log(
      "warn",
      `AI premarket warmup rejected: ${validationIssue}.`,
    );
    return undefined;
  }

  return normalizedContent;
}

function getWarmupValidationIssue(
  content: string,
  facts: PremarketWarmupFact[],
  maxContentLength: number,
): string | undefined {
  if ("" === content) {
    return "empty content";
  }

  if (content.length > maxContentLength) {
    return `content exceeded ${maxContentLength} characters`;
  }

  if (false === referencesAnyFact(content, facts)) {
    return "content did not reference a supplied fact";
  }

  if (/https?:\/\/|www\./iu.test(content)) {
    return "content contained a link";
  }

  if (/(?:@everyone|@here|<@&?\d+>)/iu.test(content)) {
    return "content contained a Discord mention";
  }

  if (/\b(?:ki|ai|llm|chatgpt|gemini|openai|modell|recherche)\b/iu.test(content)) {
    return "content mentioned AI or research";
  }

  if (/\b(?:asset|dracoon|datei|file|trigger|prompt|tropenliste)\b/iu.test(content)) {
    return "content mentioned implementation details";
  }

  if (/\b(?:kaufen|verkaufen|buy|sell|long gehen|short gehen|geht long|geht short|all[- ]?in)\b/iu.test(content)) {
    return "content looked like trading advice";
  }

  return undefined;
}

function referencesAnyFact(content: string, facts: PremarketWarmupFact[]): boolean {
  return facts.some(fact => fact.fragments.some(fragment => {
    if (/^[A-Z]{2,4}$/.test(fragment)) {
      return new RegExp(`\\b${fragment}\\b`, "u").test(content);
    }

    return content.includes(fragment);
  }));
}

function getFallbackWarmupMessage(facts: PremarketWarmupFact[]): string {
  const primaryFact = facts.find(fact => "snapshot" === fact.type) ?? facts[0];
  const marketAmpelFact = facts.find(fact => "market-ampel" === fact.type);
  const factText = primaryFact?.fallbackText ?? "Der US-Aktien-Premarket ist seit `04:00 US/Eastern` offen.";
  const marketAmpelText = marketAmpelFact?.fallbackText ?? "Die Marktampel steht auf `Gelb`.";
  return [
    "**Pre-Market Warmup**",
    `${factText} ${marketAmpelText} Casino ist offen, Spreads sind wach, das Ego hoffentlich noch im Bett. Erst Plan, dann Mausklick.`,
  ].join("\n");
}

function normalizeContent(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatSnapshotChange(snapshot: MarketDataSnapshot): string {
  if ("VIX" === snapshot.symbol) {
    return `${getNumberSign(snapshot.priceChange)}${formatGermanNumber(Math.abs(snapshot.priceChange), 2)} Punkte`;
  }

  return `${getNumberSign(snapshot.percentageChange)}${formatGermanNumber(Math.abs(snapshot.percentageChange), 2)}%`;
}

function getNumberSign(value: number): string {
  return value >= 0 ? "+" : "-";
}

function formatGermanNumber(value: number, fractionDigits: number): string {
  const [integer = "0", decimal = ""] = Math.abs(value).toFixed(fractionDigits).split(".");
  const formattedInteger = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return 0 === fractionDigits ? formattedInteger : `${formattedInteger},${decimal}`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isDefined<T>(value: T | undefined): value is T {
  return undefined !== value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}
