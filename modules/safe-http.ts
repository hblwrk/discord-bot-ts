import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import {type Duplex} from "node:stream";

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (4 !== parts.length) {
    return true;
  }

  for (const part of parts) {
    if (Number.isNaN(part) || part < 0 || part > 255) {
      return true;
    }
  }

  const [a, b] = parts;
  if (undefined === a || undefined === b) {
    return true;
  }

  if (0 === a) return true;                            // 0.0.0.0/8
  if (10 === a) return true;                           // 10.0.0.0/8 RFC1918
  if (100 === a && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 CGNAT
  if (127 === a) return true;                          // 127.0.0.0/8 loopback
  if (169 === a && 254 === b) return true;             // 169.254.0.0/16 link-local + cloud metadata
  if (172 === a && b >= 16 && b <= 31) return true;    // 172.16.0.0/12 RFC1918
  if (192 === a && 0 === b) return true;               // 192.0.0.0/24 + 192.0.2.0/24 docs
  if (192 === a && 168 === b) return true;             // 192.168.0.0/16 RFC1918
  if (198 === a && (18 === b || 19 === b)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true;                           // multicast/reserved/broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if ("::" === lower || "::1" === lower) {
    return true;
  }

  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (null !== v4mapped) {
    const mappedIpv4 = v4mapped[1];
    return undefined === mappedIpv4 ? true : isPrivateIpv4(mappedIpv4);
  }

  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(lower)) return true;    // fc00::/7 unique local
  if (lower.startsWith("ff")) return true;  // ff00::/8 multicast
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (4 === family) {
    return isPrivateIpv4(ip);
  }

  if (6 === family) {
    return isPrivateIpv6(ip);
  }

  return true;
}

const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, options, (err, address, family) => {
    if (null !== err) {
      callback(err, address, family);
      return;
    }

    const resolved = address as string;
    if (true === isPrivateIp(resolved)) {
      const blockError = new Error(`Refused to connect to private address ${resolved} for ${hostname}`);
      callback(blockError, "", 0);
      return;
    }

    callback(null, resolved, family);
  });
};

class SafeHttpAgent extends http.Agent {
  public override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const merged = {...options, lookup: safeLookup} as http.ClientRequestArgs;
    return super.createConnection(merged, callback);
  }
}

class SafeHttpsAgent extends https.Agent {
  public override createConnection(options: http.ClientRequestArgs, callback?: (err: Error | null, stream: Duplex) => void): Duplex | null | undefined {
    const merged = {...options, lookup: safeLookup} as http.ClientRequestArgs;
    return super.createConnection(merged, callback);
  }
}

export const safeHttpAgent = new SafeHttpAgent();
export const safeHttpsAgent = new SafeHttpsAgent();

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

export function assertSafeRequestUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }

  if ("http:" !== parsed.protocol && "https:" !== parsed.protocol) {
    throw new UnsafeUrlError(`Refused protocol ${parsed.protocol}`);
  }

  if ("" !== parsed.username || "" !== parsed.password) {
    throw new UnsafeUrlError("Refused URL with embedded credentials");
  }

  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (0 !== net.isIP(hostname) && true === isPrivateIp(hostname)) {
    throw new UnsafeUrlError(`Refused private address ${hostname}`);
  }

  return parsed;
}
