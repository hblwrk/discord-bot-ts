import {assertSafeRequestUrl, isPrivateIp, UnsafeUrlError} from "./safe-http.js";

describe("isPrivateIp", () => {
  test.each([
    ["0.0.0.0"],
    ["10.0.0.1"],
    ["10.255.255.255"],
    ["100.64.0.1"],
    ["100.127.255.255"],
    ["127.0.0.1"],
    ["127.255.255.255"],
    ["169.254.169.254"], // AWS IMDS
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.0.0.1"],
    ["192.168.1.1"],
    ["198.18.0.1"],
    ["198.19.255.255"],
    ["224.0.0.1"],
    ["240.0.0.1"],
    ["255.255.255.255"],
  ])("%s is private", ip => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  test.each([
    ["1.1.1.1"],
    ["8.8.8.8"],
    ["100.63.255.255"],
    ["100.128.0.1"],
    ["172.15.255.255"],
    ["172.32.0.1"],
    ["198.17.255.255"],
    ["198.20.0.1"],
    ["223.255.255.255"],
  ])("%s is public", ip => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  test.each([
    ["::"],
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:169.254.169.254"],
    ["fe80::1"],
    ["fc00::1"],
    ["fd00::1"],
    ["ff02::1"],
  ])("IPv6 %s is private", ip => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  test.each([
    ["2001:4860:4860::8888"],
    ["2606:4700:4700::1111"],
    ["::ffff:8.8.8.8"],
  ])("IPv6 %s is public", ip => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  test("returns true for non-IP input", () => {
    expect(isPrivateIp("not-an-ip")).toBe(true);
    expect(isPrivateIp("")).toBe(true);
  });
});

describe("assertSafeRequestUrl", () => {
  test("accepts a normal https URL", () => {
    const result = assertSafeRequestUrl("https://www.example.com/article");
    expect(result.hostname).toBe("www.example.com");
  });

  test("accepts a normal http URL", () => {
    const result = assertSafeRequestUrl("http://example.com/path");
    expect(result.protocol).toBe("http:");
  });

  test("rejects javascript: URLs", () => {
    expect(() => assertSafeRequestUrl("javascript:alert(1)")).toThrow(UnsafeUrlError);
  });

  test("rejects file: URLs", () => {
    expect(() => assertSafeRequestUrl("file:///etc/passwd")).toThrow(UnsafeUrlError);
  });

  test("rejects gopher: URLs", () => {
    expect(() => assertSafeRequestUrl("gopher://example.com/")).toThrow(UnsafeUrlError);
  });

  test("rejects URLs with embedded credentials", () => {
    expect(() => assertSafeRequestUrl("https://user:pass@example.com/")).toThrow(UnsafeUrlError);
  });

  test("rejects URLs with only username", () => {
    expect(() => assertSafeRequestUrl("https://admin@example.com/")).toThrow(UnsafeUrlError);
  });

  test("rejects literal AWS metadata IP", () => {
    expect(() => assertSafeRequestUrl("http://169.254.169.254/latest/meta-data/")).toThrow(UnsafeUrlError);
  });

  test("rejects literal loopback IP", () => {
    expect(() => assertSafeRequestUrl("http://127.0.0.1:8080/")).toThrow(UnsafeUrlError);
  });

  test("rejects literal RFC1918 IP", () => {
    expect(() => assertSafeRequestUrl("http://10.0.0.5/admin")).toThrow(UnsafeUrlError);
    expect(() => assertSafeRequestUrl("http://192.168.1.1/")).toThrow(UnsafeUrlError);
    expect(() => assertSafeRequestUrl("http://172.20.0.1/")).toThrow(UnsafeUrlError);
  });

  test("rejects bracketed IPv6 loopback", () => {
    expect(() => assertSafeRequestUrl("http://[::1]/")).toThrow(UnsafeUrlError);
  });

  test("rejects malformed URLs", () => {
    expect(() => assertSafeRequestUrl("not a url")).toThrow(UnsafeUrlError);
  });

  test("accepts public IP literal", () => {
    const result = assertSafeRequestUrl("http://1.1.1.1/");
    expect(result.hostname).toBe("1.1.1.1");
  });
});
