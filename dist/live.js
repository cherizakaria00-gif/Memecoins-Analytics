/** Pure helpers of the live trading mode (orders signed by the user's own wallet). No DOM, no network. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const LAMPORTS_PER_SOL = 1_000_000_000;

export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = "";
  while (value > 0n) { text = ALPHABET[Number(value % 58n)] + text; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = `1${text}`; }
  return text;
}

export function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Token amount in base units -> number of tokens (lossy for huge supplies, fine for display and P&L). */
export const rawToUi = (raw, decimals) => Number(BigInt(raw ?? 0)) / 10 ** (decimals ?? 0);

/** Fraction (0-1] of a raw balance, as a base-unit string (never rounds up beyond the balance). */
export function rawFraction(raw, fraction) {
  const total = BigInt(raw ?? 0);
  if (fraction >= 0.999999) return total.toString();
  return ((total * BigInt(Math.round(fraction * 10_000))) / 10_000n).toString();
}

export const lamportsToSol = lamports => Number(lamports) / LAMPORTS_PER_SOL;

/** Priority fee + tip of a fee preset, merged: a wallet-sent transaction cannot use a separate Jito tip, so both go to the validators. */
export const orderPrioritySol = preset => (preset?.priorityFeeSol ?? 0) + (preset?.tipSol ?? 0);

/** Human summary of a prepared order for the confirmation window. */
export function describeOrder(summary, { decimals = 6, symbol = "TOKEN", solUsd = 0 } = {}) {
  const buy = summary.side === "buy";
  const sol = lamportsToSol(buy ? summary.inAmount : summary.outAmount);
  const minSol = lamportsToSol(buy ? summary.inAmount : summary.minOutAmount);
  const tokens = rawToUi(buy ? summary.outAmount : summary.inAmount, decimals);
  const minTokens = rawToUi(buy ? summary.minOutAmount : summary.inAmount, decimals);
  const priorityFeeSol = lamportsToSol(summary.priorityLamports ?? 0);
  const warnings = [];
  if (summary.simulationError) warnings.push(`La simulation de la transaction échoue : ${summary.simulationError}. Vérifie ton solde SOL.`);
  if (summary.priceImpactPct != null && summary.priceImpactPct > 5) warnings.push(`Impact de prix élevé : ${summary.priceImpactPct.toFixed(1)} %.`);
  if (summary.priceImpactPct != null && summary.priceImpactPct * 100 > summary.slippageBps) warnings.push("L'impact dépasse le slippage maximum : l'ordre risque d'échouer.");
  return {
    title: `${buy ? "Acheter" : "Vendre"} $${symbol}`,
    pay: buy ? { amount: sol, unit: "SOL", usd: sol * solUsd } : { amount: tokens, unit: `$${symbol}` },
    receive: buy ? { amount: tokens, unit: `$${symbol}`, min: minTokens } : { amount: sol, unit: "SOL", usd: sol * solUsd, min: minSol },
    priceImpactPct: summary.priceImpactPct, slippagePct: summary.slippageBps / 100, priorityFeeSol, routes: summary.routes ?? [],
    blocking: Boolean(summary.simulationError), warnings
  };
}

/**
 * Average-cost accounting of the orders logged by the app: per mint, tokens still held (as logged), SOL invested in them
 * and SOL realized by sells. Only confirmed orders count. Amounts are the quoted ones (a few % off the real fills).
 */
export function costBasis(orders) {
  const book = new Map();
  for (const order of [...orders].filter(item => item.state === "confirmed" || item.state === "finalized").sort((a, b) => a.ts - b.ts)) {
    const entry = book.get(order.mint) ?? { tokens: 0n, costSol: 0, realizedSol: 0 };
    const outRaw = BigInt(order.outRaw ?? 0);
    const solAmount = lamportsToSol(order.solLamports ?? 0);
    if (order.side === "buy") {
      entry.tokens += outRaw;
      entry.costSol += solAmount;
    } else {
      const sold = BigInt(order.inRaw ?? 0);
      const share = entry.tokens > 0n ? Math.min(1, Number(sold) / Number(entry.tokens)) : 1;
      entry.realizedSol += solAmount - entry.costSol * share;
      entry.costSol -= entry.costSol * share;
      entry.tokens = sold >= entry.tokens ? 0n : entry.tokens - sold;
    }
    book.set(order.mint, entry);
  }
  return new Map([...book].map(([mint, entry]) => [mint, { tokens: entry.tokens.toString(), costSol: Math.max(entry.costSol, 0), realizedSol: entry.realizedSol }]));
}

/** Value of a wallet position in SOL and its P&L against the logged cost (null when the cost is unknown). */
export function positionValue({ raw, decimals, priceUsd, solUsd, costSol }) {
  if (!(priceUsd > 0) || !(solUsd > 0)) return { amount: rawToUi(raw, decimals), valueSol: null, valueUsd: null, pnlSol: null, pnlPct: null };
  const amount = rawToUi(raw, decimals);
  const valueUsd = amount * priceUsd;
  const valueSol = valueUsd / solUsd;
  const known = costSol > 0;
  return { amount, valueSol, valueUsd, pnlSol: known ? valueSol - costSol : null, pnlPct: known ? (valueSol / costSol - 1) * 100 : null };
}

/** "stop-loss" / "take-profit" when the P&L crossed a limit, else null. Live limits only alert: no order is sent without a signature. */
export function limitBreach(pnlPct, limits) {
  if (pnlPct == null || !limits) return null;
  if (limits.sl > 0 && pnlPct <= -limits.sl) return "stop-loss";
  if (limits.tp > 0 && pnlPct >= limits.tp) return "take-profit";
  return null;
}

/** Keeps the order log bounded and updates one entry. */
export function upsertOrder(orders, order, limit = 100) {
  return [order, ...orders.filter(item => item.id !== order.id)].slice(0, limit);
}
