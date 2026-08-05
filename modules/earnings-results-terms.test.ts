import {describe, expect, test} from "vitest";
import {parseEarningsDocument} from "./earnings-results-format.ts";
import {
  gaapTermSource,
  hasNewTaiwanDollarSymbol,
  hasStandaloneGaapTerm,
  newTaiwanDollarPrefixSource,
  unitedStatesSource,
} from "./earnings-results-terms.ts";

// Each case below is wording that defeated a naive `\b` in a shipped release. They are pinned
// so the same guard is not dropped again, whichever call site is being edited.
describe("qualifier terms", () => {
  describe("GAAP", () => {
    test("does not read a non-GAAP caption as a GAAP one", () => {
      expect(hasStandaloneGaapTerm("Non-GAAP EPS of $1.02")).toBe(false);
      expect(hasStandaloneGaapTerm("non-GAAP diluted net income per share")).toBe(false);
    });

    test("still reads a GAAP caption", () => {
      expect(hasStandaloneGaapTerm("GAAP EPS of $0.95")).toBe(true);
      expect(hasStandaloneGaapTerm("GAAP and non-GAAP diluted EPS")).toBe(true);
    });

    test("composes into a larger caption pattern", () => {
      const epsPattern = new RegExp(String.raw`${gaapTermSource}\s+(?:diluted\s+)?eps\b`, "i");
      expect(epsPattern.test("GAAP diluted EPS")).toBe(true);
      expect(epsPattern.test("Non-GAAP diluted EPS")).toBe(false);
    });
  });

  describe("New Taiwan dollar", () => {
    test("does not match inside an ordinary word", () => {
      expect(hasNewTaiwanDollarSymbol("Since 2022, we spent $400 million")).toBe(false);
      expect(hasNewTaiwanDollarSymbol("the amount $883 million")).toBe(false);
    });

    test("matches the symbol as a currency", () => {
      expect(hasNewTaiwanDollarSymbol("NT$883 million")).toBe(true);
      expect(hasNewTaiwanDollarSymbol("Revenue of NT$1.2 billion")).toBe(true);
      expect(hasNewTaiwanDollarSymbol("(NT$ millions)")).toBe(true);
    });

    test("strips the symbol without consuming what precedes it", () => {
      const prefixPattern = new RegExp(newTaiwanDollarPrefixSource, "gi");
      expect("NT$883".replace(prefixPattern, "")).toBe("883");
      expect("(NT$883)".replace(prefixPattern, "")).toBe("(883)");
    });
  });

  describe("United States", () => {
    const qualifierPattern = new RegExp(String.raw`revenues?\s+outside\s+the\s+${unitedStatesSource}`, "i");

    test("matches where a trailing word boundary cannot", () => {
      // A boundary after the full stop needs a word character beside it, so `\bU\.S\.\b`
      // never matches before a space.
      expect(qualifierPattern.test("Jardiance revenue outside the U.S. included a milestone"))
        .toBe(true);
      expect(/revenues?\s+outside\s+the\s+U\.S\.\b/i.test("revenue outside the U.S. included"))
        .toBe(false);
    });

    test("does not match a longer abbreviation", () => {
      expect(new RegExp(unitedStatesSource).test("U.S.A. operations")).toBe(false);
    });
  });

  test("a non-GAAP per-share row is not also reported as the GAAP figure", () => {
    const parsedDocument = parseEarningsDocument(`
      <html>
        <body>
          <h1>ExampleCo Reports Second Quarter 2026 Results</h1>
          <p>(in millions, except per share amounts)</p>
          <p>Three Months Ended June 30,</p>
          <p>Non-GAAP EPS | $ | 1.02 | $ | 0.73</p>
        </body>
      </html>
    `);

    expect(parsedDocument.metrics.map(metric => metric.key)).not.toContain("gaap_eps");
    expect(parsedDocument.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({key: "adjusted_eps", value: "$1.02"}),
    ]));
  });
});
