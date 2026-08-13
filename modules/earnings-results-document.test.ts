import {describe, expect, test} from "vitest";
import {
  decodeHtmlEntities,
  getDocumentCurrencyCode,
  getQuarterLabel,
  htmlToText,
} from "./earnings-results-document.ts";

describe("earnings result document text", () => {
  test("removes script/style blocks with spaced closing tags", () => {
    const text = htmlToText(`
      <p>Revenue $10 billion</p>
      <script>malicious()</script
        data-ignored>
      <style>body { color: red; }</style
        data-ignored>
      <p>EPS $1.00</p>
    `);

    expect(text).toContain("Revenue $10 billion");
    expect(text).toContain("EPS $1.00");
    expect(text).not.toContain("malicious");
    expect(text).not.toContain("color: red");
  });

  test("decodes html entities without double-unescaping ampersands", () => {
    expect(decodeHtmlEntities("A&amp;B &lt;tag&gt; &amp;lt;safe&amp;gt; &#36;1")).toBe(
      "A&B <tag> &lt;safe&gt; $1",
    );
  });

  test("decodes legacy Windows-1252 numeric entities used by SEC exhibits", () => {
    expect(decodeHtmlEntities("Revenue &#128;339 million &#x96; up year over year"))
      .toBe("Revenue €339 million – up year over year");
  });

  test("removes zero-width placeholders from otherwise-empty table cells", () => {
    expect(htmlToText("<tr><td>Loss per share</td><td>\u200B</td><td>$(0.10)</td></tr>"))
      .toBe("Loss per share | | $(0.10) |");
  });

  test("removes numeric superscript references embedded inside money values", () => {
    expect(htmlToText("<p>Net revenues were RMB346.4 billion (US$<sup>1</sup>51.1 billion).</p>"))
      .toBe("Net revenues were RMB346.4 billion (US$51.1 billion).");
  });

  test("uses a three-month period end before a later-quarter outlook", () => {
    expect(getQuarterLabel([
      "Results for the three-month period ended June 30, 2026.",
      "For the third quarter of 2026, the company expects continued growth.",
    ].join(" "))).toBe("Q2 2026");
  });

  test("joins a fiscal Q4 title to the year in its following highlights heading", () => {
    expect(getQuarterLabel([
      "Amcor Reports Strong Fourth Quarter and Full-Year Results",
      "Highlights - Three Months Ended June 30, 2026",
      "Highlights - Fiscal Year Ended June 30, 2026",
    ].join("\n"))).toBe("Q4 2026");
  });

  test("recognizes Swiss francs declared with their ISO code", () => {
    expect(getDocumentCurrencyCode([
      "On Holding AG financial results",
      "Net sales increased to CHF 850.3 million.",
    ])).toBe("CHF");
  });
});
