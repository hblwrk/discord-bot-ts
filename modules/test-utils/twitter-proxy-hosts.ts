const fxDomains = ["fxtwitter.com", "fixupx.com", "twittpr.com", "xfixup.com"];
const vxDomains = ["vxtwitter.com", "fixvx.com"];
const fxModifiers = ["d", "dl", "t", "i", "g", "m", "o"];

export const twitterProxyHosts = [
  ...fxDomains.flatMap(domain => [domain, ...fxModifiers.map(modifier => `${modifier}.${domain}`)]),
  ...vxDomains.flatMap(domain => [domain, `c.${domain}`]),
  ...[...fxDomains, ...vxDomains].map(domain => `www.${domain}`),
];
