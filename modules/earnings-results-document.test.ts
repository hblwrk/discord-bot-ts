import {describe, expect, test} from "vitest";
import {
  decodeHtmlEntities,
  getDocumentCurrencyCode,
  getMeaningfulLines,
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

  test("keeps short numeric table cells while dropping presentational fragments", () => {
    expect(getMeaningfulLines("Net income\n55\nx\n$\n(1")).toEqual([
      "Net income",
      "55",
      "(1",
    ]);
  });

  test("removes numeric superscript references embedded inside money values", () => {
    expect(htmlToText("<p>Net revenues were RMB346.4 billion (US$<sup>1</sup>51.1 billion).</p>"))
      .toBe("Net revenues were RMB346.4 billion (US$51.1 billion).");
  });

  test("does not split words across presentational font tags", () => {
    expect(htmlToText("<p>today reporte</font><font>d net earnings</p>"))
      .toBe("today reported net earnings");
  });

  test("removes raised-font references and normalizes leading decimal values", () => {
    expect(htmlToText([
      "<p>Adjusted</font>",
      "<font style=\"font-size:7pt;position:relative;top:-3.85pt\">1</font>",
      "<font> EPS was $.39 and GAAP EPS was (.32).</font></p>",
    ].join(""))).toBe("Adjusted EPS was $0.39 and GAAP EPS was (0.32).");
  });

  test("removes inline-XBRL hidden facts and vertical-align footnote references", () => {
    expect(htmlToText([
      "<ix:hidden><ix:nonNumeric>Prior-year revenue was $44.3 million.</ix:nonNumeric></ix:hidden>",
      "<p>Adjusted EPS guidance is $2.40",
      "<font style=\"font-size:6pt;vertical-align:super\">3</font>.</p>",
    ].join(""))).toBe("Adjusted EPS guidance is $2.40.");
  });

  test("uses a three-month period end before a later-quarter outlook", () => {
    expect(getQuarterLabel([
      "Results for the three-month period ended June 30, 2026.",
      "For the third quarter of 2026, the company expects continued growth.",
    ].join(" "))).toBe("Q2 2026");
  });

  test("uses a named fiscal result quarter before compact next-quarter guidance", () => {
    expect(getQuarterLabel([
      "Analog Devices Reports Record Fiscal Third Quarter 2026 Financial Results",
      "Outlook for the Fourth Quarter of Fiscal Year 2026",
      "Our Q4 Fiscal Year 2026 outlook reflects current expectations.",
    ].join("\n"))).toBe("Q3 2026");
  });

  test("reads the quarter year from a combined fiscal-results title", () => {
    expect(getQuarterLabel([
      "BILL Reports Fourth Quarter and Fiscal Year 2026 Financial Results",
      "We are providing guidance for Q1 FY27.",
    ].join("\n"))).toBe("Q4 2026");
  });

  test("joins a fiscal Q4 title to the year in its following highlights heading", () => {
    expect(getQuarterLabel([
      "Amcor Reports Strong Fourth Quarter and Full-Year Results",
      "Highlights - Three Months Ended June 30, 2026",
      "Highlights - Fiscal Year Ended June 30, 2026",
    ].join("\n"))).toBe("Q4 2026");
  });

  test("uses Q4 for fiscal-year results whose following highlights name the fourth quarter", () => {
    expect(getQuarterLabel([
      "ExampleCo Reports Fiscal 2026 Results",
      "As Reported Net Sales Growth of 6% in the Fourth Quarter and 5% for the Full Year",
      "The fiscal year ended June 30, 2026.",
    ].join("\n"))).toBe("Q4 2026");
  });

  test("recognizes Swiss francs declared with their ISO code", () => {
    expect(getDocumentCurrencyCode([
      "On Holding AG financial results",
      "Net sales increased to CHF 850.3 million.",
    ])).toBe("CHF");
  });

  test("prefers an explicit reporting currency over a multi-currency glossary", () => {
    expect(getDocumentCurrencyCode([
      "All references to U.S. dollars are to USD, all references to EUR are to euros, and all references to CNY are to yuan.",
      "We report our consolidated financial results in U.S. dollars but have significant non-U.S. operations.",
    ])).toBe("USD");
  });

  test("recognizes an all-amounts currency declaration in closing legal notes", () => {
    expect(getDocumentCurrencyCode([
      "CIBC Announces Third Quarter 2026 Results",
      ...Array.from({length: 60}, (_, index) => `Financial table row ${index}`),
      "All amounts are in Canadian dollars and are based on the financial statements.",
    ])).toBe("CAD");
  });
});
