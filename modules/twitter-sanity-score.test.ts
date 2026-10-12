import {describe, expect, test} from "vitest";
import {scoreTwitterPost, type TwitterPostContext} from "./twitter-sanity-score.ts";

const post: TwitterPostContext = {
  text: "A cat enjoys a sunny afternoon.", quotedText: "", media: [],
  externalLinks: [], authorJoined: "", defaultAvatar: false, authorWebsite: "",
};

describe("Twitter sensationalism index", () => {
  test("gives calm content a low wording score without verifying it", () => {
    expect(scoreTwitterPost(post)).toEqual({
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
    expect(scoreTwitterPost({...post, text})).toMatchObject({score, signals: [signal]});
  });

  test("adds a thread hook only with other sensational wording", () => {
    expect(scoreTwitterPost({...post, text: "A knitting tutorial 🧵👇"}).score).toBe(10);
    expect(scoreTwitterPost({...post, text: "Big if true 🧵👇"})).toMatchObject({
      score: 35, signals: ["Speculation presented as a hook", "Thread/click hook alongside sensational wording"],
    });
  });

  test("ignores acronyms, URL words and separate quoted-post text", () => {
    expect(scoreTwitterPost({...post, text: "NASA and BBC discuss the ISS and GDP"}).score).toBe(10);
    expect(scoreTwitterPost({...post, text: `${post.text} https://example.com/BIG-IF-TRUE`, quotedText: "WAKE UP!!!"}).score).toBe(10);
    expect(scoreTwitterPost({...post, text: "FIVE LONG UPPERCASE WORDS plus several lowercase words in context"}).score).toBe(10);
  });

  test("keeps account age, avatar and link reputation out of wording", () => {
    expect(scoreTwitterPost({...post, authorJoined: "2026-10-01", defaultAvatar: true,
      externalLinks: ["https://x.com/a/status/123"]}).score).toBe(10);
  });

  test("caps a pile-up of signals without asserting propaganda or bots", () => {
    const result = scoreTwitterPost({...post, text: "THEY ARE HIDING THIS FROM YOU! BIG IF TRUE! WAKE UP SHEEPLE!!! 🧵👇"});
    expect(result.score).toBe(95);
    expect(result.realityCheck).toContain("remain unverified");
  });
});
