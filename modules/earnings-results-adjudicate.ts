import {callAiProviderJson, type AiProviderDependencies} from "./ai-provider.ts";
import {getRelevantEarningsFilingText} from "./earnings-results-ai-text.ts";
import {
  type EarningsMetricCandidate,
  type EarningsMetricConflict,
} from "./earnings-results-reconcile.ts";

export type EarningsAiAdjudicationInput = {
  candidates: EarningsMetricCandidate[];
  companyName: string;
  conflicts: EarningsMetricConflict[];
  filingForm: string;
  filingUrl: string;
  html: string;
  ticker: string;
};

export async function adjudicateEarningsCandidatesWithAi(
  input: EarningsAiAdjudicationInput,
  dependencies: AiProviderDependencies,
): Promise<Map<string, string>> {
  if (0 === input.conflicts.length) {
    return new Map();
  }

  const eligibleCandidates = input.candidates.filter(candidate =>
    input.conflicts.some(conflict => conflict.candidateIds.includes(candidate.id)) &&
    ("html" === candidate.source || "xbrl" === candidate.source));
  if (0 === eligibleCandidates.length) {
    return new Map();
  }

  const sourceText = getRelevantEarningsFilingText(input.html);
  if ("" === sourceText) {
    return new Map();
  }

  const candidateIds = eligibleCandidates.map(candidate => candidate.id);
  const jsonText = await callAiProviderJson(
    getCandidateAdjudicationPrompt(input, eligibleCandidates, sourceText),
    getCandidateAdjudicationSchema(candidateIds),
    dependencies,
    `earnings candidate adjudication for ${input.ticker}`,
  ).catch(error => {
    dependencies.logger.log(
      "warn",
      `AI earnings candidate adjudication failed for ${input.ticker}: ${error}`,
    );
    return null;
  });
  if (null === jsonText) {
    return new Map();
  }

  return parseCandidateAdjudication(
    parseJson(jsonText),
    input.conflicts,
    eligibleCandidates,
  );
}

function getCandidateAdjudicationSchema(candidateIds: string[]): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      selections: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: {
              type: "string",
            },
            candidateId: {
              type: "string",
              enum: candidateIds,
            },
          },
          required: ["key", "candidateId"],
        },
      },
    },
    required: ["selections"],
  };
}

function getCandidateAdjudicationPrompt(
  input: EarningsAiAdjudicationInput,
  candidates: EarningsMetricCandidate[],
  sourceText: string,
): string {
  const candidateLines = candidates.map(candidate => [
    `candidateId=${candidate.id}`,
    `key=${candidate.metric.key}`,
    `basis=${candidate.basis}`,
    `source=${candidate.source}`,
    `value=${candidate.metric.value}`,
    `period=${formatCandidatePeriod(candidate)}`,
    `concept=${candidate.concept ?? "none"}`,
    `evidence=${candidate.evidence ?? "none"}`,
  ].join(" | "));
  return [
    "Resolve conflicting earnings metric candidates against the supplied SEC filing.",
    "Return only JSON matching the schema.",
    "Select only an existing candidateId. Never calculate, invent, or modify a value.",
    "Select a candidate only when its metric basis, reporting period, scale, and evidence match the reported quarter.",
    "Prefer a consolidated quarterly value over year-to-date, annual, prior-period, segment, run-rate, or guidance values.",
    "Omit a key from selections when the conflict cannot be resolved confidently.",
    `Company: ${input.companyName}`,
    `Ticker: ${input.ticker}`,
    `Filing: ${input.filingForm} ${input.filingUrl}`,
    "Candidates:",
    ...candidateLines,
    "Filing text:",
    sourceText,
  ].join("\n");
}

function formatCandidatePeriod(candidate: EarningsMetricCandidate): string {
  const periodParts = [
    candidate.period?.label,
    candidate.period?.start,
    candidate.period?.end,
    "number" === typeof candidate.period?.durationDays
      ? `${candidate.period.durationDays} days`
      : undefined,
    candidate.period?.fiscalPeriod,
    candidate.period?.fiscalYear,
    candidate.period?.frame,
  ].filter((part): part is string => undefined !== part && "" !== part);
  return 0 === periodParts.length ? "unknown" : periodParts.join(", ");
}

function parseCandidateAdjudication(
  value: unknown,
  conflicts: EarningsMetricConflict[],
  candidates: EarningsMetricCandidate[],
): Map<string, string> {
  const selections = new Map<string, string>();
  if (false === isRecord(value) || false === Array.isArray(value["selections"])) {
    return selections;
  }

  const candidatesById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const conflictsByKey = new Map(conflicts.map(conflict => [conflict.key, conflict]));
  for (const selection of value["selections"]) {
    if (false === isRecord(selection)) {
      continue;
    }

    const key = selection["key"];
    const candidateId = selection["candidateId"];
    if ("string" !== typeof key || "string" !== typeof candidateId) {
      continue;
    }

    const candidate = candidatesById.get(candidateId);
    const conflict = conflictsByKey.get(key);
    if (undefined === candidate ||
        undefined === conflict ||
        candidate.metric.key !== key ||
        false === conflict.candidateIds.includes(candidateId) ||
        true === selections.has(key)) {
      continue;
    }

    selections.set(key, candidateId);
  }

  return selections;
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return "[object Object]" === Object.prototype.toString.call(value);
}
