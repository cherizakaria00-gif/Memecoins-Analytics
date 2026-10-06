const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const BASE58_PUBLIC_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function isValidSolanaAddress(address) {
  return typeof address === "string" && BASE58_PUBLIC_KEY.test(address);
}

export async function getSolBalance(address, { fetchImpl = fetch, rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL } = {}) {
  if (!isValidSolanaAddress(address)) throw new TypeError("Invalid Solana public key");

  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "pulse-balance",
      method: "getBalance",
      params: [address, { commitment: "confirmed" }]
    }),
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) throw new Error(`Solana RPC responded with HTTP ${response.status}`);

  const payload = await response.json();
  const lamports = Number(payload?.result?.value);
  if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error("Invalid balance response from Solana RPC");
  return { lamports, sol: lamports / LAMPORTS_PER_SOL };
}
