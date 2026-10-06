import { isValidSolanaAddress } from "./wallet-balance.mjs";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

/**
 * Authorities of an SPL token mint, read on-chain: a revoked (null) mint authority means no new supply can be
 * created, a revoked freeze authority means holders' accounts cannot be frozen. Null when the address is not a mint.
 */
export async function getMintSecurity(mint, { fetchImpl = fetch, rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL, now = Date.now() } = {}) {
  if (!isValidSolanaAddress(mint)) throw new TypeError("Invalid mint address");
  const cached = cache.get(mint);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.info;

  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "pulse-mint", method: "getAccountInfo", params: [mint, { encoding: "jsonParsed" }] }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Solana RPC responded with HTTP ${response.status}`);
  const parsed = (await response.json())?.result?.value?.data?.parsed;
  const info = parsed?.type === "mint"
    ? { mintRevoked: parsed.info?.mintAuthority == null, freezeRevoked: parsed.info?.freezeAuthority == null, decimals: Number(parsed.info?.decimals ?? 0) }
    : null;
  cache.set(mint, { at: now, info });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return info;
}
