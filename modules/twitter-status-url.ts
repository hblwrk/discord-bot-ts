const fxHosts = new Set(["fxtwitter.com", "fixupx.com", "twittpr.com", "xfixup.com"]);
const vxHosts = new Set(["vxtwitter.com", "fixvx.com"]);
const fxModifiers = new Set(["d", "dl", "t", "i", "g", "m", "o"]);

// Resolve only known proxy post URLs. Metadata always uses the fixed FxTwitter
// API endpoint, never the supplied host, query parameters or redirect target.
export function getTwitterStatusId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password) {
      return undefined;
    }
    const host = url.hostname.replace(/^www\./u, "");
    const [modifier, ...parts] = host.split(".");
    const baseHost = parts.join(".");
    if (!fxHosts.has(host) && !vxHosts.has(host)
      && !(fxModifiers.has(modifier ?? "") && fxHosts.has(baseHost))
      && !(modifier === "c" && vxHosts.has(baseHost))) {
      return undefined;
    }
    return /^\/(?:[a-z0-9_]{1,15}|i\/web)\/status\/(\d{2,20})(?:\/(?:photo|video)\/[1-4])?\/?$/iu.exec(url.pathname)?.[1];
  } catch {
    return undefined;
  }
}
