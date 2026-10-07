/**
 * Jupiter Tokens API v2 (needs JUPITER_API_KEY): holder count, Organic Score, mint / freeze authorities, dev balance and
 * organic (non-bot) buyers and volume for any Solana token, up to 100 tokens per request.
 */
const API_URL = "https://api.jup.ag/tokens/v2";
const BATCH = 100;
const TTL_MS = 60_000;
const num = value => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);
const cache = new Map();

export const jupiterEnabled = (env = process.env) => Boolean(env.JUPITER_API_KEY);

export function mapJupiterToken(raw) {
  const stats = raw?.stats1h ?? {};
  const volume = (num(stats.buyVolume) ?? 0) + (num(stats.sellVolume) ?? 0);
  const organicVolume = (num(stats.buyOrganicVolume) ?? 0) + (num(stats.sellOrganicVolume) ?? 0);
  return {
    holderCount: num(raw?.holderCount),
    organicScore: num(raw?.organicScore),
    organicLabel: typeof raw?.organicScoreLabel === "string" ? raw.organicScoreLabel : null,
    verified: raw?.isVerified === true,
    links: { website: raw?.website, twitter: raw?.twitter, telegram: raw?.telegram, discord: raw?.discord },
    mintAuthorityDisabled: raw?.audit?.mintAuthorityDisabled ?? null,
    freezeAuthorityDisabled: raw?.audit?.freezeAuthorityDisabled ?? null,
    topHoldersPct: num(raw?.audit?.topHoldersPercentage),
    devBalancePct: num(raw?.audit?.devBalancePercentage),
    organicBuyers1h: num(stats.numOrganicBuyers),
    netBuyers1h: num(stats.numNetBuyers),
    traders1h: num(stats.numTraders),
    organicVolumeRatio: volume > 0 && stats.buyOrganicVolume != null ? Math.min(organicVolume / volume, 1) : null
  };
}

/** Jupiter data by mint. Resolves to an empty map without an API key or when the API fails (the scanner then works as before). */
export async function fetchJupiterTokens(mints, { fetchImpl = fetch, now = Date.now(), env = process.env } = {}) {
  const key = env.JUPITER_API_KEY;
  const result = new Map();
  if (!key) return result;
  const missing = [];
  for (const mint of new Set(mints)) {
    const hit = cache.get(mint);
    if (hit && now - hit.at < TTL_MS) { if (hit.data) result.set(mint, hit.data); } else missing.push(mint);
  }
  for (let index = 0; index < missing.length; index += BATCH) {
    const chunk = missing.slice(index, index + BATCH);
    try {
      const response = await fetchImpl(`${API_URL}/search?query=${chunk.join(",")}`, { headers: { accept: "application/json", "x-api-key": key }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const found = new Map((await response.json()).map(raw => [raw.id, mapJupiterToken(raw)]));
      for (const mint of chunk) {
        const data = found.get(mint) ?? null;
        cache.set(mint, { at: now, data });
        if (data) result.set(mint, data);
      }
    } catch (error) {
      for (const mint of chunk) cache.set(mint, { at: now - TTL_MS + 15_000, data: null }); // retry in 15 s
      console.warn("Jupiter tokens unavailable:", String(error.message).slice(0, 80));
    }
  }
  if (cache.size > 1000) for (const mint of cache.keys()) { cache.delete(mint); if (cache.size <= 600) break; }
  return result;
}

export const _test = { cache };
