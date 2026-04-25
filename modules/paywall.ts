import axios from "axios";
import {PaywallAsset} from "./assets.js";
import {getLogger} from "./logging.js";

const logger = getLogger();

const headlineTimeoutMs = 15_000;
const serviceCheckTimeoutMs = 60_000;
const inflightCacheTtlMs = 120_000;

type ServiceRegistry = Record<string, (url: string) => string>;

const inflightRequests = new Map<string, Promise<PaywallResult>>();
const serviceStats = new Map<string, {successes: number; failures: number}>();

export function getServiceSuccessRate(serviceName: string): number {
  const stats = serviceStats.get(serviceName);
  if (undefined === stats || 0 === stats.successes + stats.failures) {
    return 0.5;
  }

  return stats.successes / (stats.successes + stats.failures);
}

function recordServiceResult(serviceName: string, available: boolean): void {
  let stats = serviceStats.get(serviceName);
  if (undefined === stats) {
    stats = {successes: 0, failures: 0};
    serviceStats.set(serviceName, stats);
  }

  if (true === available) {
    stats.successes += 1;
  } else {
    stats.failures += 1;
  }
}

function rankServices(services: PaywallServiceResult[]): PaywallServiceResult[] {
  return [...services].sort((a, b) => {
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }

    return getServiceSuccessRate(b.name) - getServiceSuccessRate(a.name);
  });
}

export function getInflightCount(): number {
  return inflightRequests.size;
}

const serviceRegistry: ServiceRegistry = {
  "archive.today": (url: string) => `https://archive.ph/newest/${url}`,
  "freedium": (url: string) => `https://freedium.cfd/${url}`,
  "google-webcache": (url: string) => `https://webcache.googleusercontent.com/search?q=cache:${url}`,
};

export type PaywallServiceResult = {
  name: string;
  url: string;
  available: boolean;
};

export type PaywallResult = {
  originalUrl: string;
  nofix: boolean;
  isDefault: boolean;
  headline: string | null;
  services: PaywallServiceResult[];
};

export function extractHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function matchPaywallAsset(url: string, paywallAssets: PaywallAsset[]): PaywallAsset | undefined {
  const hostname = extractHostname(url);
  if ("" === hostname) {
    return undefined;
  }

  let defaultAsset: PaywallAsset | undefined;

  for (const asset of paywallAssets) {
    for (const domain of asset.domains ?? []) {
      if ("*" === domain) {
        defaultAsset = asset;
        continue;
      }

      if (hostname === domain) {
        return asset;
      }

      if (true === asset.subdomainWildcard && hostname.endsWith(`.${domain}`)) {
        return asset;
      }
    }
  }

  return defaultAsset;
}

export function buildServiceUrl(serviceName: string, url: string): string | undefined {
  const builder = serviceRegistry[serviceName];
  if (undefined === builder) {
    return undefined;
  }

  return builder(url);
}

export async function extractHeadline(url: string): Promise<string | null> {
  try {
    const response = await axios.get(url, {
      timeout: headlineTimeoutMs,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; bot)",
      },
      responseType: "text",
    });

    const html = String(response.data);

    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (null !== ogTitleMatch) {
      return ogTitleMatch[1].trim();
    }

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (null !== titleMatch) {
      return titleMatch[1].trim();
    }

    return null;
  } catch (error: unknown) {
    logger.log(
      "debug",
      `Failed to extract headline from ${url}: ${error}`,
    );
    return null;
  }
}

export async function checkService(serviceUrl: string, headline: string | null): Promise<boolean> {
  try {
    const response = await axios.get(serviceUrl, {
      timeout: serviceCheckTimeoutMs,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; bot)",
      },
      responseType: "text",
      validateStatus: (status: number) => status < 400,
    });

    const body = String(response.data);

    if (null !== headline && "" !== headline) {
      const normalizedHeadline = headline.toLowerCase().replace(/\s+/g, " ").trim();
      const words = normalizedHeadline.split(" ").filter(word => word.length > 3);
      const significantWordCount = words.length;
      if (0 === significantWordCount) {
        return true;
      }

      const normalizedBody = body.toLowerCase();
      let matchedWords = 0;
      for (const word of words) {
        if (normalizedBody.includes(word)) {
          matchedWords += 1;
        }
      }

      const matchRatio = matchedWords / significantWordCount;
      return matchRatio >= 0.5;
    }

    return true;
  } catch {
    return false;
  }
}

async function executePaywallLookup(url: string, paywallAssets: PaywallAsset[]): Promise<PaywallResult> {
  const asset = matchPaywallAsset(url, paywallAssets);

  if (undefined === asset) {
    return {
      originalUrl: url,
      nofix: true,
      isDefault: false,
      headline: null,
      services: [],
    };
  }

  if (true === asset.nofix) {
    return {
      originalUrl: url,
      nofix: true,
      isDefault: false,
      headline: null,
      services: [],
    };
  }

  const isDefault = "default" === asset.name;
  const headline = await extractHeadline(url);

  const serviceChecks = (asset.services ?? []).map(async (serviceName: string) => {
    const serviceUrl = buildServiceUrl(serviceName, url);
    if (undefined === serviceUrl) {
      return {
        name: serviceName,
        url: "",
        available: false,
      };
    }

    const available = await checkService(serviceUrl, headline);
    recordServiceResult(serviceName, available);
    return {
      name: serviceName,
      url: serviceUrl,
      available,
    };
  });

  const services = await Promise.all(serviceChecks);

  return {
    originalUrl: url,
    nofix: false,
    isDefault,
    headline,
    services: rankServices(services),
  };
}

export async function getPaywallLinks(url: string, paywallAssets: PaywallAsset[]): Promise<PaywallResult> {
  const existing = inflightRequests.get(url);
  if (undefined !== existing) {
    logger.log(
      "info",
      `Paywall lookup already in-flight for ${url}, returning existing promise.`,
    );
    return existing;
  }

  const promise = executePaywallLookup(url, paywallAssets).finally(() => {
    const timer = setTimeout(() => {
      inflightRequests.delete(url);
    }, inflightCacheTtlMs);
    timer.unref();
  });

  inflightRequests.set(url, promise);
  return promise;
}
