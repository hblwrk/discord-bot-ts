import {describe, expect, test} from "vitest";
import {
  formatMarketCapUsdShort,
  getKnownValueOrFallback,
  getNormalizedString,
  getNumericValueFromNasdaqCapString,
} from "./earnings-utils.ts";

describe("earnings-utils", () => {
  test("normalizes known string values", () => {
    expect(getNormalizedString(" value ")).toBe("value");
    expect(getNormalizedString(" ")).toBeNull();
    expect(getNormalizedString(123)).toBeNull();
    expect(getKnownValueOrFallback("  known  ")).toBe("known");
    expect(getKnownValueOrFallback(" ")).toBe("n/a");
  });

  test("parses Nasdaq market cap strings", () => {
    expect(getNumericValueFromNasdaqCapString("$1.2T")).toBe(1_200_000_000_000);
    expect(getNumericValueFromNasdaqCapString("3.4B")).toBe(3_400_000_000);
    expect(getNumericValueFromNasdaqCapString("5.6M")).toBe(5_600_000);
    expect(getNumericValueFromNasdaqCapString("7.8K")).toBe(7_800);
    expect(getNumericValueFromNasdaqCapString("12,345")).toBe(12345);
    expect(getNumericValueFromNasdaqCapString("n/a")).toBeNull();
  });

  test("formats short market caps", () => {
    expect(formatMarketCapUsdShort(1_200_000_000)).toBe("$1.2B");
  });
});
