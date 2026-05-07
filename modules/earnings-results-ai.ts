import {type EarningsEvent} from "./earnings.ts";
import {
  formatEps,
  formatMoneyCompact,
  htmlToText,
  type EarningsResultMetric,
  type NasdaqSurprise,
} from "./earnings-results-format.ts";
import {callAiProviderJson, clearAiProviderState, type AiProviderDependencies} from "./ai-provider.ts";

type EarningsAiDependencies = AiProviderDependencies;

export type EarningsAiExtractionInput = {
  companyName: string;
  filingForm: string;
  filingUrl: string;
  html: string;
  ticker: string;
};

export type EarningsAiExtraction = {
  issues: string[];
  metrics: EarningsResultMetric[];
  quarterLabel?: string | undefined;
};

export type SuspiciousEarningsReason = {
  message: string;
  metricKey?: string | undefined;
  severity: "high" | "medium";
};

export type EarningsAiQualityGateInput = {
  companyName: string;
  event: EarningsEvent;
  filingForm: string;
  filingUrl: string;
  html: string;
  message: string;
  metrics: EarningsResultMetric[];
  reasons: SuspiciousEarningsReason[];
  surprise: NasdaqSurprise | null;
  ticker: string;
};

export type EarningsAiQualityGateResult = {
  confidence: number;
  decision: "allow" | "suppress";
  issues: EarningsAiQualityIssue[];
  reason: string;
};

type EarningsAiQualityIssue = {
  message: string;
  metricKey?: string | undefined;
  severity: "high" | "medium" | "low";
  sourceSnippet: string;
};

type AiMetricKey = "adjusted_eps" | "gaap_eps" | "revenue" | "net_income";

type AiMetricDefinition = {
  key: AiMetricKey;
  label: string;
  valueType: "eps" | "money";
};

const maxAiFilingTextLength = 10_000;
const aiRelevantContextBeforeLines = 2;
const aiRelevantContextAfterLines = 4;

const aiMetricDefinitions = new Map<AiMetricKey, AiMetricDefinition>([
  ["adjusted_eps", {
    key: "adjusted_eps",
    label: "Adj EPS",
    valueType: "eps",
  }],
  ["gaap_eps", {
    key: "gaap_eps",
    label: "EPS",
    valueType: "eps",
  }],
  ["revenue", {
    key: "revenue",
    label: "Revenue",
    valueType: "money",
  }],
  ["net_income", {
    key: "net_income",
    label: "Net income",
    valueType: "money",
  }],
]);

const earningsExtractionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    quarterLabel: {
      type: ["string", "null"],
      description: "Reported quarter as Q1 2026, Q2 2026, Q3 2026, or Q4 2026 when explicit in the filing.",
    },
    metrics: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: {
            type: "string",
            enum: ["adjusted_eps", "gaap_eps", "revenue", "net_income"],
          },
          numericValue: {
            type: "number",
            description: "EPS in currency units per share. Revenue and net income in full currency units after applying table scale.",
          },
          currencyCode: {
            type: "string",
            description: "ISO currency code. Use USD when the filing says dollars or uses $.",
          },
          sourceSnippet: {
            type: "string",
            description: "Short exact snippet from the provided filing text proving the value and scale.",
          },
        },
        required: ["key", "numericValue", "currencyCode", "sourceSnippet"],
      },
    },
    issues: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
  required: ["quarterLabel", "metrics", "issues"],
} satisfies Record<string, unknown>;

const qualityGateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      type: "string",
      enum: ["allow", "suppress"],
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
    },
    reason: {
      type: "string",
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          severity: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
          metricKey: {
            type: ["string", "null"],
            enum: ["adjusted_eps", "gaap_eps", "revenue", "net_income", "nasdaq_eps", null],
          },
          message: {
            type: "string",
          },
          sourceSnippet: {
            type: "string",
            description: "Short exact snippet from the provided filing text supporting the issue or allow decision.",
          },
        },
        required: ["severity", "metricKey", "message", "sourceSnippet"],
      },
    },
  },
  required: ["decision", "confidence", "reason", "issues"],
} satisfies Record<string, unknown>;

export function clearEarningsAiState() {
  clearAiProviderState();
}

export async function extractEarningsWithAi(
  input: EarningsAiExtractionInput,
  dependencies: EarningsAiDependencies,
): Promise<EarningsAiExtraction | null> {
  const sourceText = getRelevantFilingText(input.html);
  if ("" === sourceText) {
    return null;
  }

  const prompt = getExtractionPrompt(input, sourceText);
  const jsonText = await callAiProviderJson(
    prompt,
    earningsExtractionSchema,
    dependencies,
    `earnings extraction for ${input.ticker}`,
  )
    .catch(error => {
      dependencies.logger.log(
        "warn",
        `AI earnings extraction failed for ${input.ticker}: ${error}`,
      );
      return null;
    });
  if (null === jsonText) {
    return null;
  }

  const parsedJson = parseJson(jsonText);
  if (null === parsedJson) {
    dependencies.logger.log(
      "warn",
      `AI earnings extraction returned invalid JSON for ${input.ticker}.`,
    );
    return null;
  }

  return parseAiExtraction(parsedJson, htmlToText(input.html));
}

export async function checkEarningsQualityWithAi(
  input: EarningsAiQualityGateInput,
  dependencies: EarningsAiDependencies,
): Promise<EarningsAiQualityGateResult | null> {
  if (0 === input.reasons.length) {
    return {
      confidence: 1,
      decision: "allow",
      issues: [],
      reason: "No suspicious earnings metrics detected.",
    };
  }

  const sourceText = getRelevantFilingText(input.html);
  if ("" === sourceText) {
    return null;
  }

  const prompt = getQualityGatePrompt(input, sourceText);
  const jsonText = await callAiProviderJson(
    prompt,
    qualityGateSchema,
    dependencies,
    `earnings quality gate for ${input.ticker}`,
  )
    .catch(error => {
      dependencies.logger.log(
        "warn",
        `AI earnings quality gate failed for ${input.ticker}: ${error}`,
      );
      return null;
    });
  if (null === jsonText) {
    return null;
  }

  const parsedJson = parseJson(jsonText);
  if (null === parsedJson) {
    dependencies.logger.log(
      "warn",
      `AI earnings quality gate returned invalid JSON for ${input.ticker}.`,
    );
    return null;
  }

  return parseQualityGate(parsedJson, htmlToText(input.html));
}

export function mergeAiMetrics(
  deterministicMetrics: EarningsResultMetric[],
  aiMetrics: EarningsResultMetric[],
  suspiciousReasons: SuspiciousEarningsReason[],
): EarningsResultMetric[] {
  if (0 === aiMetrics.length) {
    return deterministicMetrics;
  }

  const suspiciousMetricKeys = new Set(suspiciousReasons.flatMap(reason =>
    undefined === reason.metricKey ? [] : [reason.metricKey],
  ));
  const metricsByKey = new Map<string, EarningsResultMetric>();
  for (const metric of deterministicMetrics) {
    metricsByKey.set(metric.key, metric);
  }

  for (const metric of aiMetrics) {
    if (false === metricsByKey.has(metric.key) || true === suspiciousMetricKeys.has(metric.key)) {
      metricsByKey.set(metric.key, metric);
    }
  }

  return sortEarningsMetrics([...metricsByKey.values()]);
}

export function getSuspiciousEarningsReasons(
  metrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
  event: EarningsEvent,
): SuspiciousEarningsReason[] {
  const reasons: SuspiciousEarningsReason[] = [];
  const consensusEps = surprise?.consensusEps ?? getNumericEventEpsConsensus(event);
  const epsMetric = metrics.find(metric => "adjusted_eps" === metric.key) ??
    metrics.find(metric => "gaap_eps" === metric.key || "nasdaq_eps" === metric.key);
  if (undefined !== epsMetric &&
      "number" === typeof epsMetric.numericValue &&
      true === Number.isFinite(epsMetric.numericValue) &&
      "number" === typeof consensusEps &&
      true === Number.isFinite(consensusEps)) {
    const absoluteConsensus = Math.abs(consensusEps);
    const absoluteEps = Math.abs(epsMetric.numericValue);
    if (absoluteEps >= 20 && absoluteConsensus < 5) {
      reasons.push({
        message: `${epsMetric.label} ${epsMetric.value} is extremely far from consensus ${formatEps(consensusEps)}.`,
        metricKey: epsMetric.key,
        severity: "high",
      });
    } else if (absoluteEps >= 10 && absoluteConsensus < 5) {
      reasons.push({
        message: `${epsMetric.label} ${epsMetric.value} is unusually far from consensus ${formatEps(consensusEps)}.`,
        metricKey: epsMetric.key,
        severity: "medium",
      });
    }
  }

  const revenueMetric = metrics.find(metric => "revenue" === metric.key);
  if (undefined !== revenueMetric &&
      "number" === typeof revenueMetric.numericValue &&
      "number" === typeof surprise?.consensusRevenue &&
      surprise.consensusRevenue > 0) {
    const ratio = revenueMetric.numericValue / surprise.consensusRevenue;
    if (ratio >= 20 || ratio <= 0.05) {
      reasons.push({
        message: `Revenue ${revenueMetric.value} is far from consensus ${formatMoneyCompact(surprise.consensusRevenue)}.`,
        metricKey: "revenue",
        severity: "high",
      });
    } else if (ratio >= 10 || ratio <= 0.1) {
      reasons.push({
        message: `Revenue ${revenueMetric.value} is unusually far from consensus ${formatMoneyCompact(surprise.consensusRevenue)}.`,
        metricKey: "revenue",
        severity: "medium",
      });
    }
  }

  if (undefined !== revenueMetric &&
      "number" === typeof revenueMetric.numericValue &&
      "number" === typeof event.marketCap &&
      event.marketCap >= 10_000_000_000 &&
      revenueMetric.numericValue > 0 &&
      revenueMetric.numericValue < 1_000_000) {
    reasons.push({
      message: `Revenue ${revenueMetric.value} is below $1M for a large-cap scheduled earnings event.`,
      metricKey: "revenue",
      severity: "medium",
    });
  }

  const netIncomeMetric = metrics.find(metric => "net_income" === metric.key);
  if (undefined !== revenueMetric &&
      undefined !== netIncomeMetric &&
      "number" === typeof revenueMetric.numericValue &&
      "number" === typeof netIncomeMetric.numericValue &&
      netIncomeMetric.numericValue > 0) {
    if (revenueMetric.numericValue <= 0) {
      reasons.push({
        message: `Revenue ${revenueMetric.value} is not positive while net income ${netIncomeMetric.value} is positive.`,
        metricKey: "revenue",
        severity: "high",
      });
    } else if (revenueMetric.numericValue < netIncomeMetric.numericValue) {
      reasons.push({
        message: `Revenue ${revenueMetric.value} is lower than net income ${netIncomeMetric.value}.`,
        metricKey: "revenue",
        severity: revenueMetric.numericValue <= netIncomeMetric.numericValue * 0.5 ? "high" : "medium",
      });
    }
  }

  if (undefined !== netIncomeMetric &&
      "number" === typeof netIncomeMetric.numericValue &&
      "number" === typeof event.marketCap &&
      Math.abs(netIncomeMetric.numericValue) > event.marketCap * 2) {
    reasons.push({
      message: `Net income ${netIncomeMetric.value} is larger than two times the company's market cap.`,
      metricKey: "net_income",
      severity: "high",
    });
  }

  return reasons;
}

export function hasHighSeveritySuspicion(reasons: SuspiciousEarningsReason[]): boolean {
  return reasons.some(reason => "high" === reason.severity);
}

function getExtractionPrompt(input: EarningsAiExtractionInput, sourceText: string): string {
  return [
    "Extract the main quarterly earnings metrics from this public SEC earnings release.",
    "Return only JSON matching the schema. Do not include markdown.",
    "Rules:",
    "- Extract only values for the reported quarter, not year-to-date totals, prior-year periods, dates, footnotes, page numbers, share counts, percentages, or outlook.",
    "- Revenue and net income numericValue must be full currency units after applying table scale such as thousands, millions, or billions.",
    "- Omit revenue when the filing excerpt does not explicitly report revenue, revenues, net sales, or third-party revenue.",
    "- Do not use Adjusted EBITDA, sales volumes, production, cash flow, or a zero placeholder as revenue.",
    "- EPS numericValue must be currency units per share. Convert cents to dollars, e.g. 77 cents becomes 0.77.",
    "- Include adjusted EPS only when explicitly non-GAAP/adjusted. Include GAAP EPS only when explicitly GAAP/diluted/basic EPS.",
    "- Every metric must include a short exact sourceSnippet from the filing text that proves the metric and scale.",
    `Company: ${input.companyName}`,
    `Ticker: ${input.ticker}`,
    `Filing: ${input.filingForm} ${input.filingUrl}`,
    "Filing text:",
    sourceText,
  ].join("\n");
}

function getQualityGatePrompt(input: EarningsAiQualityGateInput, sourceText: string): string {
  const metricLines = input.metrics.map(metric =>
    `${metric.key}: ${metric.value}${metric.estimate ? ` vs estimate ${metric.estimate}` : ""}`,
  );
  const reasonLines = input.reasons.map(reason => `${reason.severity}: ${reason.message}`);
  return [
    "Review this pending Discord earnings post against the SEC filing text.",
    "Return only JSON matching the schema. Do not include markdown.",
    "Suppress only when a main metric is likely a parsing bug, such as a footnote/date fragment, a cents value treated as dollars, a table scale mistake, or a value copied from the wrong period.",
    "Allow when the post is plausible or the filing text supports the values.",
    "Every issue must include a short exact sourceSnippet from the filing text.",
    `Company: ${input.companyName}`,
    `Ticker: ${input.ticker}`,
    `Filing: ${input.filingForm} ${input.filingUrl}`,
    "Suspicious checks:",
    ...reasonLines,
    "Pending metrics:",
    ...metricLines,
    "Pending message:",
    input.message,
    "Filing text:",
    sourceText,
  ].join("\n");
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseAiExtraction(value: unknown, sourceText: string): EarningsAiExtraction | null {
  if (false === isRecord(value)) {
    return null;
  }

  const issues = getArray(value["issues"]).flatMap(issue =>
    "string" === typeof issue && "" !== issue.trim() ? [issue.trim()] : [],
  );
  const metrics = getArray(value["metrics"]).flatMap(metricValue => {
    const metric = parseAiMetric(metricValue, sourceText);
    return null === metric || true === isContradictedByExtractionIssues(metric, issues) ? [] : [metric];
  });
  const quarterLabel = parseQuarterLabel(value["quarterLabel"]);
  const result: EarningsAiExtraction = {
    issues,
    metrics: sortEarningsMetrics(dedupeMetrics(metrics)),
  };
  if (undefined !== quarterLabel) {
    result.quarterLabel = quarterLabel;
  }

  return result;
}

function parseAiMetric(value: unknown, sourceText: string): EarningsResultMetric | null {
  if (false === isRecord(value)) {
    return null;
  }

  const key = parseMetricKey(value["key"]);
  const numericValue = value["numericValue"];
  const currencyCode = normalizeCurrencyCode(value["currencyCode"]);
  const sourceSnippet = "string" === typeof value["sourceSnippet"]
    ? value["sourceSnippet"].trim()
    : "";
  if (null === key ||
      "number" !== typeof numericValue ||
      false === Number.isFinite(numericValue) ||
      undefined === currencyCode ||
      false === hasSourceSnippet(sourceText, sourceSnippet)) {
    return null;
  }

  const definition = aiMetricDefinitions.get(key);
  if (undefined === definition) {
    return null;
  }

  if ("eps" === definition.valueType && Math.abs(numericValue) > 100) {
    return null;
  }

  if ("revenue" === key && (0 === numericValue || false === isRevenueEvidenceSnippet(sourceSnippet))) {
    return null;
  }

  if ("money" === definition.valueType && Math.abs(numericValue) > 20_000_000_000_000) {
    return null;
  }

  return {
    currencyCode,
    key: definition.key,
    label: definition.label,
    numericValue,
    sourceSnippet,
    value: "eps" === definition.valueType
      ? formatEps(numericValue, currencyCode)
      : formatMoneyCompact(numericValue, currencyCode),
  };
}

function isRevenueEvidenceSnippet(sourceSnippet: string): boolean {
  if (/\b(?:adjusted\s+ebitda|sales\s+volumes?|production|cash\s+flow)\b/i.test(sourceSnippet)) {
    return false;
  }

  return /\b(?:revenues?|net\s+sales|third-party\s+revenue|total\s+revenue)\b/i.test(sourceSnippet);
}

function isContradictedByExtractionIssues(metric: EarningsResultMetric, issues: string[]): boolean {
  if ("revenue" !== metric.key) {
    return false;
  }

  return issues.some(issue =>
    /\b(?:no|not|without|missing|unable|could\s+not|does\s+not)\b.{0,120}\b(?:revenues?|sales)\b/i.test(issue) ||
    /\b(?:revenues?|sales)\b.{0,120}\b(?:no|not|missing|unable|could\s+not|incorrect|not\s+directly|not\s+explicitly)\b/i.test(issue),
  );
}

function parseQualityGate(value: unknown, sourceText: string): EarningsAiQualityGateResult | null {
  if (false === isRecord(value)) {
    return null;
  }

  const decision = value["decision"];
  const confidence = value["confidence"];
  const reason = value["reason"];
  if (("allow" !== decision && "suppress" !== decision) ||
      "number" !== typeof confidence ||
      false === Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      "string" !== typeof reason ||
      "" === reason.trim()) {
    return null;
  }

  const issues = getArray(value["issues"]).flatMap(issueValue => {
    const issue = parseQualityIssue(issueValue, sourceText);
    return null === issue ? [] : [issue];
  });
  if ("suppress" === decision && 0 === issues.length) {
    return null;
  }

  return {
    confidence,
    decision,
    issues,
    reason: reason.trim(),
  };
}

function parseQualityIssue(value: unknown, sourceText: string): EarningsAiQualityIssue | null {
  if (false === isRecord(value)) {
    return null;
  }

  const severity = value["severity"];
  const metricKey = value["metricKey"];
  const message = value["message"];
  const sourceSnippet = value["sourceSnippet"];
  if (("high" !== severity && "medium" !== severity && "low" !== severity) ||
      "string" !== typeof message ||
      "" === message.trim() ||
      "string" !== typeof sourceSnippet ||
      false === hasSourceSnippet(sourceText, sourceSnippet)) {
    return null;
  }

  const issue: EarningsAiQualityIssue = {
    message: message.trim(),
    severity,
    sourceSnippet: sourceSnippet.trim(),
  };
  if ("string" === typeof metricKey && "" !== metricKey.trim()) {
    issue.metricKey = metricKey.trim();
  }

  return issue;
}

function parseMetricKey(value: unknown): AiMetricKey | null {
  if ("string" !== typeof value) {
    return null;
  }

  return aiMetricDefinitions.has(value as AiMetricKey)
    ? value as AiMetricKey
    : null;
}

function parseQuarterLabel(value: unknown): string | undefined {
  if ("string" !== typeof value) {
    return undefined;
  }

  const normalizedValue = value.trim().toUpperCase();
  return /^Q[1-4]\s+20\d{2}$/.test(normalizedValue)
    ? normalizedValue.replace(/\s+/, " ")
    : undefined;
}

function normalizeCurrencyCode(value: unknown): string | undefined {
  if ("string" !== typeof value) {
    return undefined;
  }

  const normalizedValue = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalizedValue) ? normalizedValue : undefined;
}

function hasSourceSnippet(sourceText: string, sourceSnippet: string): boolean {
  const normalizedSnippet = normalizeEvidenceText(sourceSnippet);
  if (normalizedSnippet.length < 12) {
    return false;
  }

  return normalizeEvidenceText(sourceText).includes(normalizedSnippet);
}

function normalizeEvidenceText(value: string): string {
  return value
    .replace(/\s*\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getRelevantFilingText(html: string): string {
  const text = htmlToText(html);
  const lines = text
    .split("\n")
    .map(line => line.replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 3);
  if (0 === lines.length) {
    return "";
  }

  const selectedLineIndexes = new Set<number>();
  for (const [lineIndex, line] of lines.entries()) {
    if (false === isAiRelevantLine(line)) {
      continue;
    }

    for (
      let index = Math.max(0, lineIndex - aiRelevantContextBeforeLines);
      index <= Math.min(lines.length - 1, lineIndex + aiRelevantContextAfterLines);
      index++
    ) {
      selectedLineIndexes.add(index);
    }
  }

  const selectedLines = [...selectedLineIndexes]
    .sort((first, second) => first - second)
    .map(lineIndex => lines[lineIndex])
    .filter((line): line is string => undefined !== line);
  const selectedText = selectedLines.join("\n").trim();
  return truncateAiText("" === selectedText ? lines.join("\n") : selectedText);
}

function isAiRelevantLine(line: string): boolean {
  return /\b(?:earnings|results?|revenue|sales|net\s+income|net\s+earnings|eps|per\s+share|guidance|outlook|forecast|quarter|fiscal)\b/i.test(line);
}

function truncateAiText(value: string): string {
  if (value.length <= maxAiFilingTextLength) {
    return value;
  }

  const truncatedValue = value.slice(0, maxAiFilingTextLength);
  const lastLineBreak = truncatedValue.lastIndexOf("\n");
  const excerpt = lastLineBreak > 0
    ? truncatedValue.slice(0, lastLineBreak)
    : truncatedValue;
  return `${excerpt.trimEnd()}\n[truncated]`;
}

function getNumericEventEpsConsensus(event: EarningsEvent): number | undefined {
  if ("number" === typeof event.epsConsensus) {
    return Number.isFinite(event.epsConsensus) ? event.epsConsensus : undefined;
  }

  if ("string" !== typeof event.epsConsensus) {
    return undefined;
  }

  const normalizedValue = event.epsConsensus
    .replace(/[$€£¥]/g, "")
    .replaceAll(",", "")
    .trim();
  const parsedValue = Number.parseFloat(normalizedValue);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function sortEarningsMetrics(metrics: EarningsResultMetric[]): EarningsResultMetric[] {
  const preferredOrder = [
    "adjusted_eps",
    "gaap_eps",
    "nasdaq_eps",
    "revenue",
    "net_income",
    "refinery_throughput",
    "production",
  ];
  return [...metrics].sort((first, second) => {
    const firstIndex = preferredOrder.indexOf(first.key);
    const secondIndex = preferredOrder.indexOf(second.key);
    const firstRank = -1 === firstIndex ? Number.MAX_SAFE_INTEGER : firstIndex;
    const secondRank = -1 === secondIndex ? Number.MAX_SAFE_INTEGER : secondIndex;
    if (firstRank !== secondRank) {
      return firstRank - secondRank;
    }

    return first.label.localeCompare(second.label);
  });
}

function dedupeMetrics(metrics: EarningsResultMetric[]): EarningsResultMetric[] {
  const dedupedMetrics = new Map<string, EarningsResultMetric>();
  for (const metric of metrics) {
    if (false === dedupedMetrics.has(metric.key)) {
      dedupedMetrics.set(metric.key, metric);
    }
  }

  return [...dedupedMetrics.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
