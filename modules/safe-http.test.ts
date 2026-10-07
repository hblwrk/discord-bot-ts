import type net from "node:net";
import {assertSafeRequestUrl, isPrivateIp, safeLookup, UnsafeUrlError} from "./safe-http.ts";
import {describe, expect, test, vi} from "vitest";

const dnsMock = vi.hoisted(() => ({lookup: vi.fn<net.LookupFunction>()}));
vi.mock("node:dns", () => ({default: dnsMock}));

describe("safeLookup", () => {
  test("preserves all public IPv4 and IPv6 results for Node automatic family selection", () => {
    const addresses = [{address: "1.1.1.1", family: 4}, {address: "2606:4700:4700::1111", family: 6}];
    dnsMock.lookup.mockImplementation((_hostname, _options, callback) => { callback(null, addresses); });
    const callback = vi.fn();
    const options = {all: true};
    safeLookup("example.com", options, callback);
    expect(dnsMock.lookup).toHaveBeenCalledWith("example.com", options, expect.any(Function));
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, addresses, undefined);
  });

  test.each(["127.0.0.1", "169.254.169.254", "::1", "::ffff:10.0.0.1"])("rejects every candidate when a later DNS answer is private: %s", address => {
    dnsMock.lookup.mockImplementation((_hostname, _options, callback) => {
      callback(null, [{address: "1.1.1.1", family: 4}, {address, family: address.includes(":") ? 6 : 4}]);
    });
    const callback = vi.fn();
    safeLookup("example.com", {all: true}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message: `Refused to connect to private address ${address} for example.com`}), "", 0);
  });

  test("accepts a single public DNS answer and preserves its family", () => {
    dnsMock.lookup.mockImplementation((_hostname, _options, callback) => { callback(null, "8.8.8.8", 4); });
    const callback = vi.fn();
    safeLookup("example.com", {all: false}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, "8.8.8.8", 4);
  });

  test("rejects a single private DNS answer", () => {
    dnsMock.lookup.mockImplementation((_hostname, _options, callback) => { callback(null, "10.0.0.1", 4); });
    const callback = vi.fn();
    safeLookup("example.com", {all: false}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(Error), "", 0);
  });

  test("propagates DNS errors", () => {
    const error = Object.assign(new Error("DNS unavailable"), {code: "ENOTFOUND"});
    dnsMock.lookup.mockImplementation((_hostname, _options, callback) => { callback(error, "", 0); });
    const callback = vi.fn();
    safeLookup("example.com", {all: true}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(error, "", 0);
  });
});

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
