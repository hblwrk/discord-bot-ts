import {type ParsedEarningsDocument} from "./earnings-results-document.ts";
import {
  type EarningsResultMetric,
  type EarningsResultOutcome,
} from "./earnings-results-metrics.ts";

type SecCurrentFilingForMessage = {
  form: string;
  items: string[];
};

const discordBlankLineSpacer = "\u200B";

export function getEarningsResultMessage({
  companyName,
  filing,
  filingUrl,
  metrics,
  parsedDocument,
  summary,
  ticker,
}: {
  companyName: string;
  filing: SecCurrentFilingForMessage;
  filingUrl: string;
  metrics: EarningsResultMetric[];
  parsedDocument: ParsedEarningsDocument;
  summary?: string | undefined;
  ticker: string;
}): string {
  const normalizedTicker = ticker.trim().toUpperCase().replaceAll("`", "'");
  const titleParts = [`**${companyName} (\`${normalizedTicker}\`)**`];
  if (parsedDocument.quarterLabel) {
    titleParts.push(` - ${parsedDocument.quarterLabel}`);
  }
  titleParts.push(` - ${getFilingFormText(filing, filingUrl)}`);

  const lines = [titleParts.join("")];

  if (0 < metrics.length) {
    if (1 < lines.length) {
      lines.push("");
    }
    lines.push("📊 **Results**");
    for (const metric of metrics) {
      lines.push(getMetricMessageLine(metric));
    }
  }

  if (0 < parsedDocument.outlook.length) {
    if (1 < lines.length) {
      lines.push("");
    }
    lines.push("🔮 **Outlook**");
    for (const metric of parsedDocument.outlook) {
      const metricLabel = metric.periodLabel
        ? `${metric.periodLabel} ${metric.label}`
        : metric.label;
      lines.push(`- **${metricLabel}:** ${formatOutlookValue(metric.value)}`);
    }
  }

  if (undefined !== summary && "" !== summary.trim()) {
    if (1 < lines.length) {
      lines.push("");
    }
    lines.push(`📝 ${summary.trim()}`);
  }

  lines.push(discordBlankLineSpacer);

  return lines.join("\n");
}

function getFilingFormText(filing: SecCurrentFilingForMessage, filingUrl: string): string {
  return "" === filingUrl ? filing.form : `[${filing.form}](${filingUrl})`;
}

function getMetricMessageLine(metric: EarningsResultMetric): string {
  const estimateText = metric.estimate ? ` vs est. ${formatInlineCode(metric.estimate)}` : "";
  const outcomeText = metric.outcome ? ` (${getOutcomeIndicator(metric.outcome)} ${metric.outcome})` : "";
  return `- **${metric.label}:** ${formatInlineCode(metric.value)}${estimateText}${outcomeText}`;
}

function formatOutlookValue(value: string): string {
  if (false === isQuantitativeText(value)) {
    return value;
  }

  return formatQuantitativeTokens(value);
}

function isQuantitativeText(value: string): boolean {
  return /[$€£¥]|\d/.test(value);
}

function formatQuantitativeTokens(value: string): string {
  return value.replace(
    quantitativeTokenPattern,
    token => formatInlineCode(token.trim()),
  );
}

const quantitativeValuePattern = String.raw`-?(?:[$€£¥]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:trillion|billions?|millions?|thousands?|tn|bn|mm|[tbmk]|kbd|koebd|boepd|bpd|mmboe|bcfe|mmcf|mw|gw)\b|\s*%)?`;
const quantitativeTokenPattern = new RegExp(`${quantitativeValuePattern}(?:\\s*(?:-|–|—)\\s*${quantitativeValuePattern})?`, "gi");

function formatInlineCode(value: string): string {
  return `\`${value.replaceAll("`", "'")}\``;
}

function getOutcomeIndicator(outcome: EarningsResultOutcome): string {
  if ("beat" === outcome) {
    return "🟢";
  }

  if ("miss" === outcome) {
    return "🔴";
  }

  return "⚪";
}

export function getOutcome(actual: number | undefined, estimate: number): EarningsResultOutcome | undefined {
  if ("number" !== typeof actual || false === Number.isFinite(actual)) {
    return undefined;
  }

  const tolerance = Math.max(Math.abs(estimate) * 0.001, 0.005);
  if (actual > estimate + tolerance) {
    return "beat";
  }

  if (actual < estimate - tolerance) {
    return "miss";
  }

  return "inline";
}
