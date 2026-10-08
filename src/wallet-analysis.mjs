import { fetchTokensByAddress } from "./dexscreener-client.mjs";
import { isValidSolanaAddress } from "./wallet-balance.mjs";

/**
 * Wallet analyzer: rebuilds the swaps of a Solana wallet from its recent transactions (balance changes, no third-party index)
 * and reports realized vs unrealized profit, win rate, how early it enters, how long it holds, and how much of the profit
 * comes from tokens it simply RECEIVED (team / insider wallets get tokens for free, which is not trading skill).
 * It only reads public on-chain data. A public RPC rate-limits getTransaction hard: set SOLANA_RPC_URL (e.g. a free Helius URL) for full history.
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";
const STABLES = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const RENT_SOL = 0.00203928;
const MIN_MOVE_SOL = 0.001;
const MIN_FREE_VALUE_SOL = 0.02; // tokens only received (airdrops, spam) below this value are dust, not a position
export const MAX_TRANSACTIONS = 150;
const DEFAULT_TRANSACTIONS = 100;
const CONCURRENCY = 3;
const BUDGET_MS = 30_000;
const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();

export class WalletAnalysisError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = list => { if (!list.length) return null; const sorted = [...list].sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };

async function rpc(url, method, params, { fetchImpl, retries = 3, delay = 500 }) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try { response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) }); }
    catch { if (attempt >= retries) return { error: "network" }; await sleep(delay * 2 ** attempt); continue; }
    const payload = await response.json().catch(() => null);
    if (response.status === 429 || payload?.error?.code === 429) {
      if (attempt >= retries) return { error: "rate-limited" };
      await sleep(delay * 2 ** attempt);
      continue;
    }
    if (!response.ok || payload?.error) return { error: payload?.error?.message ?? `HTTP ${response.status}` };
    return { result: payload.result };
  }
}

/** Net balance change of `owner` in one transaction: SOL (native + wrapped, rent and fee removed), stablecoins and every other token. */
export function parseTransaction(tx, owner) {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = (tx.transaction?.message?.accountKeys ?? []).map(key => (typeof key === "string" ? key : key.pubkey));
  const index = keys.indexOf(owner);
  const pre = tx.meta.preBalances ?? [], post = tx.meta.postBalances ?? [];
  let sol = index >= 0 ? ((post[index] ?? 0) - (pre[index] ?? 0)) / 1e9 : 0;
  if (index === 0) sol += (tx.meta.fee ?? 0) / 1e9; // the wallet paid the network fee: it is not part of the trade
  const mine = list => (list ?? []).filter(balance => balance.owner === owner);
  const key = balance => balance.accountIndex;
  const before = new Map(mine(tx.meta.preTokenBalances).map(balance => [key(balance), balance]));
  const after = new Map(mine(tx.meta.postTokenBalances).map(balance => [key(balance), balance]));
  const amount = balance => Number(balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0) || 0;
  const deltas = new Map();
  for (const accountIndex of new Set([...before.keys(), ...after.keys()])) {
    const mint = (after.get(accountIndex) ?? before.get(accountIndex)).mint;
    deltas.set(mint, (deltas.get(mint) ?? 0) + amount(after.get(accountIndex)) - amount(before.get(accountIndex)));
  }
  const created = [...after.keys()].filter(accountIndex => !before.has(accountIndex)).length;
  const closed = [...before.keys()].filter(accountIndex => !after.has(accountIndex)).length;
  // Rent is only removed from the wallet's own SOL movement when the wallet really paid / received it (airdrops are paid by the sender).
  if (sol < 0) sol += Math.min(created * RENT_SOL, -sol);
  else if (sol > 0) sol -= Math.min(closed * RENT_SOL, sol);
  sol += deltas.get(SOL_MINT) ?? 0;
  let stable = 0;
  const tokens = [];
  for (const [mint, delta] of deltas) {
    if (mint === SOL_MINT || Math.abs(delta) < 1e-12) continue;
    if (STABLES.has(mint)) stable += delta; else tokens.push({ mint, delta });
  }
  return { time: tx.blockTime ? tx.blockTime * 1000 : null, sol, stable, tokens };
}

const HELIUS_PAGE = 100;
const HELIUS_DEFAULT_SWAPS = 200;
const HELIUS_MAX_SWAPS = 400;

/** Helius API key from a Helius RPC URL (https://mainnet.helius-rpc.com/?api-key=...). Null for any other RPC. */
export function heliusKeyFromRpc(rpcUrl) {
  try {
    const url = new URL(rpcUrl);
    return /(^|\.)helius(-rpc)?\.(com|xyz)$/.test(url.hostname) ? url.searchParams.get("api-key") : null;
  } catch { return null; }
}

/** One Helius "enhanced" SWAP transaction as the same shape parseTransaction returns: net SOL, stablecoins and token changes of `owner`. */
export function parseHeliusSwap(tx, owner) {
  let sol = 0, stable = 0;
  const deltas = new Map();
  const add = (mint, amount) => {
    if (mint === SOL_MINT) sol += amount;
    else if (STABLES.has(mint)) stable += amount;
    else deltas.set(mint, (deltas.get(mint) ?? 0) + amount);
  };
  const raw = leg => Number(leg?.rawTokenAmount?.tokenAmount) / 10 ** Number(leg?.rawTokenAmount?.decimals ?? 0);
  const swap = tx?.events?.swap;
  if (swap) {
    if (swap.nativeInput?.account === owner) sol -= Number(swap.nativeInput.amount) / 1e9;
    if (swap.nativeOutput?.account === owner) sol += Number(swap.nativeOutput.amount) / 1e9;
    for (const leg of swap.tokenInputs ?? []) if (leg.userAccount === owner) add(leg.mint, -raw(leg));
    for (const leg of swap.tokenOutputs ?? []) if (leg.userAccount === owner) add(leg.mint, raw(leg));
  } else if (Array.isArray(tx?.accountData)) {
    // pump.fun / PumpSwap and other programs have no swap event: read the wallet's own balance changes instead.
    for (const entry of tx.accountData) {
      if (entry.account === owner) sol += Number(entry.nativeBalanceChange ?? 0) / 1e9 + (tx.feePayer === owner ? Number(tx.fee ?? 0) / 1e9 : 0);
      for (const change of entry.tokenBalanceChanges ?? []) if (change.userAccount === owner) add(change.mint, raw(change));
    }
  } else return null;
  if (!Number.isFinite(sol) || ![...deltas.values()].every(Number.isFinite)) return null;
  return { time: tx.timestamp ? tx.timestamp * 1000 : null, sol, stable, tokens: [...deltas].filter(([, delta]) => Math.abs(delta) > 1e-12).map(([mint, delta]) => ({ mint, delta })) };
}

async function fetchHeliusSwaps(address, key, { fetchImpl, limit, budgetUntil }) {
  const parsed = [];
  let before = null;
  let pages = 0;
  while (parsed.length < limit && Date.now() < budgetUntil && pages < 6) {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${encodeURIComponent(key)}&type=SWAP&limit=${HELIUS_PAGE}${before ? `&before=${before}` : ""}`;
    let page;
    try {
      const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      page = await response.json();
    } catch (error) { if (!pages) throw error; break; }
    if (!Array.isArray(page) || !page.length) break;
    for (const tx of page) { const swap = parseHeliusSwap(tx, address); if (swap) parsed.push(swap); }
    before = page[page.length - 1]?.signature;
    pages++;
    if (page.length < HELIUS_PAGE || !before) break;
  }
  return parsed;
}

/** Swaps, free receipts and sends from parsed transactions (oldest first). Anything ambiguous (several tokens at once) is skipped and counted. */
export function classify(parsed, solUsd) {
  const events = [];
  let skipped = 0;
  for (const tx of parsed) {
    if (!tx.tokens.length) continue;
    if (tx.tokens.length > 1) { skipped++; continue; }
    const { mint, delta } = tx.tokens[0];
    const quote = tx.sol + (solUsd > 0 ? tx.stable / solUsd : 0);
    if (delta > 0) events.push(quote < -MIN_MOVE_SOL ? { type: "buy", mint, time: tx.time, qty: delta, sol: -quote } : { type: "receive", mint, time: tx.time, qty: delta, sol: 0 });
    else events.push(quote > MIN_MOVE_SOL ? { type: "sell", mint, time: tx.time, qty: -delta, sol: quote } : { type: "send", mint, time: tx.time, qty: -delta, sol: 0 });
  }
  return { events: events.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)), skipped };
}

/** Average-cost accounting per token. Received tokens cost nothing, so selling them is pure profit (and flagged as such). */
export function accountTokens(events) {
  const book = new Map();
  for (const event of events) {
    const token = book.get(event.mint) ?? { mint: event.mint, balance: 0, cost: 0, bought: 0, spent: 0, sold: 0, proceeds: 0, received: 0, realized: 0, freeProceeds: 0, unknownProceeds: 0, firstBuyAt: null, lastSellAt: null, firstSeenAt: event.time, partial: false };
    book.set(event.mint, token);
    if (event.type === "buy") {
      token.balance += event.qty; token.cost += event.sol; token.bought += event.qty; token.spent += event.sol;
      token.firstBuyAt ??= event.time;
    } else if (event.type === "receive") {
      token.balance += event.qty; token.received += event.qty;
    } else if (event.type === "sell" || event.type === "send") {
      const known = Math.min(event.qty, token.balance);
      if (event.qty > token.balance + 1e-9) token.partial = true; // sold tokens bought before the analysed window
      const average = token.balance > 0 ? token.cost / token.balance : 0;
      const costOut = average * known;
      if (event.type === "sell") {
        const share = event.qty > 0 ? known / event.qty : 0;
        token.unknownProceeds += event.sol * (1 - share);
        token.realized += event.sol * share - costOut; token.sold += event.qty; token.proceeds += event.sol; token.lastSellAt = event.time;
        const freeShare = token.balance > 0 ? Math.min(token.received / token.balance, 1) : 0;
        token.freeProceeds += event.sol * share * freeShare;
      }
      token.cost -= costOut; token.balance = Math.max(token.balance - known, 0);
    }
  }
  return [...book.values()];
}

export function summarize(tokens, { now, coverage }) {
  const rows = tokens.map(token => {
    const unrealized = token.balance > 0 && token.priceSol != null ? token.balance * token.priceSol - token.cost : 0;
    const open = token.balance > 1e-9 && token.value > 0.0005;
    const entryMinutes = token.launchedAt && token.firstBuyAt ? Math.max((token.firstBuyAt - token.launchedAt) / 60_000, 0) : null;
    const holdMinutes = token.firstBuyAt && token.lastSellAt && token.lastSellAt > token.firstBuyAt ? (token.lastSellAt - token.firstBuyAt) / 60_000 : null;
    return { ...token, open, unrealized, entryMinutes, holdMinutes, total: token.realized + unrealized, free: token.bought === 0 && token.received > 0 };
  });
  const closed = rows.filter(row => row.sold > 0 && !row.free);
  const wins = closed.filter(row => row.realized > 0);
  const realized = rows.reduce((total, row) => total + row.realized, 0);
  const unrealized = rows.reduce((total, row) => total + row.unrealized, 0);
  const positive = rows.reduce((total, row) => total + Math.max(row.realized, 0), 0);
  const freeProfit = rows.reduce((total, row) => total + Math.max(row.freeProceeds, 0), 0);
  const freeShare = positive > 0 ? Math.min(freeProfit / positive, 1) : 0;
  const entry = median(rows.map(row => row.entryMinutes).filter(value => value != null));
  const notes = [];
  if (coverage.partial) notes.push("coverage");
  if (rows.filter(row => row.sold > 0 || row.bought > 0).length < 8) notes.push("small-sample");
  if (freeShare >= 0.3) notes.push("free-tokens");
  if (Math.abs(unrealized) > Math.abs(realized) && unrealized > 0) notes.push("mostly-unrealized");
  if (entry != null && entry <= 5) notes.push("early-entries");
  if (closed.length >= 5 && wins.length / closed.length < 0.4 && realized + unrealized > 0) notes.push("few-big-wins");
  if (rows.some(row => row.partial)) notes.push("older-history");
  if (coverage.dustTokens >= 5) notes.push("dust");
  return {
    rows,
    stats: {
      tokens: rows.length, closed: closed.length, wins: wins.length, winRate: closed.length ? wins.length / closed.length : null,
      realizedSol: realized, unrealizedSol: unrealized, totalSol: realized + unrealized,
      unknownCostProceedsSol: rows.reduce((total, row) => total + row.unknownProceeds, 0),
      freeProfitShare: freeShare, medianEntryMinutes: entry, medianHoldMinutes: median(rows.map(row => row.holdMinutes).filter(value => value != null)),
      best: rows.filter(row => !row.free).sort((a, b) => b.total - a.total)[0]?.mint ?? null,
      worst: rows.filter(row => !row.free).sort((a, b) => a.total - b.total)[0]?.mint ?? null
    },
    notes, at: now
  };
}

export async function analyzeWallet(address, { rpcUrl, fetchImpl = fetch, now = Date.now(), transactions = null, retryDelay = 500 } = {}) {
  if (!isValidSolanaAddress(address)) throw new WalletAnalysisError("Adresse Solana invalide.");
  const cached = cache.get(address);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.result;
  const heliusKey = heliusKeyFromRpc(rpcUrl);
  const started = Date.now();
  let parsed = [];
  let failed = 0;
  let requested = 0;
  let source = "rpc";
  let reachedLimit = false;

  if (heliusKey) {
    const swapsWanted = Math.min(Math.max(Math.round(Number(transactions) || HELIUS_DEFAULT_SWAPS), 20), HELIUS_MAX_SWAPS);
    try {
      parsed = await fetchHeliusSwaps(address, heliusKey, { fetchImpl, limit: swapsWanted, budgetUntil: started + BUDGET_MS });
      source = "helius"; requested = parsed.length; reachedLimit = parsed.length >= swapsWanted;
    } catch { source = "rpc"; }
    if (source === "helius" && !parsed.length) throw new WalletAnalysisError("Aucun swap trouvé pour cette adresse (ni sur Jupiter, ni sur pump.fun, ni sur les autres DEX).", 404);
  }

  if (source === "rpc") {
    const limit = Math.min(Math.max(Math.round(Number(transactions) || DEFAULT_TRANSACTIONS), 20), MAX_TRANSACTIONS);
    const listed = await rpc(rpcUrl, "getSignaturesForAddress", [address, { limit }], { fetchImpl, delay: retryDelay });
    if (listed.error) throw new WalletAnalysisError(listed.error === "rate-limited" ? "Le RPC Solana limite les requêtes : réessaie dans une minute ou configure SOLANA_RPC_URL." : "RPC Solana indisponible.", 503);
    const signatures = (listed.result ?? []).filter(item => !item.err);
    if (!signatures.length) throw new WalletAnalysisError("Aucune transaction trouvée pour cette adresse.", 404);
    requested = signatures.length; reachedLimit = signatures.length >= limit;
    const queue = [...signatures];
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        if (Date.now() - started > BUDGET_MS) { failed += queue.length; queue.length = 0; return; }
        const item = queue.shift();
        const result = await rpc(rpcUrl, "getTransaction", [item.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }], { fetchImpl, retries: 2, delay: retryDelay });
        const tx = result.result ? parseTransaction(result.result, address) : null;
        if (tx) parsed.push(tx); else if (result.error) failed++;
      }
    }));
  }

  const mintsGuess = [...new Set(parsed.flatMap(tx => tx.tokens.map(token => token.mint)))].slice(0, 60);
  let market = [];
  try { market = await fetchTokensByAddress(mintsGuess, { fetchImpl, now }); } catch { /* prices stay unknown */ }
  const solUsd = market.find(token => token.solPriceUsd > 0)?.solPriceUsd ?? 0;
  const { events, skipped } = classify(parsed, solUsd);
  const info = new Map(market.map(token => [token.address, token]));
  let dustTokens = 0;
  const tokens = accountTokens(events).map(token => {
    const live = info.get(token.mint);
    const priceSol = live && solUsd > 0 ? live.price / solUsd : null;
    const value = priceSol != null ? token.balance * priceSol : 0;
    const dust = token.bought === 0 && token.sold === 0 && value < MIN_FREE_VALUE_SOL; // received only: airdrop / spam
    if (dust) dustTokens++;
    return { ...token, dust, symbol: live?.symbol ?? null, name: live?.name ?? null, priceSol, priceKnown: priceSol != null, value: priceSol != null ? token.balance * priceSol : 0, launchedAt: live?.ageMinutes != null ? now - live.ageMinutes * 60_000 : null };
  });
  const real = tokens.filter(token => !token.dust);
  const times = parsed.map(tx => tx.time).filter(Boolean);
  const coverage = { source, requested, analysed: parsed.length, failed, skipped, dustTokens, from: times.length ? Math.min(...times) : null, to: times.length ? Math.max(...times) : null, partial: failed > 0 || reachedLimit };
  const summary = summarize(real, { now, coverage });
  const result = { address, solUsd, coverage, stats: summary.stats, notes: summary.notes, tokens: summary.rows.map(row => ({
    mint: row.mint, symbol: row.symbol, name: row.name, bought: row.bought, spentSol: row.spent, soldSol: row.proceeds, realizedSol: row.realized, unrealizedSol: row.unrealized, totalSol: row.total,
    balance: row.balance, valueSol: row.value, open: row.open, free: row.free, partial: row.partial, priceKnown: row.priceKnown,
    entryMinutes: row.entryMinutes, holdMinutes: row.holdMinutes, firstBuyAt: row.firstBuyAt, lastSellAt: row.lastSellAt
  })).sort((a, b) => Math.abs(b.totalSol) - Math.abs(a.totalSol)).slice(0, 40), at: now };
  if (parsed.length) { cache.set(address, { at: now, result }); if (cache.size > 100) cache.delete(cache.keys().next().value); }
  return result;
}

export const _test = { cache };
