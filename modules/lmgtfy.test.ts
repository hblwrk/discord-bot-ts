import {google, lmgtfy} from "./lmgtfy.js";

describe("lmgtfy helpers", () => {
  test("lmgtfy URL-encodes search terms", () => {
    const link = lmgtfy("hello world +?&\u00e4\u00f6\u00fc");

    expect(link).toBe("<http://letmegooglethat.com/?q=hello%20world%20%2B%3F%26%C3%A4%C3%B6%C3%BC>");
  });

  test("google URL-encodes search terms", () => {
    const link = google("hello world +?&\u00e4\u00f6\u00fc");

    expect(link).toBe("<https://www.google.com/search?q=hello%20world%20%2B%3F%26%C3%A4%C3%B6%C3%BC>");
  });
});
