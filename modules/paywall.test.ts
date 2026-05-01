import type {Mocked} from "vitest";
import axios from "axios";
import {PaywallAsset} from "./assets.ts";
import {beforeEach, describe, expect, test, vi} from "vitest";
import {
  extractHostname,
  matchPaywallAsset,
  buildServiceUrl,
  extractHeadline,
  checkService,
  getPaywallLinks,
  getServiceSuccessRate,
  getInflightCount,
  PaywallLookupCapacityError,
} from "./paywall.ts";

vi.mock("axios");
vi.mock("./logging.ts", () => ({
  getLogger: () => ({
    log: vi.fn(),
  }),
}));

const mockedAxios = axios as Mocked<typeof axios>;

beforeEach(() => {
  mockedAxios.get.mockReset();
});

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
    createPaywallAsset({name: "medium", domains: ["medium.com"], services: ["archive.today"], subdomainWildcard: true}),
    createPaywallAsset({name: "puck", domains: ["puck.news"], nofix: true}),
    createPaywallAsset({name: "default", domains: ["*"], services: ["archive.today"]}),
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
    const result = matchPaywallAsset("https://www.puck.news/article", assets);
    expect(result?.name).toBe("puck");
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

  test("returns undefined for unknown service", () => {
    expect(buildServiceUrl("nonexistent", "https://example.com")).toBeUndefined();
  });

  test("does not build retired freedium service URLs", () => {
    expect(buildServiceUrl("freedium", "https://medium.com/article")).toBeUndefined();
  });

  test("does not build retired google cache service URLs", () => {
    expect(buildServiceUrl("google-webcache", "https://example.com/article")).toBeUndefined();
  });
});

describe("extractHeadline", () => {
  test("extracts og:title", async () => {
    mockedAxios.get.mockResolvedValueOnce({
      data: '<html><head><meta property="og:title" content="Breaking News Article"></head></html>',
    });

    const result = await extractHeadline("https://example.com/article");
    expect(result).toBe("Breaking News Article");
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://example.com/article",
      expect.objectContaining({
        maxContentLength: expect.any(Number),
        maxBodyLength: expect.any(Number),
        httpAgent: expect.any(Object),
        httpsAgent: expect.any(Object),
      }),
    );
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
    expect(mockedAxios.get).toHaveBeenCalledWith(
      "https://archive.ph/newest/test",
      expect.objectContaining({
        maxContentLength: expect.any(Number),
        maxBodyLength: expect.any(Number),
        httpAgent: expect.any(Object),
        httpsAgent: expect.any(Object),
      }),
    );
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
    createPaywallAsset({name: "nytimes", domains: ["nytimes.com"], services: ["archive.today"]}),
    createPaywallAsset({name: "puck", domains: ["puck.news"], nofix: true}),
    createPaywallAsset({name: "default", domains: ["*"], services: ["archive.today"]}),
  ];

  test("returns nofix result for nofix domain", async () => {
    const result = await getPaywallLinks("https://www.puck.news/article", assets);
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
    expect(result.services).toHaveLength(1);
    const serviceNames = result.services.map(s => s.name).sort();
    expect(serviceNames).toEqual(["archive.today"]);
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
    expect(getInflightCount()).toBe(0);
  });

  test("limits active unique lookups globally", async () => {
    const limitedAssets = [
      createPaywallAsset({name: "default", domains: ["*"], services: []}),
    ];
    const resolvers: ((value: {data: string}) => void)[] = [];
    mockedAxios.get.mockImplementation(() => new Promise(resolve => {
      resolvers.push(resolve);
    }));

    const activeLookups = [0, 1, 2, 3].map(index => getPaywallLinks(
      `https://www.example-${index}.com/article`,
      limitedAssets,
      {requesterId: `user-${index}`},
    ));

    expect(getInflightCount()).toBe(4);
    await expect(getPaywallLinks(
      "https://www.example-overflow.com/article",
      limitedAssets,
      {requesterId: "overflow-user"},
    )).rejects.toThrow(PaywallLookupCapacityError);

    for (const resolve of resolvers) {
      resolve({data: "<html><head><title>Done</title></head></html>"});
    }

    await Promise.all(activeLookups);
    expect(getInflightCount()).toBe(0);
  });

  test("limits active lookups per requester while allowing duplicate URL dedupe", async () => {
    const limitedAssets = [
      createPaywallAsset({name: "default", domains: ["*"], services: []}),
    ];
    let resolveHeadline: ((value: {data: string}) => void) | undefined;
    mockedAxios.get.mockImplementation(() => new Promise(resolve => {
      resolveHeadline = resolve;
    }));

    const activeLookup = getPaywallLinks(
      "https://www.example.com/first",
      limitedAssets,
      {requesterId: "same-user"},
    );
    const duplicateLookup = getPaywallLinks(
      "https://www.example.com/first",
      limitedAssets,
      {requesterId: "same-user"},
    );

    await expect(getPaywallLinks(
      "https://www.example.com/second",
      limitedAssets,
      {requesterId: "same-user"},
    )).rejects.toThrow(PaywallLookupCapacityError);
    expect(getInflightCount()).toBe(1);

    resolveHeadline?.({data: "<html><head><title>Done</title></head></html>"});
    const [result, duplicateResult] = await Promise.all([activeLookup, duplicateLookup]);
    expect(result).toBe(duplicateResult);
    expect(getInflightCount()).toBe(0);
  });

  test("ranks available services before unavailable ones", async () => {
    const rankAssets = [
      createPaywallAsset({name: "nytimes", domains: ["nytimes.com"], services: ["archive.today", "archive.today"]}),
    ];
    let callCount = 0;
    mockedAxios.get.mockImplementation(async () => {
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
    const result = await getPaywallLinks(rankUrl, rankAssets);
    const availableServices = result.services.filter(s => s.available);
    const unavailableServices = result.services.filter(s => !s.available);

    expect(availableServices.length).toBeGreaterThan(0);
    expect(unavailableServices.length).toBeGreaterThan(0);

    const lastAvailableIndex = result.services.findIndex(s => s === availableServices[availableServices.length - 1]);
    const firstUnavailableIndex = result.services.findIndex(s => s === unavailableServices[0]);
    expect(lastAvailableIndex).toBeLessThan(firstUnavailableIndex);
  });
});

describe("getServiceSuccessRate", () => {
  test("returns 0.5 for unknown service", () => {
    expect(getServiceSuccessRate("never-seen-service")).toBe(0.5);
  });
});
