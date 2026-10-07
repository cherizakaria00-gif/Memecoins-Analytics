import { isValidSolanaAddress } from "./wallet-balance.mjs";

const API_ROOT = "https://api.geckoterminal.com/api/v2/networks/solana/pools";
const CACHE_TTL_MS = 15_000;
const TIMEFRAMES = {
  "1m": { unit: "minute", aggregate: 1 },
  "5m": { unit: "minute", aggregate: 5 },
  "15m": { unit: "minute", aggregate: 15 },
  "1h": { unit: "hour", aggregate: 1 },
  "4h": { unit: "hour", aggregate: 4 },
  "1d": { unit: "day", aggregate: 1 }
};
const cache = new Map();

export const isValidTimeframe = timeframe => Object.hasOwn(TIMEFRAMES, timeframe);

/** Converts GeckoTerminal's newest-first [time, o, h, l, c, volume] rows into ascending, validated candles. */
export function mapCandles(rows) {
  const candles = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const [time, open, high, low, close, volume] = row.map(Number);
    if (![time, open, high, low, close].every(Number.isFinite) || close <= 0) continue;
    candles.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return candles.sort((first, second) => first.time - second.time)
    .filter((candle, index, all) => index === 0 || candle.time !== all[index - 1].time);
}

const STALE_MAX_MS = 15 * 60_000;
const BUDGET_PER_MINUTE = 24; // GeckoTerminal's free tier allows 30 calls / minute
const BACKGROUND_BUDGET = 12; // background chip refreshes never use more than half of it, so the chart the user opens always gets through
const inflight = new Map();
const calls = [];
let blockedUntil = 0;

const recentCalls = now => { while (calls.length && now - calls[0] > 60_000) calls.shift(); return calls.length; };

/**
 * Fetches OHLCV candles for a Solana pool. Returns an empty list for pools GeckoTerminal does not index yet.
 * Rate limits (HTTP 429) back off globally and fall back to the last candles we had, so the chart keeps working.
 */
export async function getCandles(pool, timeframe, { fetchImpl = fetch, now = Date.now(), background = false } = {}) {
  if (!isValidSolanaAddress(pool)) throw new TypeError("Invalid pool address");
  if (!isValidTimeframe(timeframe)) throw new TypeError("Invalid timeframe");

  const key = `${pool}:${timeframe}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.candles;
  const stale = () => {
    if (cached && now - cached.at < STALE_MAX_MS) return cached.candles;
    throw new Error("GeckoTerminal rate limit: retry shortly");
  };
  if (now < blockedUntil || recentCalls(now) >= (background ? BACKGROUND_BUDGET : BUDGET_PER_MINUTE)) return stale();
  if (inflight.has(key)) return inflight.get(key);

  const { unit, aggregate } = TIMEFRAMES[timeframe];
  const url = `${API_ROOT}/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=300&currency=usd`;
  const job = (async () => {
    calls.push(now);
    const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (response.status === 404) return [];
    if (response.status === 429) {
      const wait = Number(response.headers?.get?.("retry-after"));
      blockedUntil = now + Math.min(Math.max(Number.isFinite(wait) ? wait * 1000 : 20_000, 5_000), 60_000);
      return stale();
    }
    if (!response.ok) { try { return stale(); } catch { throw new Error(`GeckoTerminal responded with HTTP ${response.status}`); } }
    const payload = await response.json();
    const candles = mapCandles(payload?.data?.attributes?.ohlcv_list);
    cache.set(key, { at: now, candles });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return candles;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

export const _test = { reset() { cache.clear(); inflight.clear(); calls.length = 0; blockedUntil = 0; } };
