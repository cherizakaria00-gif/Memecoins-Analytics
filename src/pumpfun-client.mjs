const API_ROOT = "https://frontend-api-v3.pump.fun";
const PAGE_SIZE = 50;
const LISTS = [
  { sort: "market_cap", order: "DESC" },
  { sort: "created_timestamp", order: "DESC" },
  { sort: "last_reply", order: "DESC" }
];

const BONDING_CURVE_TARGET_LAMPORTS = 85_005_359_057;

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

/** pump.fun's own image CDN (redirects to its Cloudflare Images bucket): the same logo the pump.fun site shows, whatever host the metadata points to. */
export function pumpImageUrl(mint) {
  return typeof mint === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) ? `https://images.pump.fun/coin-image/${mint}?variant=86x86` : null;
}

/** Keeps only the pump.fun fields used for analysis; the unofficial API returns far more. */
export function mapPumpCoin(coin) {
  return {
    mint: coin?.mint ?? null,
    graduated: Boolean(coin?.complete),
    bondingProgress: coin?.complete ? 1 : Math.min(Math.max(asFiniteNumber(coin?.real_sol_reserves) / BONDING_CURVE_TARGET_LAMPORTS, 0), 1),
    athMarketCap: asFiniteNumber(coin?.ath_market_cap, null),
    replyCount: asFiniteNumber(coin?.reply_count),
    isLive: Boolean(coin?.is_currently_live),
    creator: coin?.creator ?? null,
    lastTradeAt: asFiniteNumber(coin?.last_trade_timestamp, null),
    twitter: typeof coin?.twitter === "string" ? coin.twitter : "",
    telegram: typeof coin?.telegram === "string" ? coin.telegram : "",
    website: typeof coin?.website === "string" ? coin.website : "",
    hasSocials: Boolean(coin?.twitter || coin?.telegram || coin?.website),
    url: coin?.mint ? `https://pump.fun/coin/${coin.mint}` : null
  };
}

async function fetchList({ sort, order, offset = 0 }, fetchImpl) {
  const url = `${API_ROOT}/coins?offset=${offset}&limit=${PAGE_SIZE}&sort=${sort}&order=${order}&includeNsfw=false`;
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; PulsePaperScanner/0.1)" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`pump.fun responded with HTTP ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

/**
 * Fetches pump.fun coin lists (unofficial API, may change or rate-limit) as a Map keyed by mint.
 * Never throws: pump.fun is an enrichment source, DEX Screener stays the market reference.
 */
export async function fetchPumpCoins({ fetchImpl = fetch } = {}) {
  const results = await Promise.allSettled(LISTS.map(list => fetchList(list, fetchImpl)));
  const coins = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const coin of result.value) {
      const mapped = mapPumpCoin(coin);
      if (mapped.mint && !coins.has(mapped.mint)) coins.set(mapped.mint, mapped);
    }
  }
  return coins;
}

const PUMP_SUPPLY = 1_000_000_000;
const POOL_LIKE_SHARE = 0.5;

/**
 * Concentration and insider stats from pump.fun's top-holders list. A single holder above 50 % of the
 * supply is the bonding curve or the AMM pool, not a trader, so it is left out of the shares.
 */
export function summarizeHolders(payload) {
  const holders = Array.isArray(payload?.topHolders) ? payload.topHolders : [];
  const traders = holders.filter(holder => asFiniteNumber(holder?.amount) / PUMP_SUPPLY <= POOL_LIKE_SHARE)
    .sort((first, second) => second.amount - first.amount);
  const share = list => list.reduce((total, holder) => total + asFiniteNumber(holder.amount), 0) / PUMP_SUPPLY * 100;
  const flagged = key => traders.filter(holder => holder?.[key]);
  return {
    totalHolders: asFiniteNumber(payload?.totalHolders),
    top10Pct: share(traders.slice(0, 10)),
    devPct: share(flagged("isDev")),
    sniperPct: share(flagged("isSniper")),
    bundlerPct: share(flagged("isBundler")),
    insidersPct: share(traders.filter(holder => holder?.isDev || holder?.isSniper || holder?.isBundler)),
    sniperCount: flagged("isSniper").length,
    bundlerCount: flagged("isBundler").length,
    reliable: holders.length > 0 && asFiniteNumber(payload?.totalHolders) >= 5
  };
}

const holderHistory = new Map();
const GROWTH_WINDOW_MS = 40 * 60_000;
const MIN_GROWTH_SPAN_MS = 3 * 60_000;
/** Holders gained per 10 minutes, measured over the samples this server has recorded (null until it has watched the token for 3+ minutes). */
export function recordHolderGrowth(mint, total, now) {
  if (!(total > 0)) return null;
  const series = (holderHistory.get(mint) ?? []).filter(point => now - point.at <= GROWTH_WINDOW_MS);
  if (!series.length || now - series[series.length - 1].at >= 60_000) series.push({ at: now, total });
  holderHistory.set(mint, series);
  if (holderHistory.size > 500) holderHistory.delete(holderHistory.keys().next().value);
  const first = series[0], last = series[series.length - 1];
  const span = last.at - first.at;
  return span >= MIN_GROWTH_SPAN_MS ? ((last.total - first.total) / span) * 600_000 : null;
}

const GROWTH_PCT_WINDOW_MS = 10 * 60_000;
/** Holder count growth in % over the last 10 minutes this server has watched the token (null until two samples at least a minute apart exist). */
export function holderGrowthPct(mint, now) {
  const series = (holderHistory.get(mint) ?? []).filter(point => now - point.at <= GROWTH_PCT_WINDOW_MS);
  if (series.length < 2) return null;
  const first = series[0], last = series[series.length - 1];
  return last.at - first.at >= 60_000 && first.total > 0 ? ((last.total - first.total) / first.total) * 100 : null;
}

const holderCache = new Map();
const HOLDER_TTL_MS = 5 * 60_000;

/** Holder stats for a pump.fun token (mints ending in "pump"). Null when unavailable. */
export async function fetchHolderStats(mint, { fetchImpl = fetch, now = Date.now(), ttlMs = HOLDER_TTL_MS } = {}) {
  const cached = holderCache.get(mint);
  if (cached && now - cached.at < ttlMs) return cached.stats;
  const response = await fetchImpl(`${API_ROOT}/coins/top-holders/${mint}`, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; PulsePaperScanner/0.1)" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) {
    holderCache.set(mint, { at: now - HOLDER_TTL_MS + 60_000, stats: null });
    return null;
  }
  const stats = summarizeHolders(await response.json());
  stats.growth10m = recordHolderGrowth(mint, stats.totalHolders, now);
  stats.growthPct = holderGrowthPct(mint, now);
  holderCache.set(mint, { at: now, stats });
  if (holderCache.size > 300) holderCache.delete(holderCache.keys().next().value);
  return stats;
}

const detailCache = new Map();
const DETAIL_TTL_MS = 5 * 60_000;

/** Bonding-curve state of one pump.fun token (for tokens missing from the ranked lists). Null when unknown. */
export async function fetchPumpCoinDetail(mint, { fetchImpl = fetch, now = Date.now() } = {}) {
  const cached = detailCache.get(mint);
  if (cached && now - cached.at < DETAIL_TTL_MS) return cached.coin;
  const response = await fetchImpl(`${API_ROOT}/coins-v2/${mint}`, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; PulsePaperScanner/0.1)" },
    signal: AbortSignal.timeout(8_000)
  });
  const coin = response.ok ? mapPumpCoin(await response.json()) : null;
  detailCache.set(mint, { at: now, coin });
  if (detailCache.size > 300) detailCache.delete(detailCache.keys().next().value);
  return coin;
}

/** Newest pump.fun coins (the "New" tab), newest first, over `pages` pages of 50. Throws when the first page fails. */
export async function fetchNewestCoins({ fetchImpl = fetch, pages = 3 } = {}) {
  const first = await fetchList({ sort: "created_timestamp", order: "DESC", offset: 0 }, fetchImpl);
  const rest = await Promise.allSettled(Array.from({ length: Math.max(pages - 1, 0) }, (_, index) => fetchList({ sort: "created_timestamp", order: "DESC", offset: (index + 1) * PAGE_SIZE }, fetchImpl)));
  const seen = new Set();
  return [...first, ...rest.flatMap(result => (result.status === "fulfilled" ? result.value : []))]
    .filter(coin => coin?.mint && !seen.has(coin.mint) && seen.add(coin.mint))
    .map(coin => ({
      ...mapPumpCoin(coin),
      name: String(coin?.name ?? ""), symbol: String(coin?.symbol ?? ""),
      createdAt: asFiniteNumber(coin?.created_timestamp, null),
      usdMarketCap: asFiniteNumber(coin?.usd_market_cap), marketCapSol: asFiniteNumber(coin?.market_cap),
      realSolReserves: asFiniteNumber(coin?.real_sol_reserves) / 1e9
    })).filter(coin => coin.createdAt).sort((first, second) => second.createdAt - first.createdAt);
}
