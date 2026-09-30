import {readFileSync} from "node:fs";
import {describe, expect, test} from "vitest";
import {parseEarningsDocument} from "./earnings-results-format.ts";

const fixtureDirectory = "modules/test-fixtures/earnings-regressions";
const readFixture = (name: string): string => readFileSync(`${fixtureDirectory}/${name}.txt`, "utf8");

describe("focused earnings regression fixtures", () => {
  test("gets a fiscal period from a bare quarter title and annual outlook", () => {
    const document = parseEarningsDocument(readFixture("bare-quarter-title-with-fiscal-outlook"));

    expect(document.quarterLabel).toBe("Q1 2027");
  });

  test("gets the quarter from a combined quarter and fiscal-year title", () => {
    const document = parseEarningsDocument(readFixture("combined-quarter-and-fiscal-year-title"));

    expect(document.quarterLabel).toBe("Q4 2026");
  });

  test("prefers consolidated revenue over inside sales", () => {
    const document = parseEarningsDocument(readFixture("inside-sales-vs-total-revenue"));

    expect(document.metrics).toEqual([
      expect.objectContaining({key: "revenue", value: "$5.68B"}),
    ]);
  });

  test("prefers consolidated revenue over the first category column", () => {
    const document = parseEarningsDocument(readFixture("category-summary-vs-consolidated-revenue"));

    expect(document.metrics).toEqual([
      expect.objectContaining({key: "revenue", value: "$5.68B"}),
    ]);
  });

  test("uses a sign-neutral income/loss row over a misleading loss caption", () => {
    const document = parseEarningsDocument(readFixture("sign-neutral-eps-vs-loss-caption"));

    expect(document.metrics).toEqual([
      expect.objectContaining({key: "gaap_eps", value: "$0.06"}),
    ]);
  });

  test.each([
    ["reported-diluted-eps-vs-inventory-reserve", "revenue", "$71.6M"],
    ["reported-diluted-eps-vs-inventory-reserve", "gaap_eps", "$0.15"],
    ["net-income-vs-equity-subtotal", "net_income", "$10.6M"],
    ["continuing-loss-vs-discontinued-loss", "net_income", "-$15M"],
    ["usd-results-vs-canadian-exchange-note", "revenue", "$278.07M"],
    ["quarter-eps-vs-prior-year-loss", "gaap_eps", "$0.00"],
    ["annual-sales-vs-quarter-sales", "revenue", "$129.9M"],
    ["service-revenue-vs-total-sales", "revenue", "$1.15B"],
    ["diluted-eps-vs-basic-and-income-change", "gaap_eps", "$0.15"],
    ["diluted-eps-vs-basic-and-income-change", "net_income", "$1.7M"],
    ["split-money-unit-in-reconciliation", "net_income", "$641M"],
    ["per-share-row-vs-page-number", "gaap_eps", "-$0.82"],
    ["per-share-row-vs-page-number", "adjusted_eps", "-$0.80"],
    ["revenue-increase-vs-sales-level", "revenue", "$161.2M"],
    ["adjusted-eps-vs-per-share-benefit", "adjusted_eps", "$0.53"],
  ])("%s selects %s as %s", (fixture, key, value) => {
    const document = parseEarningsDocument(readFixture(fixture));
    expect(document.metrics.find(metric => metric.key === key)?.value).toBe(value);
  });

  test("uses the fiscal fourth-quarter title over the calendar quarter", () => {
    const document = parseEarningsDocument(readFixture("fiscal-fourth-quarter-vs-calendar-quarter"));
    expect(document.quarterLabel).toBe("Q4 2026");
  });

  test("uses the statement's Canadian-dollar declaration for plain dollar signs", () => {
    const document = parseEarningsDocument(readFixture("canadian-statement-currency-vs-plain-dollar-sign"));
    expect(document.metrics.find(metric => metric.key === "revenue")?.value).toBe("C$199M");
    expect(document.metrics.find(metric => metric.key === "net_income")?.value).toBe("C$12.7M");
  });

  test("omits a historical management quote from outlook", () => {
    const document = parseEarningsDocument(readFixture("management-quote-vs-outlook"));
    expect(document.outlook).toEqual([]);
  });

  test("omits a margin change in basis points rather than inventing a margin level", () => {
    const document = parseEarningsDocument(readFixture("gross-margin-basis-points-vs-decline"));
    expect(document.outlook.find(metric => metric.key === "gross_margin")).toBeUndefined();
  });

  test("selects next-quarter and fiscal guidance after a headline about beating guidance", () => {
    const document = parseEarningsDocument(readFixture("historical-quarter-vs-fiscal-outlook"));
    expect(document.outlook.map(metric => [
      metric.periodLabel ? `${metric.periodLabel} ${metric.label}` : metric.label,
      metric.value,
    ])).toEqual([
      ["Q3 Revenue", "$55M"],
      ["FY2026 Revenue", "$200M"],
      ["Q3 Adj EBITDA", "-$3.5M"],
    ]);
  });

  test.each([
    ["updated-guidance-vs-currency-impact", [
      ["FY2026 Revenue", "$1.044B to $1.052B"],
      ["Q4 Revenue", "$297M to $305M"],
      ["FY2026 Adj EPS", "$6.15 to $6.23"],
      ["Q4 Adj EPS", "$1.24 to $1.33"],
      ["FY2026 EPS", "$1.18 to $1.28"],
      ["Q4 EPS", "-$0.41 to -$0.32"],
    ]],
    ["fiscal-guidance-vs-reported-results", [
      ["Revenue", "$2.4B to $2.6B"],
      ["Adj EPS", "$1.26 to $1.4"],
      ["Adj EBITDA", "$575M to $625M"],
    ]],
    ["revised-retail-guidance-vs-refund-impact", [
      ["Revenue", "$21.675B to $21.825B"],
      ["Adj EPS", "$2.15 to $2.35"],
    ]],
  ])("%s selects the forecast instead of its explanation", (fixture, expected) => {
    const document = parseEarningsDocument(readFixture(fixture));
    expect(document.outlook.map(metric => [
      metric.periodLabel ? `${metric.periodLabel} ${metric.label}` : metric.label,
      metric.value,
    ])).toEqual(expected);
  });
});
