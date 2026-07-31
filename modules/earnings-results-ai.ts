import {type EarningsEvent} from "./earnings.ts";
import {
  formatEps,
  formatMoneyCompact,
  htmlToText,
  type EarningsResultMetric,
  type NasdaqSurprise,
} from "./earnings-results-format.ts";
import {getRelevantEarningsFilingText} from "./earnings-results-ai-text.ts";
import {callAiProviderJson, clearAiProviderState, type AiProviderDependencies} from "./ai-provider.ts";

type EarningsAiDependencies = AiProviderDependencies;

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
            enum: ["affo_per_share", "adjusted_eps", "gaap_eps", "revenue", "net_income", "nasdaq_eps", null],
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

  const sourceText = getRelevantEarningsFilingText(input.html);
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

  const qualityGate = parseQualityGate(parsedJson, htmlToText(input.html));
  return null !== qualityGate && 0 < qualityGate.issues.length
    ? qualityGate
    : null;
}

export function getSuspiciousEarningsReasons(
  metrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
  event: EarningsEvent,
): SuspiciousEarningsReason[] {
  const reasons: SuspiciousEarningsReason[] = [];
  const consensusEps = surprise?.consensusEps ?? getNumericEventEpsConsensus(event);
  const epsMetric = metrics.find(metric => "affo_per_share" === metric.key) ??
    metrics.find(metric => "adjusted_eps" === metric.key) ??
    metrics.find(metric => "gaap_eps" === metric.key || "nasdaq_eps" === metric.key);
  if (undefined !== epsMetric &&
      "number" === typeof epsMetric.numericValue &&
      true === Number.isFinite(epsMetric.numericValue) &&
      "number" === typeof consensusEps &&
      true === Number.isFinite(consensusEps)) {
    const absoluteConsensus = Math.abs(consensusEps);
    const absoluteEps = Math.abs(epsMetric.numericValue);
    if ((absoluteEps >= 20 && absoluteConsensus < 5) ||
        (absoluteConsensus >= 20 && absoluteEps < 5)) {
      reasons.push({
        message: `${epsMetric.label} ${epsMetric.value} is extremely far from consensus ${formatEps(consensusEps)}.`,
        metricKey: epsMetric.key,
        severity: "high",
      });
    } else if ((absoluteEps >= 10 && absoluteConsensus < 5) ||
        (absoluteConsensus >= 10 && absoluteEps < 5)) {
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
        severity: "medium",
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

  reasons.push(...getEpsNetIncomeSignContradictions(metrics, netIncomeMetric));

  return reasons;
}

export function hasHighSeveritySuspicion(reasons: SuspiciousEarningsReason[]): boolean {
  return reasons.some(reason => "high" === reason.severity);
}

const epsMetricKeys = new Set(["affo_per_share", "adjusted_eps", "gaap_eps", "nasdaq_eps"]);

// Consolidated net income and the EPS numerator can legitimately differ because
// of preferred dividends, noncontrolling interests, or income attribution. A
// sign mismatch is therefore an anomaly to review, not a hard contradiction.
function getEpsNetIncomeSignContradictions(
  metrics: EarningsResultMetric[],
  netIncomeMetric: EarningsResultMetric | undefined,
): SuspiciousEarningsReason[] {
  if (undefined === netIncomeMetric ||
      "number" !== typeof netIncomeMetric.numericValue ||
      false === Number.isFinite(netIncomeMetric.numericValue) ||
      0 === netIncomeMetric.numericValue) {
    return [];
  }

  const netIncomePositive = netIncomeMetric.numericValue > 0;
  const reasons: SuspiciousEarningsReason[] = [];
  for (const metric of metrics) {
    if (false === epsMetricKeys.has(metric.key) ||
        "number" !== typeof metric.numericValue ||
        false === Number.isFinite(metric.numericValue) ||
        0 === metric.numericValue) {
      continue;
    }

    if ((metric.numericValue > 0) === netIncomePositive) {
      continue;
    }

    reasons.push({
      message: netIncomePositive
        ? `${metric.label} ${metric.value} is negative while net income ${netIncomeMetric.value} is positive.`
        : `${metric.label} ${metric.value} is positive while net income ${netIncomeMetric.value} is negative.`,
      metricKey: metric.key,
      severity: "medium",
    });
  }

  return reasons;
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
    "Return at least one issue explaining the decision. Every issue must include a short exact sourceSnippet from the filing text.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return "object" === typeof value && null !== value && false === Array.isArray(value);
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
