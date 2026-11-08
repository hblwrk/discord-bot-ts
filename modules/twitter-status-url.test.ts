import {describe, expect, test} from "vitest";
import {getTwitterStatusId} from "./twitter-status-url.ts";
import {twitterProxyHosts} from "./test-utils/twitter-proxy-hosts.ts";

describe("getTwitterStatusId", () => {
  test.each(twitterProxyHosts)("recognises proxy %s without depending on its server", host => {
    expect(getTwitterStatusId(`https://${host}/Example/status/2106661915741114638?s=20#video`)).toBe("2106661915741114638");
  });

  test.each(["/i/web/status/123", "/i/status/123/", "/example/status/123/photo/4", "/example/status/123/video/1"])("recognises status path %s", path => {
    expect(getTwitterStatusId(`https://fixupx.com${path}`)).toBe("123");
  });

  test.each([
    "https://fxtwitter.com.evil.test/a/status/123", "https://evil-fxtwitter.com/a/status/123",
    "https://evil.fxtwitter.com/a/status/123", "https://api.fxtwitter.com/a/status/123",
    "http://fxtwitter.com/a/status/123", "https://user:pass@fixvx.com/a/status/123",
    "https://vxtwitter.com:8443/a/status/123", "https://x.com/a/status/123", "https://fxbsky.app/a/status/123",
    "https://fixupx.com/example", "https://fixvx.com/a/status/nope", "https://fixvx.com/a/status/123/other",
    "https://fixvx.com/a/status/1", "https://fixvx.com/a/status/123/photo/5", "broken",
  ])("rejects unsupported or unsafe URL %s", value => {
    expect(getTwitterStatusId(value)).toBeUndefined();
  });
});
