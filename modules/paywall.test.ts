import axios from "axios";
import {PaywallAsset} from "./assets.js";
import {
  extractHostname,
  matchPaywallAsset,
  buildServiceUrl,
  extractHeadline,
  checkService,
  getPaywallLinks,
  getServiceSuccessRate,
  getInflightCount,
} from "./paywall.js";

jest.mock("axios");
jest.mock("./logging.js", () => ({
  getLogger: () => ({
    log: jest.fn(),
  }),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;

function createPaywallAsset(overrides: Partial<{name: string; domains: string[]; services: string[]; nofix: boolean; subdomainWildcard: boolean}>): PaywallAsset {
  const asset = new PaywallAsset();
  asset.name = overrides.name ?? "test";
  asset.domains = overrides.domains ?? [];
  asset.services = overrides.services ?? [];
  asset.nofix = overrides.nofix ?? false;
  asset.subdomainWildcard = overrides.subdomainWildcard ?? false;
  return asset;
}

describe("extractHostname", () => {
  test("extracts hostname from URL", () => {
    expect(extractHostname("https://www.nytimes.com/2024/article")).toBe("nytimes.com");
  });

  test("strips www prefix", () => {
    expect(extractHostname("https://www.spiegel.de/article")).toBe("spiegel.de");
  });

  test("keeps subdomains other than www", () => {
    expect(extractHostname("https://tech.medium.com/article")).toBe("tech.medium.com");
  });

  test("returns empty string for invalid URL", () => {
    expect(extractHostname("not-a-url")).toBe("");
  });
});

describe("matchPaywallAsset", () => {
  const assets = [
    createPaywallAsset({name: "nytimes", domains: ["nytimes.com"], services: ["archive.today"]}),
    createPaywallAsset({name: "medium", domains: ["medium.com"], services: ["freedium"], subdomainWildcard: true}),
    createPaywallAsset({name: "handelsblatt", domains: ["handelsblatt.com"], nofix: true}),
    createPaywallAsset({name: "default", domains: ["*"], services: ["archive.today", "google-webcache"]}),
  ];

  test("matches exact domain", () => {
    const result = matchPaywallAsset("https://www.nytimes.com/article", assets);
    expect(result?.name).toBe("nytimes");
  });

  test("matches subdomain wildcard", () => {
    const result = matchPaywallAsset("https://tech.medium.com/article", assets);
    expect(result?.name).toBe("medium");
  });

  test("matches base domain for subdomain wildcard entry", () => {
    const result = matchPaywallAsset("https://medium.com/article", assets);
    expect(result?.name).toBe("medium");
  });

  test("matches nofix domain", () => {
    const result = matchPaywallAsset("https://www.handelsblatt.com/article", assets);
    expect(result?.name).toBe("handelsblatt");
  });

  test("falls back to default for unknown domain", () => {
    const result = matchPaywallAsset("https://www.unknown-site.com/article", assets);
    expect(result?.name).toBe("default");
  });

  test("returns undefined for invalid URL", () => {
    const result = matchPaywallAsset("not-a-url", assets);
    expect(result).toBeUndefined();
  });
});

describe("buildServiceUrl", () => {
  test("builds archive.today URL", () => {
    expect(buildServiceUrl("archive.today", "https://example.com/article"))
      .toBe("https://archive.ph/newest/https://example.com/article");
  });

  test("builds freedium URL", () => {
    expect(buildServiceUrl("freedium", "https://medium.com/article"))
      .toBe("https://freedium.cfd/https://medium.com/article");
  });

  test("builds google-webcache URL", () => {
    expect(buildServiceUrl("google-webcache", "https://example.com/article"))
      .toBe("https://webcache.googleusercontent.com/search?q=cache:https://example.com/article");
  });

  test("returns undefined for unknown service", () => {
    expect(buildServiceUrl("nonexistent", "https://example.com")).toBeUndefined();
  });
});

describe("extractHeadline", () => {
  test("extracts og:title", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: '<html><head><meta property="og:title" content="Breaking News Article"></head></html>',
    });

    const result = await extractHeadline("https://example.com/article");
    expect(result).toBe("Breaking News Article");
  });

  test("extracts og:title with reversed attribute order", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: '<html><head><meta content="Reversed Order Title" property="og:title"></head></html>',
    });

    const result = await extractHeadline("https://example.com/article");
    expect(result).toBe("Reversed Order Title");
  });

  test("falls back to title tag", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: "<html><head><title>Page Title Here</title></head></html>",
    });

    const result = await extractHeadline("https://example.com/article");
    expect(result).toBe("Page Title Here");
  });

  test("returns null when no title found", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: "<html><head></head><body>No title</body></html>",
    });

    const result = await extractHeadline("https://example.com/article");
    expect(result).toBeNull();
  });

  test("returns null on network error", async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error("Network error"));

    const result = await extractHeadline("https://example.com/article");
    expect(result).toBeNull();
  });
});

describe("checkService", () => {
  test("returns true when headline words found in response", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: "<html><body>This is the Breaking News Article content with more text</body></html>",
    });

    const result = await checkService("https://archive.ph/newest/test", "Breaking News Article");
    expect(result).toBe(true);
  });

  test("returns false when headline words not found in response", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: "<html><body>Completely unrelated content about cooking recipes</body></html>",
    });

    const result = await checkService("https://archive.ph/newest/test", "Breaking News Article");
    expect(result).toBe(false);
  });

  test("returns true when no headline provided and HTTP succeeds", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: "<html><body>Some content</body></html>",
    });

    const result = await checkService("https://archive.ph/newest/test", null);
    expect(result).toBe(true);
  });

  test("returns false on network error", async () => {
    mockedAxios.get.mockRejectedValueOnce(new Error("timeout"));

    const result = await checkService("https://archive.ph/newest/test", "Test Headline");
    expect(result).toBe(false);
  });
});

describe("getPaywallLinks", () => {
  const assets = [
    createPaywallAsset({name: "nytimes", domains: ["nytimes.com"], services: ["archive.today", "google-webcache"]}),
    createPaywallAsset({name: "handelsblatt", domains: ["handelsblatt.com"], nofix: true}),
    createPaywallAsset({name: "default", domains: ["*"], services: ["archive.today"]}),
  ];

  test("returns nofix result for nofix domain", async () => {
    const result = await getPaywallLinks("https://www.handelsblatt.com/article", assets);
    expect(result.nofix).toBe(true);
    expect(result.services).toHaveLength(0);
  });

  test("returns nofix result for invalid URL", async () => {
    const result = await getPaywallLinks("not-a-url", assets);
    expect(result.nofix).toBe(true);
  });

  test("checks services for known domain", async () => {
    mockedAxios.get.mockResolvedValue({
      data: '<html><head><meta property="og:title" content="Big Story"></head><body>Big Story content here</body></html>',
    });

    const result = await getPaywallLinks("https://www.nytimes.com/article", assets);
    expect(result.nofix).toBe(false);
    expect(result.isDefault).toBe(false);
    expect(result.services).toHaveLength(2);
    const serviceNames = result.services.map(s => s.name).sort();
    expect(serviceNames).toEqual(["archive.today", "google-webcache"]);
    expect(result.services.every(s => s.available)).toBe(true);
  });

  test("marks isDefault for unknown domains", async () => {
    mockedAxios.get.mockResolvedValue({
      data: "<html><head><title>Some Article</title></head><body>Some Article text</body></html>",
    });

    const result = await getPaywallLinks("https://www.unknown-site.com/article", assets);
    expect(result.nofix).toBe(false);
    expect(result.isDefault).toBe(true);
  });

  test("deduplicates concurrent requests for the same URL", async () => {
    mockedAxios.get.mockResolvedValue({
      data: '<html><head><title>Dedup Test</title></head><body>Dedup Test content</body></html>',
    });

    const uniqueUrl = `https://www.nytimes.com/dedup-test-${Date.now()}`;
    const [result1, result2] = await Promise.all([
      getPaywallLinks(uniqueUrl, assets),
      getPaywallLinks(uniqueUrl, assets),
    ]);

    expect(result1).toBe(result2);
  });

  test("ranks available services before unavailable ones", async () => {
    let callCount = 0;
    mockedAxios.get.mockImplementation(async (url: string) => {
      callCount += 1;
      if (1 === callCount) {
        return {data: '<html><head><title>Rank Test</title></head><body>Rank Test article</body></html>'};
      }

      if (2 === callCount) {
        throw new Error("service down");
      }

      return {data: '<html><body>Rank Test article text here</body></html>'};
    });

    const rankUrl = `https://www.nytimes.com/rank-test-${Date.now()}`;
    const result = await getPaywallLinks(rankUrl, assets);
    const availableServices = result.services.filter(s => s.available);
    const unavailableServices = result.services.filter(s => !s.available);

    if (availableServices.length > 0 && unavailableServices.length > 0) {
      const lastAvailableIndex = result.services.findIndex(s => s === availableServices[availableServices.length - 1]);
      const firstUnavailableIndex = result.services.findIndex(s => s === unavailableServices[0]);
      expect(lastAvailableIndex).toBeLessThan(firstUnavailableIndex);
    }
  });
});

describe("getServiceSuccessRate", () => {
  test("returns 0.5 for unknown service", () => {
    expect(getServiceSuccessRate("never-seen-service")).toBe(0.5);
  });
});
