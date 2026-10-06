import { fetchLiveSolanaTokens, fetchTokensByAddress, searchSolanaTokens } from "./dexscreener-client.mjs";
import { listTokens as listMockTokens } from "./token-source.mjs";
import { evaluateSignal, riskFromGrade } from "./signal.mjs";
import { fetchHolderStats, fetchPumpCoinDetail } from "./pumpfun-client.mjs";
import { evaluateQuality, isPumpOrigin, qualityConfigFromEnv } from "./quality.mjs";
import { evaluateEarly } from "./early.mjs";

const CACHE_TTL_MS = 20_000;
const HISTORY_LIMIT = 240;
const HISTORY_MAX_AGE_MS = 6 * 60 * 60_000;
let cache = null;
const recorded = new Map();
const athSeen = new Map();

/** Appends the latest price of each token to a bounded in-memory series and drops stale tokens. */
export function recordPrices(tokens, now) {
  for (const token of tokens) {
    const series = recorded.get(token.id) ?? [];
    if (token.price > 0 && (series.length === 0 || now - series[series.length - 1].t >= CACHE_TTL_MS / 2)) {
      series.push({ t: now, price: token.price });
    }
    recorded.set(token.id, series.slice(-HISTORY_LIMIT));
  }
  for (const [id, series] of recorded) {
    if (now - series[series.length - 1].t > HISTORY_MAX_AGE_MS) { recorded.delete(id); athSeen.delete(id); }
  }
}

/**
 * Dynamic all-time-high market cap: the highest of the pump.fun ATH, every market cap implied by
 * the 5m/1h/6h/24h price anchors, and the highest market cap this server has observed.
 */
export function updateAthMarketCap(token) {
  const marketCap = Number(token.marketCap);
  if (!(marketCap > 0)) return token.athMarketCap ?? null;
  const impliedByAnchors = token.price > 0 ? token.priceAnchors.map(point => marketCap * point.price / token.price) : [];
  const ath = Math.max(marketCap, Number(token.athMarketCap) || 0, athSeen.get(token.id) ?? 0, ...impliedByAnchors);
  athSeen.set(token.id, ath);
  return ath;
}

/** Real recorded prices, prefixed by the older reconstructed anchors that predate them. */
export function buildPriceHistory(token) {
  const series = recorded.get(token.id) ?? [];
  if (series.length < 2) return token.priceAnchors.map(point => point.price);
  const firstRecorded = series[0].t;
  const older = token.priceAnchors.filter(point => point.t < firstRecorded).map(point => point.price);
  return [...older, ...series.map(point => point.price)];
}

/** Adds the dynamic ATH, the entry signal, the risk label and the price history to a freshly mapped token. */
let knownSolPrice = 0;

export function enrichToken({ priceAnchors, ...token }) {
  if (token.solPriceUsd > 0) knownSolPrice = token.solPriceUsd;
  else if (knownSolPrice > 0) token = { ...token, solPriceUsd: knownSolPrice };
  const withAth = { ...token, athMarketCap: updateAthMarketCap({ ...token, priceAnchors }) };
  const enriched = { ...withAth, quality: evaluateQuality(withAth, qualityConfigFromEnv()) };
  const signal = evaluateSignal(enriched);
  return { ...enriched, score: signal.score, risk: riskFromGrade(signal.grade), signal, early: evaluateEarly(enriched, signal), priceHistory: buildPriceHistory({ ...token, priceAnchors }) };
}

const MAX_HOLDER_CHECKS = 12;
const MAX_STAGE_LOOKUPS = 15;

/** Fills the bonding-curve state of pump.fun tokens that were not in the ranked lists, so their life stage is exact. */
export async function fillPumpStage(tokens, { fetchImpl = fetch, now = Date.now() } = {}) {
  const missing = tokens.filter(token => !token.pump && isPumpOrigin(token)).slice(0, MAX_STAGE_LOOKUPS);
  await Promise.all(missing.map(async token => {
    try {
      const coin = await fetchPumpCoinDetail(token.address, { fetchImpl, now });
      if (coin) token.pump = { graduated: coin.graduated, bondingProgress: coin.bondingProgress, replyCount: coin.replyCount, isLive: coin.isLive, hasSocials: coin.hasSocials, url: coin.url };
    } catch { /* the market-cap guess is used instead */ }
  }));
  return tokens;
}

/** Re-grades the tradable candidates with pump.fun holder data (concentration, snipers, bundlers, dev). */
export async function applyHolderChecks(tokens, { fetchImpl = fetch, now = Date.now() } = {}) {
  const candidates = tokens.filter(token => (token.signal?.tradable || token.early?.candidate) && isPumpOrigin(token)).slice(0, MAX_HOLDER_CHECKS);
  await Promise.all(candidates.map(async token => {
    try {
      const holderStats = await fetchHolderStats(token.address, { fetchImpl, now });
      if (!holderStats) return;
      token.holderStats = holderStats;
      const signal = evaluateSignal(token);
      Object.assign(token, { signal, score: signal.score, risk: riskFromGrade(signal.grade), early: evaluateEarly(token, signal) });
    } catch { /* holder data is optional */ }
  }));
  return tokens;
}

export async function getTokenFeed({ refresh = false, fetchImpl = fetch } = {}) {
  const now = Date.now();
  if (!refresh && cache && now - cache.updatedAt < CACHE_TTL_MS) return cache;

  try {
    const fetched = await fetchLiveSolanaTokens({ fetchImpl, now });
    recordPrices(fetched, now);
    await fillPumpStage(fetched, { fetchImpl, now });
    const tokens = await applyHolderChecks(fetched.map(enrichToken), { fetchImpl, now });
    cache = { tokens, source: "dexscreener", live: true, scanned: tokens.length, updatedAt: now };
  } catch (error) {
    console.warn("Live feed unavailable; using simulation:", error.message);
    cache = { tokens: listMockTokens({ refresh }), source: "simulation", live: false, scanned: 1284, updatedAt: now };
  }
  return cache;
}

const HELD_TTL_MS = 10_000;
const heldCache = new Map();

/** Live prices for specific tokens, cached briefly per token so open positions are always marked to market. */
export async function getHeldTokens(addresses, { fetchImpl = fetch, now = Date.now() } = {}) {
  const missing = addresses.filter(address => !(heldCache.get(address) && now - heldCache.get(address).at < HELD_TTL_MS));
  if (missing.length) {
    try {
      for (const token of await fetchTokensByAddress(missing, { fetchImpl, now })) heldCache.set(token.address, { at: now, token });
    } catch (error) {
      console.warn("Held token lookup failed:", error.message);
    }
  }
  const tokens = addresses.map(address => heldCache.get(address)?.token).filter(Boolean);
  recordPrices(tokens, now);
  return tokens.map(enrichToken);
}

/** Name/symbol/address search for tokens the ranked feed does not show. */
export async function searchTokens(query, { fetchImpl = fetch, now = Date.now() } = {}) {
  const found = await searchSolanaTokens(query, { fetchImpl, now });
  recordPrices(found, now);
  return found.map(enrichToken);
}

const QUOTE_TTL_MS = 1_000;
const quoteCache = new Map();
const QUOTE_FIELDS = ["price", "marketCap", "liquidity", "volume24h", "volume", "volume5m", "volume6h", "transactions", "change5m", "change", "change6h", "change24h", "buys", "sells", "buys5m", "sells5m", "ageMinutes"];

/**
 * Fast lane for the visible rows: fresh market numbers for a few tokens, cached for one second so many
 * clients (or one client polling every second) share the same DEX Screener request.
 */
export async function getLiveQuotes(addresses, { fetchImpl = fetch, now = Date.now() } = {}) {
  const missing = addresses.filter(address => !(quoteCache.get(address) && now - quoteCache.get(address).at < QUOTE_TTL_MS));
  if (missing.length) {
    try {
      for (const token of await fetchTokensByAddress(missing, { fetchImpl, now })) {
        recordPrices([token], now);
        const quote = { id: token.id, updatedAt: now, athMarketCap: updateAthMarketCap(token) };
        for (const field of QUOTE_FIELDS) quote[field] = token[field];
        quoteCache.set(token.address, { at: now, quote });
      }
    } catch (error) {
      console.warn("Live quotes failed:", error.message);
    }
    if (quoteCache.size > 600) for (const key of [...quoteCache.keys()].slice(0, 200)) quoteCache.delete(key);
  }
  return addresses.map(address => quoteCache.get(address)?.quote).filter(Boolean);
}

const STATUS_TTL_MS = 15_000;
const statusCache = new Map();

const pickStatus = token => ({
  id: token.id, name: token.name, symbol: token.symbol, imageUrl: token.imageUrl ?? null, price: token.price, liquidity: token.liquidity,
  marketCap: token.marketCap, volume24h: token.volume24h, ageMinutes: token.ageMinutes, grade: token.signal?.grade ?? null,
  quality: { passes: token.quality.passes, stage: token.quality.stage, failed: token.quality.checks.filter(check => !check.ok).map(check => check.label) }
});

/** Current price, liquidity and Pulse-filter verdict of specific tokens (for the trade history page). */
export async function getTokenStatuses(addresses, { fetchImpl = fetch, now = Date.now() } = {}) {
  const missing = addresses.filter(address => !(statusCache.get(address) && now - statusCache.get(address).at < STATUS_TTL_MS));
  if (missing.length) {
    try {
      const fetched = await fetchTokensByAddress(missing, { fetchImpl, now });
      await fillPumpStage(fetched, { fetchImpl, now });
      for (const token of fetched) statusCache.set(token.address, { at: now, status: pickStatus(enrichToken(token)) });
    } catch (error) {
      console.warn("Token status lookup failed:", error.message);
    }
    for (const address of missing) if (!statusCache.has(address) || now - statusCache.get(address).at >= STATUS_TTL_MS) statusCache.set(address, { at: now, status: null });
    if (statusCache.size > 600) for (const key of [...statusCache.keys()].slice(0, 200)) statusCache.delete(key);
  }
  return addresses.map(address => statusCache.get(address)?.status).filter(Boolean);
}
