import {describe, expect, test} from "vitest";
import {scoreTwitterPost, type TwitterPostContext} from "./twitter-sanity-score.ts";

const nowMs = Date.parse("2026-10-07T12:00:00Z");
const post: TwitterPostContext = {
  text: "A cat enjoys a sunny afternoon.", quotedText: "", media: [],
  externalLinks: [], authorJoined: "", defaultAvatar: false, authorWebsite: "",
};

describe("Twitter sensationalism index", () => {
  test("gives calm content a low wording score without verifying it", () => {
    expect(scoreTwitterPost(post, nowMs)).toEqual({
      score: 10, signals: [],
      realityCheck: "Few sensational wording signals appear, but calm wording does not verify the claim or the media context.",
    });
  });

  test.each([
    ["THEY ARE HIDING THIS FROM YOU!", 40, "Concealment framing"],
    ["Mainstream media won’t show this", 40, "Concealment framing"],
    ["MSM will not report this", 40, "Concealment framing"],
    ["Big if true", 30, "Speculation presented as a hook"],
    ["Share this before they delete it", 30, "Pressure to react or re-share"],
    ["You are being lied to", 30, "Us-versus-them framing"],
    ["A new report!!!", 20, "Repeated alarm punctuation"],
    ["THIS REPORT CONTAINS FIVE LARGE WORDS", 30, "Heavy ALL-CAPS wording"],
  ])("pins the weight for %s", (text, score, signal) => {
    expect(scoreTwitterPost({...post, text}, nowMs)).toMatchObject({score, signals: [signal]});
  });

  test("adds a thread hook only with other sensational wording", () => {
    expect(scoreTwitterPost({...post, text: "A knitting tutorial 🧵👇"}, nowMs).score).toBe(10);
    expect(scoreTwitterPost({...post, text: "Big if true 🧵👇"}, nowMs)).toMatchObject({
      score: 35, signals: ["Speculation presented as a hook", "Thread/click hook alongside sensational wording"],
    });
  });

  test("ignores acronyms, URL words and separate quoted-post text", () => {
    expect(scoreTwitterPost({...post, text: "NASA and BBC discuss the ISS and GDP"}, nowMs).score).toBe(10);
    expect(scoreTwitterPost({...post, text: `${post.text} https://example.com/BIG-IF-TRUE`, quotedText: "WAKE UP!!!"}, nowMs).score).toBe(10);
    expect(scoreTwitterPost({...post, text: "FIVE LONG UPPERCASE WORDS plus several lowercase words in context"}, nowMs).score).toBe(10);
  });

  test("flags exclusively social citations, while shorteners and unknown URLs remain unknown", () => {
    expect(scoreTwitterPost({...post, externalLinks: ["https://www.x.com/a/status/123", "https://twitter.com/b/status/234"]}, nowMs).score).toBe(20);
    for (const link of ["https://reuters.com/report", "https://t.co/abc", "broken", "https://x.com.evil.test/a"]) {
      expect(scoreTwitterPost({...post, externalLinks: ["https://x.com/a/status/123", link]}, nowMs).score).toBe(10);
    }
  });

  test("requires both a recent account and a default avatar for the profile caution", () => {
    expect(scoreTwitterPost({...post, authorJoined: "2026-10-01", defaultAvatar: true}, nowMs).score).toBe(20);
    for (const authorJoined of ["", "bad", "2026-01-01", "2026-10-08"]) {
      expect(scoreTwitterPost({...post, authorJoined, defaultAvatar: true}, nowMs).score).toBe(10);
    }
    expect(scoreTwitterPost({...post, authorJoined: "2026-10-01"}, nowMs).score).toBe(10);
  });

  test("caps a pile-up of signals without asserting propaganda or bots", () => {
    const result = scoreTwitterPost({...post, text: "THEY ARE HIDING THIS FROM YOU! BIG IF TRUE! WAKE UP SHEEPLE!!! 🧵👇"}, nowMs);
    expect(result.score).toBe(95);
    expect(result.realityCheck).toContain("remain unverified");
  });
});
