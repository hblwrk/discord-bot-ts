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
});
