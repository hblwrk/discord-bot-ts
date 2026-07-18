import {describe, expect, test} from "vitest";
import {appendToMarkdownWithinLimit, getMarkdownSpanCount} from "./earnings-format-render.ts";

function expectBalancedMarkdown(content: string) {
  expect((content.match(/`/g)?.length ?? 0) % 2).toBe(0);
  expect((content.match(/\*\*/g)?.length ?? 0) % 2).toBe(0);
}

describe("earnings Markdown rendering", () => {
  test("counts inline-code and bold spans", () => {
    expect(getMarkdownSpanCount("**Heading**\n**`RTX`** MCap: `$261.7B`")).toBe(4);
  });

  test("appends a suffix without changing content that fits", () => {
    expect(appendToMarkdownWithinLimit("**Heading**", "\nmore", 40)).toBe("**Heading**\nmore");
  });

  test("closes Markdown markers when the suffix requires truncation", () => {
    const content = "**Heading**\n☕ 🏢 **`RTX`** 💰 MCap: `$261.7B` 🔮 EPS: `$1.66`";
    const suffix = "\n... more";
    const result = appendToMarkdownWithinLimit(content, suffix, 54);

    expect(result.length).toBeLessThanOrEqual(54);
    expect(result.endsWith(suffix)).toBe(true);
    expectBalancedMarkdown(result);
  });

  test("uses a shortened suffix when no formatted content fits", () => {
    expect(appendToMarkdownWithinLimit("**Heading**", "\n... more", 4)).toBe("... ");
  });
});
