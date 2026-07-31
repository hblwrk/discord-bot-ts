import {describe, expect, test} from "vitest";
import {getRelevantEarningsFilingText} from "./earnings-results-ai-text.ts";

describe("earnings AI filing excerpts", () => {
  test("returns a bounded relevant excerpt", () => {
    const html = [
      "<html><body>",
      "<h1>Example Corp reports first quarter 2026 results</h1>",
      ...Array.from({length: 400}, (_value, index) =>
        `<p>Revenue commentary ${index} ${"continued quarterly results discussion ".repeat(3)}</p>`,
      ),
      "<p>UNIQUE_TAIL_MARKER should be truncated.</p>",
      "</body></html>",
    ].join("\n");

    const result = getRelevantEarningsFilingText(html);

    expect(result.length).toBeLessThanOrEqual(10_020);
    expect(result).toContain("Example Corp reports first quarter 2026 results");
    expect(result).toContain("[truncated]");
    expect(result).not.toContain("UNIQUE_TAIL_MARKER");
  });

  test("falls back to bounded document text when no earnings keywords are present", () => {
    const result = getRelevantEarningsFilingText(
      `<html><body>${"General commentary. ".repeat(900)}</body></html>`,
    );

    expect(result.length).toBeLessThanOrEqual(10_020);
    expect(result).toContain("[truncated]");
  });

  test("returns an empty excerpt for empty HTML", () => {
    expect(getRelevantEarningsFilingText(" \n\t ")).toBe("");
  });
});
