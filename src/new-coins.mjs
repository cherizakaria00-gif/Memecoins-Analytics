import { buildSocials } from "./socials.mjs";
import { fetchNewestCoins, pumpImageUrl } from "./pumpfun-client.mjs";
import { fetchTokensByAddress } from "./dexscreener-client.mjs";
import { evaluateQuality, qualityConfigFromEnv } from "./quality.mjs";

const CACHE_TTL_MS = 10_000;
const DEFAULT_MIN_VOLUME = 8_960;
let cache = null;

/** Filter used for the "New" feed: the Pulse filter without the age minimum (coins are new by definition) plus a volume floor. */
export function newCoinsConfig(env = process.env) {
  const volume = Number(env.NEW_MIN_VOLUME);
  return { ...qualityConfigFromEnv(env), minAgeMinutes: 0, minVolume24h: Number.isFinite(volume) && env.NEW_MIN_VOLUME !== "" && env.NEW_MIN_VOLUME != null ? volume : DEFAULT_MIN_VOLUME };
}

/**
 * Newest pump.fun coins, each checked against the Pulse filter. Coins DEX Screener already indexes get real volume,
 * transactions and price changes; the others (a minute or two old) are built from pump.fun data alone, their volume
 * is estimated from the SOL held by the bonding curve (net buys, so a lower bound of the real volume).
 */
export async function getNewCoins({ fetchImpl = fetch, now = Date.now(), config = newCoinsConfig() } = {}) {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  const coins = await fetchNewestCoins({ fetchImpl });
  let dex = [];
  try { dex = await fetchTokensByAddress(coins.map(coin => coin.mint), { fetchImpl, now }); } catch { /* pump.fun data alone */ }
  const byMint = new Map(dex.map(token => [token.address, token]));
  const solUsd = dex.find(token => token.solPriceUsd > 0)?.solPriceUsd ?? (coins[0]?.marketCapSol > 0 ? coins[0].usdMarketCap / coins[0].marketCapSol : 0);

  const tokens = coins.map(coin => {
    const listed = byMint.get(coin.mint);
    const pump = { graduated: coin.graduated, bondingProgress: coin.bondingProgress, replyCount: coin.replyCount, hasSocials: coin.hasSocials, url: coin.url };
    const socials = buildSocials(listed?.socials, coin);
    // pump.fun is the reference for coins still on the bonding curve; DEX Screener once they migrated.
    const marketCap = (!coin.graduated && coin.usdMarketCap > 0 ? coin.usdMarketCap : listed?.marketCap) ?? (coin.usdMarketCap || null);
    const base = listed
      ? { ...listed, imageUrl: listed.imageUrl ?? pumpImageUrl(coin.mint), pump, socials }
      : {
        id: coin.mint, address: coin.mint, name: coin.name, symbol: coin.symbol, imageUrl: pumpImageUrl(coin.mint), price: marketCap ? marketCap / 1_000_000_000 : 0,
        liquidity: coin.realSolReserves * 2 * solUsd, volume24h: coin.realSolReserves * solUsd || null, volumeEstimated: true, transactions: null, change: null, change5m: null, change6h: null, change24h: null,
        marketCap, solPriceUsd: solUsd, pump, socials, synthetic: true
      };
    // DEX Screener reports a tiny or missing liquidity for a coin still on its bonding curve: use the SOL held by the curve if larger.
    if (!coin.graduated) base.liquidity = Math.max(base.liquidity ?? 0, coin.realSolReserves * 2 * solUsd);
    const token = {
      ...base, ageMinutes: Math.max(0, Math.floor((now - coin.createdAt) / 60_000)), createdAt: coin.createdAt, pumpUrl: coin.url,
      athMarketCap: Math.max(coin.athMarketCap ?? 0, marketCap ?? 0) || null, priceAnchors: undefined, priceHistory: undefined
    };
    token.quality = evaluateQuality(token, config);
    return token;
  });
  const value = { tokens, passed: tokens.filter(token => token.quality.passes).length, updatedAt: now, minVolume: config.minVolume24h };
  cache = { at: now, value };
  return value;
}

export const resetNewCoinsCache = () => { cache = null; };
