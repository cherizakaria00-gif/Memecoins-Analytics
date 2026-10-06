import { fetchTokensByAddress } from "./dexscreener-client.mjs";
import { isValidSolanaAddress } from "./wallet-balance.mjs";

const API_ROOT = "https://frontend-api-v3.pump.fun";
const PROFILE_IMAGE_HOST = "socialimages.pump.fun";
const TRADES_TTL_MS = 15_000;
const META_TTL_MS = 60_000;
const PUMP_SUPPLY = 1_000_000_000;
const QUERY = /^[A-Za-z0-9_.-]{2,44}$/;
const tradesCache = new Map();
const metaCache = new Map();

const asNumber = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

function safeProfileImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === PROFILE_IMAGE_HOST ? url.href : null;
  } catch {
    return null;
  }
}

async function getJson(path, fetchImpl) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; PulsePaperScanner/0.1)" },
    signal: AbortSignal.timeout(8_000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`pump.fun responded with HTTP ${response.status}`);
  return response.json();
}

/** Resolves a pump.fun username, wallet address or user id to the trader's public profile. Null when unknown. */
export async function resolveTrader(query, { fetchImpl = fetch } = {}) {
  const value = String(query ?? "").trim();
  if (!QUERY.test(value)) throw new TypeError("Invalid trader query");
  const profile = await getJson(`/users/${encodeURIComponent(value)}`, fetchImpl);
  const wallet = profile?.address;
  if (!isValidSolanaAddress(wallet)) return null;
  return { wallet, username: String(profile.username || `${wallet.slice(0, 4)}…${wallet.slice(-4)}`), profileImage: safeProfileImage(profile.profile_image) };
}

export function mapTrade(raw) {
  const time = Date.parse(raw?.timestamp);
  if (!raw?.tx || !raw?.mint || !Number.isFinite(time)) return null;
  return {
    tx: String(raw.tx), isBuy: Boolean(raw.isBuy), timestamp: time, amountUsd: asNumber(raw.amountUsd), amountSol: asNumber(raw.amountSol),
    priceUsd: asNumber(raw.priceUsd), mint: String(raw.mint), wallet: String(raw.walletAddress ?? "")
  };
}

/** Latest trades of one wallet on pump.fun, newest first (cached briefly). */
export async function getWalletTrades(wallet, { fetchImpl = fetch, now = Date.now(), limit = 12 } = {}) {
  if (!isValidSolanaAddress(wallet)) throw new TypeError("Invalid wallet");
  const hit = tradesCache.get(wallet);
  if (hit && now - hit.at < TRADES_TTL_MS) return hit.trades;
  const payload = await getJson(`/user-trades/${wallet}?limit=${limit}&offset=0`, fetchImpl);
  const trades = (Array.isArray(payload?.trades) ? payload.trades : []).map(mapTrade).filter(Boolean)
    .map(trade => ({ ...trade, wallet })).sort((first, second) => second.timestamp - first.timestamp).slice(0, limit);
  tradesCache.set(wallet, { at: now, trades });
  if (tradesCache.size > 200) tradesCache.delete(tradesCache.keys().next().value);
  return trades;
}

/** Name, symbol, logo and market cap (now and at the trade) of the traded tokens, from DEX Screener. */
export async function attachTokenMeta(trades, { fetchImpl = fetch, now = Date.now() } = {}) {
  const mints = [...new Set(trades.map(trade => trade.mint))];
  const missing = mints.filter(mint => !(metaCache.get(mint) && now - metaCache.get(mint).at < META_TTL_MS));
  if (missing.length) {
    try {
      for (const token of await fetchTokensByAddress(missing, { fetchImpl, now })) {
        metaCache.set(token.address, { at: now, meta: { name: token.name, symbol: token.symbol, imageUrl: token.imageUrl, price: token.price, marketCap: token.marketCap } });
      }
    } catch { /* metadata is optional */ }
    for (const mint of missing) if (!metaCache.has(mint)) metaCache.set(mint, { at: now, meta: null });
    if (metaCache.size > 500) for (const key of [...metaCache.keys()].slice(0, 150)) metaCache.delete(key);
  }
  return trades.map(trade => {
    const meta = metaCache.get(trade.mint)?.meta ?? null;
    const supply = meta?.price > 0 && meta?.marketCap > 0 ? meta.marketCap / meta.price : trade.mint.endsWith("pump") ? PUMP_SUPPLY : null;
    return {
      ...trade,
      name: meta?.name ?? null, symbol: meta?.symbol ?? null, imageUrl: meta?.imageUrl ?? null,
      marketCapAtTrade: supply && trade.priceUsd > 0 ? trade.priceUsd * supply : null,
      marketCapNow: meta?.marketCap ?? null
    };
  });
}

/** Merged, enriched recent trades of several wallets, newest first. One failing wallet does not break the others. */
export async function getFollowedTrades(wallets, options = {}) {
  const results = await Promise.allSettled(wallets.map(wallet => getWalletTrades(wallet, options)));
  const trades = results.flatMap(result => (result.status === "fulfilled" ? result.value : [])).sort((first, second) => second.timestamp - first.timestamp);
  return attachTokenMeta(trades.slice(0, 80), options);
}
