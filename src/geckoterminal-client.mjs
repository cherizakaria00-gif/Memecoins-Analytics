const API_ROOT = "https://api.geckoterminal.com/api/v2/networks/solana";
const CACHE_TTL_MS = 90_000;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LISTS = [
  "/trending_pools?duration=5m&page=1",
  "/trending_pools?duration=5m&page=2",
  "/trending_pools?duration=1h&page=1",
  "/trending_pools?duration=1h&page=2",
  "/trending_pools?duration=6h&page=1",
  "/trending_pools?duration=24h&page=1",
  "/pools?sort=h24_tx_count_desc&page=1",
  "/pools?sort=h24_volume_usd_desc&page=1",
  "/new_pools?page=1",
  "/new_pools?page=2"
];
let cache = null;

/** Extracts base-token mint addresses ("solana_<mint>") from a GeckoTerminal pools response. */
export function extractMints(payload) {
  const mints = [];
  for (const pool of Array.isArray(payload?.data) ? payload.data : []) {
    const id = String(pool?.relationships?.base_token?.data?.id ?? "");
    const mint = id.startsWith("solana_") ? id.slice("solana_".length) : "";
    if (SOLANA_ADDRESS.test(mint)) mints.push(mint);
  }
  return mints;
}

/**
 * Mints of the most active Solana pools (trending 1h/6h/24h, most transactions, most volume, newest).
 * Ranked by real activity, which catches tokens that never bought a DEX Screener boost. Never throws.
 */
export async function fetchActiveMints({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.mints;
  const results = await Promise.allSettled(LISTS.map(async path => {
    const response = await fetchImpl(`${API_ROOT}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`GeckoTerminal responded with HTTP ${response.status}`);
    return extractMints(await response.json());
  }));
  const mints = [...new Set(results.flatMap(result => (result.status === "fulfilled" ? result.value : [])))];
  if (mints.length) cache = { at: now, mints };
  return mints.length ? mints : cache?.mints ?? [];
}
