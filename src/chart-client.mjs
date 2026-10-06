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

/** Fetches OHLCV candles for a Solana pool. Returns an empty list for pools GeckoTerminal does not index yet. */
export async function getCandles(pool, timeframe, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!isValidSolanaAddress(pool)) throw new TypeError("Invalid pool address");
  if (!isValidTimeframe(timeframe)) throw new TypeError("Invalid timeframe");

  const key = `${pool}:${timeframe}`;
  const cached = cache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.candles;

  const { unit, aggregate } = TIMEFRAMES[timeframe];
  const url = `${API_ROOT}/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=300&currency=usd`;
  const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`GeckoTerminal responded with HTTP ${response.status}`);

  const payload = await response.json();
  const candles = mapCandles(payload?.data?.attributes?.ohlcv_list);
  cache.set(key, { at: now, candles });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return candles;
}
