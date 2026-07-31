import {describe, expect, test} from "vitest";
import {
  extractSecXbrlCandidates,
  type SecCompanyFactsResponse,
} from "./earnings-results-xbrl.ts";

describe("earnings result XBRL metrics", () => {
  test("extracts quarterly facts for the matching accession", () => {
    const companyFacts: SecCompanyFactsResponse = {
      facts: {
        "us-gaap": {
          EarningsPerShareDiluted: {
            units: {
              "USD/shares": [{
                accn: "0000034088-26-000042",
                end: "2026-03-31",
                fp: "Q1",
                form: "8-K",
                frame: "CY2026Q1",
                start: "2026-01-01",
                val: 1,
              }],
            },
          },
          NetIncomeLoss: {
            units: {
              USD: [{
                accn: "0000034088-26-000042",
                end: "2026-03-31",
                fp: "Q1",
                form: "8-K",
                frame: "CY2026Q1",
                start: "2026-01-01",
                val: 8_100_000_000,
              }],
            },
          },
          RevenueFromContractWithCustomerExcludingAssessedTax: {
            units: {
              USD: [{
                accn: "0000034088-26-000042",
                end: "2026-06-30",
                fp: "Q2",
                form: "10-Q",
                start: "2026-01-01",
                val: 170_000_000_000,
              }, {
                accn: "0000034088-26-000042",
                end: "2026-03-31",
                fp: "Q1",
                form: "8-K",
                frame: "CY2026Q1",
                start: "2026-01-01",
                val: 85_140_000_000,
              }],
            },
          },
        },
      },
    };

    const candidates = extractSecXbrlCandidates(companyFacts, "0000034088-26-000042");
    expect(candidates.map(candidate => candidate.metric)).toEqual([
      {
        currencyCode: "USD",
        key: "gaap_eps",
        label: "EPS",
        numericValue: 1,
        value: "$1.00",
      },
      {
        currencyCode: "USD",
        key: "revenue",
        label: "Revenue",
        numericValue: 85_140_000_000,
        value: "$85.14B",
      },
      {
        currencyCode: "USD",
        key: "net_income",
        label: "Net income",
        numericValue: 8_100_000_000,
        value: "$8.1B",
      },
    ]);
    expect(candidates.find(candidate => "revenue" === candidate.metric.key)).toEqual(
      expect.objectContaining({
        basis: "gaap",
        concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
        period: {
          durationDays: 90,
          end: "2026-03-31",
          fiscalPeriod: "Q1",
          fiscalYear: undefined,
          frame: "CY2026Q1",
          label: "Q1 2026",
          start: "2026-01-01",
        },
        source: "xbrl",
      }),
    );
  });

  test("supports IFRS currency facts", () => {
    const companyFacts: SecCompanyFactsResponse = {
      facts: {
        "ifrs-full": {
          DilutedEarningsLossPerShare: {
            units: {
              "EUR/shares": [{
                accn: "0001776985-26-000031",
                end: "2026-03-31",
                fp: "Q1",
                form: "6-K",
                frame: "CY2026Q1",
                start: "2026-01-01",
                val: -1.3,
              }],
            },
          },
          ProfitLossAttributableToOwnersOfParent: {
            units: {
              EUR: [{
                accn: "0001776985-26-000031",
                end: "2026-03-31",
                fp: "Q1",
                form: "6-K",
                frame: "CY2026Q1",
                start: "2026-01-01",
                val: -415_000_000,
              }],
            },
          },
          RevenueFromContractsWithCustomers: {
            units: {
              EUR: [{
                accn: "0001776985-26-000031",
                end: "2026-03-31",
                fp: "Q1",
                form: "6-K",
                frame: "CY2026Q1",
                start: "2026-01-01",
                val: 118_100_000,
              }],
            },
          },
        },
      },
    };

    expect(extractSecXbrlCandidates(companyFacts, "0001776985-26-000031")
      .map(candidate => candidate.metric)).toEqual([
      expect.objectContaining({
        currencyCode: "EUR",
        key: "gaap_eps",
        value: "-€1.30",
      }),
      expect.objectContaining({
        currencyCode: "EUR",
        key: "revenue",
        value: "€118.1M",
      }),
      expect.objectContaining({
        currencyCode: "EUR",
        key: "net_income",
        value: "-€415M",
      }),
    ]);
  });

  test("rejects accession facts without a quarterly duration", () => {
    const companyFacts: SecCompanyFactsResponse = {
      facts: {
        "us-gaap": {
          Revenues: {
            units: {
              USD: [{
                accn: "0000034088-26-000042",
                end: "2026-03-31",
                fp: "Q1",
                form: "8-K",
                val: 85_140_000_000,
              }],
            },
          },
        },
      },
    };

    expect(extractSecXbrlCandidates(companyFacts, "0000034088-26-000042")).toEqual([]);
  });
});
