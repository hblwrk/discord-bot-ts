import {type getWithRetry} from "./http-retry.ts";
import {
  formatEps,
  formatMoneyCompact,
  parseNumber,
  type EarningsResultMetric,
} from "./earnings-results-format.ts";
import {
  type EarningsMetricCandidate,
  getMetricBasis,
} from "./earnings-results-reconcile.ts";
import {type SecCurrentFiling} from "./earnings-results-sec.ts";

type Logger = {
  log: (level: string, message: unknown) => void;
};

type SecRequestDependencies = {
  getWithRetryFn: typeof getWithRetry;
  logger: Logger;
};

type SecCompanyFact = {
  accn?: string;
  end?: string;
  filed?: string;
  form?: string;
  fp?: string;
  frame?: string;
  fy?: number | string;
  start?: string;
  val?: number | string;
};

type SecCompanyFactUnits = Record<string, SecCompanyFact[]>;

type SecCompanyFactConcept = {
  units?: SecCompanyFactUnits;
};

export type SecCompanyFactsResponse = {
  facts?: Record<string, Record<string, SecCompanyFactConcept>>;
};

type XbrlMetricDefinition = {
  concepts: {name: string; namespace: string;}[];
  key: string;
  label: string;
  valueType: "eps" | "money";
};

type XbrlFactCandidate = {
  concept: string;
  currencyCode: string;
  durationDays: number | null;
  fact: SecCompanyFact;
  score: number;
  unit: string;
  value: number;
};

const secCompanyFactsEndpoint = "https://data.sec.gov/api/xbrl/companyfacts";
const secRequestHeaders = {
  "User-Agent": "hblwrk discord-bot-ts admin@hblwrk.de",
  "Accept": "application/json, text/plain, */*",
  "Accept-Encoding": "gzip, deflate",
};

const xbrlMetricDefinitions: XbrlMetricDefinition[] = [
  {
    key: "gaap_eps",
    label: "EPS",
    valueType: "eps",
    concepts: [
      {namespace: "us-gaap", name: "EarningsPerShareDiluted"},
      {namespace: "us-gaap", name: "EarningsPerShareBasicAndDiluted"},
      {namespace: "ifrs-full", name: "DilutedEarningsLossPerShare"},
      {namespace: "us-gaap", name: "EarningsPerShareBasic"},
      {namespace: "ifrs-full", name: "BasicEarningsLossPerShare"},
    ],
  },
  {
    key: "revenue",
    label: "Revenue",
    valueType: "money",
    concepts: [
      {namespace: "us-gaap", name: "RevenueFromContractWithCustomerExcludingAssessedTax"},
      {namespace: "us-gaap", name: "RevenueFromContractWithCustomerIncludingAssessedTax"},
      {namespace: "us-gaap", name: "Revenues"},
      {namespace: "us-gaap", name: "SalesRevenueNet"},
      {namespace: "ifrs-full", name: "RevenueFromContractsWithCustomers"},
      {namespace: "ifrs-full", name: "Revenue"},
    ],
  },
  {
    key: "net_income",
    label: "Net income",
    valueType: "money",
    concepts: [
      {namespace: "us-gaap", name: "NetIncomeLoss"},
      {namespace: "us-gaap", name: "ProfitLoss"},
      {namespace: "us-gaap", name: "NetIncomeLossAvailableToCommonStockholdersBasic"},
      {namespace: "ifrs-full", name: "ProfitLossAttributableToOwnersOfParent"},
      {namespace: "ifrs-full", name: "ProfitLoss"},
    ],
  },
];

export async function loadSecXbrlCandidates(
  filing: SecCurrentFiling,
  dependencies: SecRequestDependencies,
): Promise<EarningsMetricCandidate[]> {
  const response = await dependencies.getWithRetryFn<SecCompanyFactsResponse>(
    `${secCompanyFactsEndpoint}/CIK${filing.cik}.json`,
    {
      headers: secRequestHeaders,
    },
  );
  return extractSecXbrlCandidates(response.data, filing.accessionNumber);
}

export function extractSecXbrlCandidates(
  companyFacts: SecCompanyFactsResponse,
  accessionNumber: string,
): EarningsMetricCandidate[] {
  const candidates: EarningsMetricCandidate[] = [];

  for (const [definitionIndex, definition] of xbrlMetricDefinitions.entries()) {
    const candidate = getBestFactCandidate(companyFacts, accessionNumber, definition);
    if (null === candidate) {
      continue;
    }

    const metric: EarningsResultMetric = {
      currencyCode: candidate.currencyCode,
      key: definition.key,
      label: definition.label,
      numericValue: candidate.value,
      value: "eps" === definition.valueType
        ? formatEps(candidate.value, candidate.currencyCode)
        : formatMoneyCompact(candidate.value, candidate.currencyCode),
    };
    candidates.push({
      basis: getMetricBasis(definition.key),
      concept: candidate.concept,
      id: `xbrl:${definition.key}:${definitionIndex}`,
      metric,
      period: {
        durationDays: candidate.durationDays ?? undefined,
        end: candidate.fact.end,
        fiscalPeriod: candidate.fact.fp,
        fiscalYear: undefined === candidate.fact.fy ? undefined : String(candidate.fact.fy),
        frame: candidate.fact.frame,
        label: getFactPeriodLabel(candidate.fact),
        start: candidate.fact.start,
      },
      source: "xbrl",
    });
  }

  return candidates;
}

function getFactPeriodLabel(fact: SecCompanyFact): string | undefined {
  const fiscalPeriod = fact.fp?.trim().toUpperCase();
  if (false === /^Q[1-4]$/.test(fiscalPeriod ?? "")) {
    return undefined;
  }

  const fiscalYear = String(fact.fy ?? "").trim();
  if (/^\d{4}$/.test(fiscalYear)) {
    return `${fiscalPeriod} ${fiscalYear}`;
  }

  const endYear = fact.end?.match(/^(\d{4})-/)?.[1];
  return undefined === endYear ? undefined : `${fiscalPeriod} ${endYear}`;
}

function getBestFactCandidate(
  companyFacts: SecCompanyFactsResponse,
  accessionNumber: string,
  definition: XbrlMetricDefinition,
): XbrlFactCandidate | null {
  const candidates: XbrlFactCandidate[] = [];

  for (const concept of definition.concepts) {
    const units = companyFacts.facts?.[concept.namespace]?.[concept.name]?.units;
    if (undefined === units) {
      continue;
    }

    for (const [unit, facts] of Object.entries(units)) {
      const currencyCode = getCurrencyCodeFromUnit(unit, definition.valueType);
      if (null === currencyCode) {
        continue;
      }

      for (const fact of facts) {
        const value = parseNumber(fact.val);
        if (null === value || false === isMatchingAccession(fact.accn, accessionNumber)) {
          continue;
        }

        const durationDays = getDurationDays(fact);
        if (null === durationDays || durationDays < 60 || durationDays > 122) {
          continue;
        }

        candidates.push({
          concept: `${concept.namespace}:${concept.name}`,
          currencyCode,
          durationDays,
          fact,
          score: getFactScore(fact, durationDays),
          unit,
          value,
        });
      }
    }

    if (0 < candidates.length) {
      break;
    }
  }

  candidates.sort(compareFactCandidates);
  return candidates[0] ?? null;
}

function getCurrencyCodeFromUnit(unit: string, valueType: XbrlMetricDefinition["valueType"]): string | null {
  const unitMatch = unit.toUpperCase().match(/(?:^|:)([A-Z]{3})(?:\/SHARES)?$/);
  const currencyCode = unitMatch?.[1] ?? null;
  if (null === currencyCode) {
    return null;
  }

  if ("eps" === valueType) {
    return /\/SHARES$/i.test(unit) ? currencyCode : null;
  }

  return /^[A-Z]{3}$/i.test(unit) || /^ISO4217:[A-Z]{3}$/i.test(unit)
    ? currencyCode
    : null;
}

function isMatchingAccession(factAccession: string | undefined, accessionNumber: string): boolean {
  return normalizeAccessionNumber(factAccession) === normalizeAccessionNumber(accessionNumber);
}

function normalizeAccessionNumber(value: string | undefined): string {
  const normalizedValue = value?.trim() ?? "";
  if (/^\d{18}$/.test(normalizedValue)) {
    return `${normalizedValue.slice(0, 10)}-${normalizedValue.slice(10, 12)}-${normalizedValue.slice(12)}`;
  }

  return normalizedValue;
}

function getDurationDays(fact: SecCompanyFact): number | null {
  if (undefined === fact.start || undefined === fact.end) {
    return null;
  }

  const startMs = Date.parse(fact.start);
  const endMs = Date.parse(fact.end);
  if (false === Number.isFinite(startMs) || false === Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }

  return Math.round((endMs - startMs) / 86_400_000) + 1;
}

function getFactScore(fact: SecCompanyFact, durationDays: number | null): number {
  let score = 0;
  if (null !== durationDays) {
    score += Math.max(0, 100 - Math.abs(durationDays - 91));
  }

  if (/^CY\d{4}Q[1-4]$/i.test(fact.frame ?? "")) {
    score += 40;
  }

  if (/^Q[1-4]$/i.test(fact.fp ?? "")) {
    score += 10;
  }

  if (/^(8-K|6-K|10-Q)$/i.test(fact.form ?? "")) {
    score += 5;
  }

  return score;
}

function compareFactCandidates(first: XbrlFactCandidate, second: XbrlFactCandidate): number {
  if (first.score !== second.score) {
    return second.score - first.score;
  }

  const durationDistance = getDurationDistance(first) - getDurationDistance(second);
  if (0 !== durationDistance) {
    return durationDistance;
  }

  return getTimestampMs(second.fact.end) - getTimestampMs(first.fact.end);
}

function getDurationDistance(candidate: XbrlFactCandidate): number {
  return null === candidate.durationDays
    ? Number.MAX_SAFE_INTEGER
    : Math.abs(candidate.durationDays - 91);
}

function getTimestampMs(value: string | undefined): number {
  const timestampMs = Date.parse(value ?? "");
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}
