import { isValidSolanaAddress } from "./wallet-balance.mjs";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_JUPITER_URL = "https://lite-api.jup.ag/swap/v1";
const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"];
export const MAX_PRIORITY_SOL = 0.05;
export const MIN_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 9_000;

export class LiveTradingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function liveConfig(env = process.env) {
  const cap = Number(env.LIVE_MAX_ORDER_SOL);
  return {
    enabled: env.LIVE_TRADING !== "0",
    maxOrderSol: Number.isFinite(cap) && cap > 0 ? cap : 5,
    jupiterUrl: (env.JUPITER_API_URL || DEFAULT_JUPITER_URL).replace(/\/+$/, ""),
    jupiterKey: env.JUPITER_API_KEY || null,
    rpcUrl: env.SOLANA_RPC_URL || DEFAULT_RPC_URL
  };
}

const toLamports = sol => Math.round(Number(sol) * LAMPORTS_PER_SOL);

/** Validates and normalizes an order request; throws LiveTradingError with a French message. */
export function parseOrder(input, config) {
  const side = input?.side;
  if (side !== "buy" && side !== "sell") throw new LiveTradingError("Sens d'ordre invalide.");
  if (!isValidSolanaAddress(input?.mint) || input.mint === SOL_MINT) throw new LiveTradingError("Token invalide.");
  if (!isValidSolanaAddress(input?.userPublicKey)) throw new LiveTradingError("Adresse du wallet invalide.");

  const slippageBps = Math.round(Number(input?.slippageBps));
  if (!Number.isFinite(slippageBps) || slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) throw new LiveTradingError("Slippage invalide.");
  const prioritySol = Number(input?.prioritySol ?? 0);
  if (!Number.isFinite(prioritySol) || prioritySol < 0 || prioritySol > MAX_PRIORITY_SOL) throw new LiveTradingError(`Frais de priorité invalides (maximum ${MAX_PRIORITY_SOL} SOL).`);

  let amount;
  if (side === "buy") {
    const sol = Number(input?.amountSol);
    if (!Number.isFinite(sol) || sol <= 0) throw new LiveTradingError("Montant invalide.");
    if (sol > config.maxOrderSol) throw new LiveTradingError(`Montant supérieur à la limite de ${config.maxOrderSol} SOL par ordre.`);
    if (sol < 0.001) throw new LiveTradingError("Montant minimum : 0,001 SOL.");
    amount = String(toLamports(sol));
  } else {
    if (!/^\d{1,20}$/.test(String(input?.amountRaw ?? "")) || BigInt(input.amountRaw) <= 0n) throw new LiveTradingError("Quantité à vendre invalide.");
    amount = String(input.amountRaw);
  }
  return { side, mint: input.mint, userPublicKey: input.userPublicKey, slippageBps, priorityLamports: toLamports(prioritySol), amount };
}

/**
 * Quotes and builds an unsigned Jupiter swap transaction. Nothing is signed or sent here: the user's wallet signs
 * the returned transaction after the user has seen the summary.
 */
export async function prepareSwap(input, { config = liveConfig(), fetchImpl = fetch, now = Date.now() } = {}) {
  if (!config.enabled) throw new LiveTradingError("Le trading live est désactivé sur ce serveur.", 403);
  const order = parseOrder(input, config);
  const headers = { accept: "application/json", ...(config.jupiterKey ? { "x-api-key": config.jupiterKey } : {}) };
  const [inputMint, outputMint] = order.side === "buy" ? [SOL_MINT, order.mint] : [order.mint, SOL_MINT];

  const quoteUrl = `${config.jupiterUrl}/quote?${new URLSearchParams({ inputMint, outputMint, amount: order.amount, slippageBps: String(order.slippageBps), swapMode: "ExactIn" })}`;
  const quoteResponse = await fetchImpl(quoteUrl, { headers, signal: AbortSignal.timeout(10_000) });
  const quote = await quoteResponse.json();
  if (!quoteResponse.ok || quote?.error || !quote?.outAmount) throw new LiveTradingError(`Aucune route trouvée pour cet ordre${quote?.error ? ` (${String(quote.error).slice(0, 120)})` : ""}.`, 422);

  const swapResponse = await fetchImpl(`${config.jupiterUrl}/swap`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: order.userPublicKey, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: order.priorityLamports }),
    signal: AbortSignal.timeout(12_000)
  });
  const swap = await swapResponse.json();
  if (!swapResponse.ok || !swap?.swapTransaction) throw new LiveTradingError(`Impossible de préparer la transaction${swap?.error ? ` (${String(swap.error).slice(0, 120)})` : ""}.`, 502);

  const impactPct = Number(quote.priceImpactPct) * 100;
  return {
    summary: {
      side: order.side, mint: order.mint, inAmount: quote.inAmount, outAmount: quote.outAmount, minOutAmount: quote.otherAmountThreshold,
      slippageBps: order.slippageBps, priceImpactPct: Number.isFinite(impactPct) ? impactPct : null,
      routes: (quote.routePlan ?? []).map(step => step?.swapInfo?.label).filter(Boolean),
      priorityLamports: Number(swap.prioritizationFeeLamports ?? order.priorityLamports),
      simulationError: swap.simulationError ? String(swap.simulationError.error ?? swap.simulationError).slice(0, 160) : null,
      preparedAt: now
    },
    transaction: swap.swapTransaction,
    lastValidBlockHeight: swap.lastValidBlockHeight ?? null
  };
}

async function rpc(method, params, { config, fetchImpl }) {
  const response = await fetchImpl(config.rpcUrl, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "pulse-live", method, params }), signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new LiveTradingError(`RPC Solana indisponible (HTTP ${response.status}).`, 502);
  const payload = await response.json();
  if (payload?.error) throw new LiveTradingError(`RPC Solana : ${String(payload.error.message ?? "erreur").slice(0, 120)}`, 502);
  return payload.result;
}

/** SOL balance and non-empty SPL / Token-2022 balances of a wallet. */
export async function getPortfolio(owner, { config = liveConfig(), fetchImpl = fetch } = {}) {
  if (!isValidSolanaAddress(owner)) throw new LiveTradingError("Adresse du wallet invalide.");
  const [balance, ...accounts] = await Promise.all([
    rpc("getBalance", [owner, { commitment: "confirmed" }], { config, fetchImpl }),
    ...TOKEN_PROGRAMS.map(programId => rpc("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }], { config, fetchImpl }))
  ]);
  const tokens = new Map();
  for (const result of accounts) {
    for (const account of result?.value ?? []) {
      const info = account?.account?.data?.parsed?.info;
      const raw = info?.tokenAmount?.amount;
      if (!info?.mint || !raw || raw === "0") continue;
      const current = tokens.get(info.mint);
      tokens.set(info.mint, { mint: info.mint, raw: String((current ? BigInt(current.raw) : 0n) + BigInt(raw)), decimals: Number(info.tokenAmount.decimals) });
    }
  }
  return { sol: Number(balance?.value ?? 0) / LAMPORTS_PER_SOL, tokens: [...tokens.values()].slice(0, 60) };
}

/** Confirmation state of a transaction signature: "pending", "confirmed", "finalized" or "failed". */
export async function getSignatureState(signature, { config = liveConfig(), fetchImpl = fetch } = {}) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(signature ?? "")) throw new LiveTradingError("Signature invalide.");
  const result = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }], { config, fetchImpl });
  const status = result?.value?.[0];
  if (!status) return { state: "pending" };
  if (status.err) return { state: "failed", error: JSON.stringify(status.err).slice(0, 160) };
  return { state: status.confirmationStatus === "finalized" ? "finalized" : status.confirmationStatus === "confirmed" ? "confirmed" : "pending" };
}
