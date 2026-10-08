/**
 * CoinGecko's on-chain (GeckoTerminal) data with an API key: the key gets its own rate-limit bucket instead of the shared per-IP one of the free public API.
 * COINGECKO_API_KEY = demo key (api.coingecko.com, header x-cg-demo-api-key); set COINGECKO_PRO=1 for a paid key (pro-api.coingecko.com).
 */
export function coingeckoOnchain(env = process.env) {
  const key = typeof env.COINGECKO_API_KEY === "string" ? env.COINGECKO_API_KEY.trim() : "";
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(key)) return null;
  const pro = env.COINGECKO_PRO === "1";
  return { root: pro ? "https://pro-api.coingecko.com/api/v3/onchain/networks/solana" : "https://api.coingecko.com/api/v3/onchain/networks/solana", headers: { [pro ? "x-cg-pro-api-key" : "x-cg-demo-api-key"]: key } };
}
