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

  test("removes zero-width placeholders from otherwise-empty table cells", () => {
    expect(htmlToText("<tr><td>Loss per share</td><td>\u200B</td><td>$(0.10)</td></tr>"))
      .toBe("Loss per share | | $(0.10) |");
  });

  test("uses a three-month period end before a later-quarter outlook", () => {
    expect(getQuarterLabel([
      "Results for the three-month period ended June 30, 2026.",
      "For the third quarter of 2026, the company expects continued growth.",
    ].join(" "))).toBe("Q2 2026");
  });

  test("recognizes Swiss francs declared with their ISO code", () => {
    expect(getDocumentCurrencyCode([
      "On Holding AG financial results",
      "Net sales increased to CHF 850.3 million.",
    ])).toBe("CHF");
  });
});
