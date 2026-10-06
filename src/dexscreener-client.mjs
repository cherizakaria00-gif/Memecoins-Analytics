import { calculateMarketSignal, calculatePumpAdjustment } from "./scoring.mjs";
import { fetchPumpCoins } from "./pumpfun-client.mjs";
import { fetchActiveMints } from "./geckoterminal-client.mjs";

const API_ROOT = "https://api.dexscreener.com";
const SOLANA_CHAIN = "solana";
const BATCH_SIZE = 30;
const MAX_TOKEN_ADDRESSES = 300;
const MAX_TOKENS = 150;
const CANDIDATE_ENDPOINTS = [
  "/token-boosts/latest/v1",
  "/token-boosts/top/v1",
  "/token-profiles/latest/v1"
];

const formatAge = minutes => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "PulsePaperScanner/0.1" },
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`DEX Screener responded with HTTP ${response.status}`);
  return response.json();
}

function selectBestPairs(pairs, addresses) {
  const addressSet = new Set(addresses);
  const bestPairs = new Map();
  for (const pair of pairs) {
    const address = pair?.baseToken?.address;
    if (pair?.chainId !== SOLANA_CHAIN || !addressSet.has(address)) continue;
    const current = bestPairs.get(address);
    if (!current || asFiniteNumber(pair?.liquidity?.usd) > asFiniteNumber(current?.liquidity?.usd)) {
      bestPairs.set(address, pair);
    }
  }
  return [...bestPairs.values()];
}

const CHANGE_KEY = { 1440: "h24", 360: "h6", 60: "h1", 5: "m5" };

/** Reconstructs the price N minutes ago from the percentage change over that window. */
function change24hPrice(pair, minutes) {
  const price = asFiniteNumber(pair?.priceUsd);
  const change = asFiniteNumber(pair?.priceChange?.[CHANGE_KEY[minutes]], null);
  return change == null || change <= -100 ? 0 : price / (1 + change / 100);
}

const X_HOSTS = new Set(["x.com", "twitter.com", "www.x.com", "www.twitter.com"]);

/** Returns the first valid https X/Twitter profile or post URL from DEX Screener socials, or null. */
export function findTwitterUrl(info, pumpTwitter = "") {
  const candidates = [...(Array.isArray(info?.socials) ? info.socials.filter(item => item?.type === "twitter").map(item => item.url) : []), pumpTwitter];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && X_HOSTS.has(url.hostname)) return url.href;
    } catch { /* not a URL */ }
  }
  return null;
}

const IMAGE_HOST = "cdn.dexscreener.com";

function safeImageUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== IMAGE_HOST) return null;
    url.searchParams.set("width", "128");
    url.searchParams.set("height", "128");
    return url.href;
  } catch {
    return null;
  }
}

/** SOL price in USD implied by a SOL-quoted pair (priceUsd / priceNative); 0 when the quote is not SOL. */
function solUsdFromPair(pair) {
  const native = asFiniteNumber(pair?.priceNative);
  const usd = asFiniteNumber(pair?.priceUsd);
  return pair?.quoteToken?.symbol === "SOL" && native > 0 && usd > 0 ? usd / native : 0;
}

export function mapPairToToken(pair, now = Date.now(), pump = null) {
  const createdAt = asFiniteNumber(pair?.pairCreatedAt, now);
  const ageMinutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  const liquidity = asFiniteNumber(pair?.liquidity?.usd);
  const volume = asFiniteNumber(pair?.volume?.h1);
  const change = asFiniteNumber(pair?.priceChange?.h1);
  const buys = asFiniteNumber(pair?.txns?.h1?.buys);
  const sells = asFiniteNumber(pair?.txns?.h1?.sells);
  const name = pair?.baseToken?.name?.trim() || "Token inconnu";
  const symbol = pair?.baseToken?.symbol?.trim() || "N/A";
  const marketCap = pair?.marketCap == null ? null : asFiniteNumber(pair.marketCap);
  const baseScore = calculateMarketSignal({ liquidity, volume, change, buys, sells, ageMinutes });
  const score = Math.min(100, Math.max(0, baseScore + calculatePumpAdjustment(pump, marketCap)));
  const athMarketCap = pump?.athMarketCap > 0 ? Math.max(pump.athMarketCap, marketCap ?? 0) : null;

  return {
    id: pair?.baseToken?.address ?? pair?.pairAddress,
    address: pair?.baseToken?.address ?? null,
    pairAddress: pair?.pairAddress ?? null,
    dexUrl: pair?.url ?? null,
    name,
    symbol,
    imageUrl: safeImageUrl(pair?.info?.imageUrl),
    twitterUrl: findTwitterUrl(pair?.info, pump?.twitter),
    initials: symbol.slice(0, 2).toUpperCase(),
    ageMinutes,
    age: formatAge(ageMinutes),
    liquidity,
    volume,
    volume5m: asFiniteNumber(pair?.volume?.m5),
    volume6h: asFiniteNumber(pair?.volume?.h6),
    volume24h: asFiniteNumber(pair?.volume?.h24),
    change,
    change5m: asFiniteNumber(pair?.priceChange?.m5),
    change6h: asFiniteNumber(pair?.priceChange?.h6),
    change24h: asFiniteNumber(pair?.priceChange?.h24),
    price: asFiniteNumber(pair?.priceUsd),
    solPriceUsd: solUsdFromPair(pair),
    marketCap,
    athMarketCap,
    pump: pump ? { graduated: pump.graduated, bondingProgress: pump.bondingProgress, replyCount: pump.replyCount, isLive: pump.isLive, hasSocials: pump.hasSocials, url: pump.url } : null,
    priceAnchors: [
      [1440, change24hPrice(pair, 24 * 60)],
      [360, change24hPrice(pair, 6 * 60)],
      [60, change24hPrice(pair, 60)],
      [5, change24hPrice(pair, 5)],
      [0, asFiniteNumber(pair?.priceUsd)]
    ].filter(([minutes, price]) => price > 0 && minutes <= Math.max(ageMinutes, 0))
      .map(([minutes, price]) => ({ t: now - minutes * 60_000, price })),
    transactions: asFiniteNumber(pair?.txns?.h24?.buys) + asFiniteNumber(pair?.txns?.h24?.sells),
    traders: null,
    accent: score >= 70 ? "#b8f55d" : score >= 50 ? "#ffc65c" : "#ff6b62",
    holders: null,
    lock: null,
    top10: null,
    mint: null,
    freeze: null,
    score,
    risk: "Non audité",
    buys,
    sells,
    buys5m: asFiniteNumber(pair?.txns?.m5?.buys),
    sells5m: asFiniteNumber(pair?.txns?.m5?.sells),
    buys6h: asFiniteNumber(pair?.txns?.h6?.buys),
    sells6h: asFiniteNumber(pair?.txns?.h6?.sells),
    dex: pair?.dexId ?? "DEX"
  };
}

async function fetchCandidateAddresses(fetchImpl) {
  const results = await Promise.allSettled(CANDIDATE_ENDPOINTS.map(path => fetchJson(fetchImpl, `${API_ROOT}${path}`)));
  const addresses = new Set();
  for (const result of results) {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
    for (const item of result.value) {
      if (item?.chainId === SOLANA_CHAIN && item?.tokenAddress) addresses.add(item.tokenAddress);
    }
  }
  return [...addresses].slice(0, MAX_TOKEN_ADDRESSES);
}

/** Fetches Solana candidates from several DEX Screener lists and keeps each token's most liquid pair, ranked by 24h volume. */
export async function fetchLiveSolanaTokens({ fetchImpl = fetch, now = Date.now() } = {}) {
  const [dexAddresses, pumpCoins, activeMints] = await Promise.all([
    fetchCandidateAddresses(fetchImpl), fetchPumpCoins({ fetchImpl }), fetchActiveMints({ fetchImpl, now })
  ]);
  // Real activity first: tokens traders actually trade matter more than promoted or merely new ones.
  const addresses = [...new Set([...activeMints, ...dexAddresses, ...pumpCoins.keys()])].slice(0, MAX_TOKEN_ADDRESSES);
  if (addresses.length === 0) throw new Error("No recent Solana candidates returned by DEX Screener");

  const batches = [];
  for (let index = 0; index < addresses.length; index += BATCH_SIZE) batches.push(addresses.slice(index, index + BATCH_SIZE));
  const responses = await Promise.allSettled(batches.map(batch => fetchJson(fetchImpl, `${API_ROOT}/tokens/v1/${SOLANA_CHAIN}/${batch.join(",")}`)));
  const pairs = responses.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []);

  const tokens = selectBestPairs(pairs, addresses).map(pair => mapPairToToken(pair, now, pumpCoins.get(pair?.baseToken?.address)))
    .filter(token => token.price > 0 && token.liquidity > 0)
    .sort((first, second) => second.volume24h - first.volume24h)
    .slice(0, MAX_TOKENS);

  if (tokens.length === 0) throw new Error("No usable Solana market pairs returned by DEX Screener");
  return tokens;
}

/** Fetches the current market data of specific Solana tokens (e.g. open paper positions that left the ranked feed). */
export async function fetchTokensByAddress(addresses, { fetchImpl = fetch, now = Date.now() } = {}) {
  const unique = [...new Set(addresses)].slice(0, MAX_TOKEN_ADDRESSES);
  const batches = [];
  for (let index = 0; index < unique.length; index += BATCH_SIZE) batches.push(unique.slice(index, index + BATCH_SIZE));
  const responses = await Promise.allSettled(batches.map(batch => fetchJson(fetchImpl, `${API_ROOT}/tokens/v1/${SOLANA_CHAIN}/${batch.join(",")}`)));
  const pairs = responses.flatMap(result => result.status === "fulfilled" && Array.isArray(result.value) ? result.value : []);
  return selectBestPairs(pairs, unique).map(pair => mapPairToToken(pair, now)).filter(token => token.price > 0);
}

/** Searches DEX Screener for Solana tokens by name, symbol or address; best (most liquid) pair per token. */
export async function searchSolanaTokens(query, { fetchImpl = fetch, now = Date.now() } = {}) {
  const payload = await fetchJson(fetchImpl, `${API_ROOT}/latest/dex/search?q=${encodeURIComponent(query)}`);
  const pairs = (Array.isArray(payload?.pairs) ? payload.pairs : []).filter(pair => pair?.chainId === SOLANA_CHAIN && pair?.baseToken?.address);
  const addresses = pairs.map(pair => pair.baseToken.address);
  return selectBestPairs(pairs, addresses).map(pair => mapPairToToken(pair, now))
    .filter(token => token.price > 0)
    .sort((first, second) => second.liquidity - first.liquidity)
    .slice(0, 8);
}
