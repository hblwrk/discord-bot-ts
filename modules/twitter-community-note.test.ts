import {describe, expect, test} from "vitest";
import {communityNoteField, parseTwitterCommunityNote} from "./twitter-community-note.ts";

describe("Twitter Community Notes", () => {
  test.each([undefined, null, [], 7, {}, {text: 7}, {text: " "}, {text: "\u202e\n\u0000"}, {text: "a".repeat(8_001)}])(
    "omits absent or malformed notes %#", value => {
      expect(parseTwitterCommunityNote(value)).toBeUndefined();
    },
  );

  test("reads the v2 subtitle and uses expanded note citations instead of shorteners", () => {
    const text = "This photograph predates the event. https://t.co/abc";
    const start = text.indexOf("https:");
    expect(parseTwitterCommunityNote({text, facets: [
      {type: "url", indices: [start, text.length], replacement: "https://example.org/archive"},
      {type: "url", indices: [start, text.length], replacement: "https://example.org/archive"},
    ]})).toEqual({text, sourceUrls: ["https://example.org/archive"]});
  });

  test.each([
    undefined, [], [0], [0, 1, 2], [-1, 4], [0, 99], [2, 2], [4, 2], [0.5, 4], ["0", 4], [NaN, 4],
  ])("ignores URL facets with invalid UTF-16 boundaries %#", indices => {
    expect(parseTwitterCommunityNote({text: "Source", facets: [
      {type: "url", indices, replacement: "https://example.org/report"},
    ]})?.sourceUrls).toEqual([]);
  });

  test("only reads URL facets and retains safe text links without metadata", () => {
    const text = "Read https://example.org/report. https://example.org/report";
    expect(parseTwitterCommunityNote({text, facets: [null, {type: "mention", indices: [0, 4], replacement: "https://ignored.test/"}]}))
      .toEqual({text, sourceUrls: ["https://example.org/report"]});
    expect(parseTwitterCommunityNote({text: "No citation", facets: {}})?.sourceUrls).toEqual([]);
  });

  test.each([
    7, "broken", "file:///secret", "http://example.org/", "https://user:pass@example.org/",
    "https://example.org:444/", `https://example.org/${"a".repeat(351)}`,
    `https://example.org/${"(".repeat(150)}`, `https://example.org/${"ü".repeat(100)}`,
  ])("omits unsafe, invalid or oversized citation %#", replacement => {
    expect(parseTwitterCommunityNote({text: "Source", facets: [
      {type: "url", indices: [0, 6], replacement},
    ]})?.sourceUrls).toEqual([]);
  });

  test("bounds facet processing and source count", () => {
    const facets = Array.from({length: 50}, () => ({type: "mention"}));
    expect(parseTwitterCommunityNote({text: "Source", facets: [
      ...facets, {type: "url", indices: [0, 6], replacement: "https://ignored.test/"},
    ]})?.sourceUrls).toEqual([]);
    const text = Array.from({length: 12}, (_, index) => `https://example.org/${index}`).join(" ");
    expect(parseTwitterCommunityNote({text})?.sourceUrls).toHaveLength(10);
  });

  test("renders attributed plain excerpts without mentions, formatting or disguised links", () => {
    const note = parseTwitterCommunityNote({text: "@everyone <@123> **context** [fake](https://evil.test/)\n\u202eRead Source", facets: [
      {type: "url", indices: [0, 9], replacement: "https://example.org/a(b)[c]"},
    ]});
    const field = communityNoteField(note!, "123");
    expect(field.name).toBe("Community Note via FxTwitter (excerpt)");
    expect(field.value).toContain("@\u200beveryone ＜@\u200b123＞ \\*\\*context\\*\\*");
    expect(field.value).not.toContain("\u202e");
    expect(field.value).not.toContain("https://evil.test/");
    expect(field.value).toContain("[Note source](https://example.org/a%28b%29%5Bc%5D)");
    expect(field.value).toContain("[Read post on X](https://x.com/i/status/123)");
    expect(field.value).toContain("Rating status and cited evidence are unverified.");
  });

  test("bounds long excerpts and works without citation metadata", () => {
    const field = communityNoteField({text: "a".repeat(8_000), sourceUrls: []}, "123");
    expect(field.value).toContain(`${"a".repeat(319)}…`);
    expect(field.value.length).toBeLessThan(450);
    expect(field.value).not.toContain("[Note source]");
  });
});
