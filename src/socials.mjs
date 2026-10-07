/**
 * Social presence of a token: website, X, Telegram and Discord links merged from DEX Screener, pump.fun and Jupiter.
 * Only https links on the expected hosts are kept (a profile link is never trusted blindly: it is shown as "claimed", not verified).
 */
const HOSTS = {
  twitter: ["x.com", "twitter.com"],
  telegram: ["t.me", "telegram.me", "telegram.org", "telegram.dog"],
  discord: ["discord.gg", "discord.com", "discordapp.com"]
};
export const PLATFORMS = ["website", "twitter", "telegram", "discord"];
const BLOCKED_WEBSITES = /(^|\.)((pump\.fun)|(dexscreener\.com)|(solscan\.io)|(jup\.ag))$/i;

function accepts(platform, url) {
  const host = url.hostname.replace(/^www\./, "").toLowerCase();
  if (platform === "website") return !BLOCKED_WEBSITES.test(host) && ![...HOSTS.twitter, ...HOSTS.telegram, ...HOSTS.discord].includes(host);
  return HOSTS[platform].some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

function clean(platform, candidate) {
  if (typeof candidate !== "string" || candidate.length > 300) return null;
  const text = candidate.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.protocol === "https:" && accepts(platform, url) ? url.href : null;
  } catch { return null; }
}

const typeOf = (type, url) => {
  const name = String(type ?? "").toLowerCase();
  if (name === "x") return "twitter";
  if (PLATFORMS.includes(name)) return name;
  return null;
};

/** `sources` are loose objects: DEX Screener's `info` ({socials: [{type, url}], websites: [{url}]}) or direct links ({website, twitter, telegram, discord}). */
export function buildSocials(...sources) {
  const found = {};
  const take = (platform, candidate) => { if (platform && !found[platform]) { const url = clean(platform, candidate); if (url) found[platform] = url; } };
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const item of Array.isArray(source.socials) ? source.socials : []) take(typeOf(item?.type, item?.url), item?.url);
    for (const item of Array.isArray(source.websites) ? source.websites : []) take("website", item?.url);
    for (const platform of PLATFORMS) take(platform, source[platform]);
  }
  const socials = { website: found.website ?? null, twitter: found.twitter ?? null, telegram: found.telegram ?? null, discord: found.discord ?? null };
  return { ...socials, count: PLATFORMS.filter(platform => socials[platform]).length };
}
