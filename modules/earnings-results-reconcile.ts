import {type EarningsResultMetric, type NasdaqSurprise} from "./earnings-results-format.ts";

export type EarningsMetricBasis =
  "adjusted" |
  "affo" |
  "gaap" |
  "operational" |
  "unknown";

export type EarningsMetricSourceKind = "ai" | "html" | "provider" | "xbrl";

export type EarningsMetricPeriod = {
  durationDays?: number | undefined;
  end?: string | undefined;
  fiscalPeriod?: string | undefined;
  fiscalYear?: string | undefined;
  frame?: string | undefined;
  label?: string | undefined;
  start?: string | undefined;
};

export type EarningsMetricCandidate = {
  basis: EarningsMetricBasis;
  concept?: string | undefined;
  evidence?: string | undefined;
  id: string;
  metric: EarningsResultMetric;
  period?: EarningsMetricPeriod | undefined;
  source: EarningsMetricSourceKind;
};

export type EarningsMetricConflict = {
  candidateIds: string[];
  key: string;
  reason: "conflicting_values" | "period_mismatch" | "unverified_source";
};

export type EarningsMetricResolution = {
  candidates: EarningsMetricCandidate[];
  conflicts: EarningsMetricConflict[];
  metrics: EarningsResultMetric[];
  selectedCandidateIds: string[];
};

const epsMetricKeys = new Set([
  "affo_per_share",
  "adjusted_eps",
  "gaap_eps",
  "nasdaq_eps",
]);

const metricOrder = [
  "affo_per_share",
  "adjusted_eps",
  "gaap_eps",
  "nasdaq_eps",
  "revenue",
  "net_income",
  "refinery_throughput",
  "production",
];

export function createHtmlMetricCandidates(
  metrics: EarningsResultMetric[],
  quarterLabel: string | undefined,
): EarningsMetricCandidate[] {
  return metrics.map((metric, index) => ({
    basis: getMetricBasis(metric.key),
    evidence: metric.sourceSnippet,
    id: `html:${metric.key}:${index}`,
    metric,
    period: undefined === quarterLabel ? undefined : {
      label: quarterLabel,
    },
    source: "html",
  }));
}

export function createAiMetricCandidates(
  metrics: EarningsResultMetric[],
  quarterLabel: string | undefined,
): EarningsMetricCandidate[] {
  return metrics.map((metric, index) => ({
    basis: getMetricBasis(metric.key),
    evidence: metric.sourceSnippet,
    id: `ai:${metric.key}:${index}`,
    metric,
    period: undefined === quarterLabel ? undefined : {
      label: quarterLabel,
    },
    source: "ai",
  }));
}

export function reconcileEarningsMetricCandidates(
  candidates: EarningsMetricCandidate[],
  aiSelections: ReadonlyMap<string, string> = new Map(),
): EarningsMetricResolution {
  const candidatesByKey = new Map<string, EarningsMetricCandidate[]>();
  for (const candidate of candidates) {
    const bucket = candidatesByKey.get(candidate.metric.key) ?? [];
    bucket.push(candidate);
    candidatesByKey.set(candidate.metric.key, bucket);
  }

  const conflicts: EarningsMetricConflict[] = [];
  const metrics: EarningsResultMetric[] = [];
  const selectedCandidateIds: string[] = [];
  for (const [key, keyCandidates] of candidatesByKey) {
    const verifiedCandidates = keyCandidates.filter(isIndependentlyVerifiableCandidate);
    const aiSelection = aiSelections.get(key);
    const selectedByAi = undefined === aiSelection
      ? undefined
      : verifiedCandidates.find(candidate => candidate.id === aiSelection);
    if (undefined !== selectedByAi) {
      metrics.push(selectedByAi.metric);
      selectedCandidateIds.push(selectedByAi.id);
      continue;
    }

    if (0 === verifiedCandidates.length) {
      conflicts.push({
        candidateIds: keyCandidates.map(candidate => candidate.id),
        key,
        reason: "unverified_source",
      });
      continue;
    }

    const referenceCandidate = verifiedCandidates[0];
    if (undefined === referenceCandidate) {
      continue;
    }

    if (verifiedCandidates.every(candidate =>
      areMetricValuesEquivalent(referenceCandidate.metric, candidate.metric))) {
      if (false === verifiedCandidates.every(candidate =>
        areCandidatePeriodsCompatible(referenceCandidate, candidate))) {
        conflicts.push({
          candidateIds: verifiedCandidates.map(candidate => candidate.id),
          key,
          reason: "period_mismatch",
        });
        continue;
      }

      const selectedCandidate = [...verifiedCandidates].sort(compareCandidatePriority)[0];
      if (undefined !== selectedCandidate) {
        metrics.push(selectedCandidate.metric);
        selectedCandidateIds.push(selectedCandidate.id);
      }
      continue;
    }

    conflicts.push({
      candidateIds: verifiedCandidates.map(candidate => candidate.id),
      key,
      reason: "conflicting_values",
    });
  }

  return {
    candidates,
    conflicts,
    metrics: sortMetrics(metrics),
    selectedCandidateIds,
  };
}

function areCandidatePeriodsCompatible(
  first: EarningsMetricCandidate,
  second: EarningsMetricCandidate,
): boolean {
  const firstLabel = first.period?.label?.replace(/\s+/g, " ").trim().toUpperCase();
  const secondLabel = second.period?.label?.replace(/\s+/g, " ").trim().toUpperCase();
  return undefined === firstLabel ||
    "" === firstLabel ||
    undefined === secondLabel ||
    "" === secondLabel ||
    firstLabel === secondLabel;
}

export function getProviderMatchedEpsMetric(
  metrics: EarningsResultMetric[],
  surprise: NasdaqSurprise | null,
): EarningsResultMetric | undefined {
  if ("number" !== typeof surprise?.actualEps ||
      false === Number.isFinite(surprise.actualEps)) {
    return undefined;
  }

  return metrics
    .filter(metric => true === epsMetricKeys.has(metric.key))
    .find(metric => areNumericValuesEquivalent(
      metric.numericValue,
      surprise.actualEps,
      "eps",
    ));
}

export function isProviderMatchedRevenueMetric(
  metric: EarningsResultMetric,
  surprise: NasdaqSurprise | null,
): boolean {
  return "number" === typeof surprise?.actualRevenue &&
    true === Number.isFinite(surprise.actualRevenue) &&
    true === areNumericValuesEquivalent(
      metric.numericValue,
      surprise.actualRevenue,
      "money",
    );
}

export function getMetricBasis(key: string): EarningsMetricBasis {
  if ("affo_per_share" === key) {
    return "affo";
  }

  if ("adjusted_eps" === key) {
    return "adjusted";
  }

  if ("gaap_eps" === key || "revenue" === key || "net_income" === key) {
    return "gaap";
  }

  if ("refinery_throughput" === key || "production" === key) {
    return "operational";
  }

  return "unknown";
}

function isIndependentlyVerifiableCandidate(candidate: EarningsMetricCandidate): boolean {
  if ("ai" === candidate.source || "provider" === candidate.source) {
    return false;
  }

  if ("xbrl" === candidate.source) {
    const durationDays = candidate.period?.durationDays;
    return "number" === typeof durationDays &&
      durationDays >= 60 &&
      durationDays <= 122 &&
      "" !== (candidate.concept ?? "");
  }

  return "html" === candidate.source &&
    "" !== (candidate.evidence?.trim() ?? "") &&
    "" !== (candidate.period?.label?.trim() ?? "");
}

function areMetricValuesEquivalent(
  first: EarningsResultMetric,
  second: EarningsResultMetric,
): boolean {
  if (first.currencyCode !== second.currencyCode &&
      undefined !== first.currencyCode &&
      undefined !== second.currencyCode) {
    return false;
  }

  return areNumericValuesEquivalent(
    first.numericValue,
    second.numericValue,
    true === epsMetricKeys.has(first.key) ? "eps" : "money",
  );
}

function areNumericValuesEquivalent(
  first: number | undefined,
  second: number | undefined,
  valueType: "eps" | "money",
): boolean {
  if ("number" !== typeof first ||
      "number" !== typeof second ||
      false === Number.isFinite(first) ||
      false === Number.isFinite(second)) {
    return false;
  }

  const largestValue = Math.max(Math.abs(first), Math.abs(second));
  const tolerance = "eps" === valueType
    ? Math.max(0.02, largestValue * 0.005)
    : Math.max(1_000_000, largestValue * 0.005);
  return Math.abs(first - second) <= tolerance;
}

function compareCandidatePriority(
  first: EarningsMetricCandidate,
  second: EarningsMetricCandidate,
): number {
  return getCandidatePriority(second) - getCandidatePriority(first);
}

function getCandidatePriority(candidate: EarningsMetricCandidate): number {
  if ("xbrl" === candidate.source) {
    return 30;
  }

  if ("html" === candidate.source) {
    return 20;
  }

  if ("provider" === candidate.source) {
    return 10;
  }

  return 0;
}

function sortMetrics(metrics: EarningsResultMetric[]): EarningsResultMetric[] {
  return [...metrics].sort((first, second) => {
    const firstIndex = metricOrder.indexOf(first.key);
    const secondIndex = metricOrder.indexOf(second.key);
    const firstRank = -1 === firstIndex ? Number.MAX_SAFE_INTEGER : firstIndex;
    const secondRank = -1 === secondIndex ? Number.MAX_SAFE_INTEGER : secondIndex;
    if (firstRank !== secondRank) {
      return firstRank - secondRank;
    }

    return first.label.localeCompare(second.label);
  });
}
