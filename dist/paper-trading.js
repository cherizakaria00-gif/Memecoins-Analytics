export const FEE_RATE = 0.01;
export const MIN_TRADE = 10;
export const START_BALANCE = 10000;
const HISTORY_LIMIT = 100;

/**
 * Fee presets (capital in SOL, priority fee and tip in SOL per transaction, max slippage in %).
 * `passiveSol` and `deepPassSol` come from the same table and are kept for reference only.
 */
export const FEE_PRESETS = [
  { id: "normal", label: "Normal", capitalMinSol: 0.05, capitalMaxSol: 1, priorityFeeSol: 0.002, tipSol: 0.002, slippageBuyPct: 15, slippageSellPct: 20, passiveSol: 0.1, deepPassSol: 0.3, accent: "#4ade80" },
  { id: "aggressive", label: "Aggressive", capitalMinSol: 1, capitalMaxSol: 5, priorityFeeSol: 0.008, tipSol: 0.008, slippageBuyPct: 30, slippageSellPct: 40, passiveSol: 0.3, deepPassSol: 1, accent: "#fbbf24" },
  { id: "sniper", label: "Sniper / War", capitalMinSol: 5, capitalMaxSol: 20, capitalOpenEnded: true, priorityFeeSol: 0.015, tipSol: 0.015, slippageBuyPct: 50, slippageSellPct: 70, passiveSol: 1, deepPassSol: 3, accent: "#f87171" }
];

export const presetById = id => FEE_PRESETS.find(preset => preset.id === id) ?? FEE_PRESETS[0];

/** Preset matching the size of the order (in SOL): up to 1 normal, up to 5 aggressive, beyond that sniper / war. */
export function presetForCapital(sol) {
  if (!(sol >= 0)) return FEE_PRESETS[0];
  return sol <= 1 ? FEE_PRESETS[0] : sol <= 5 ? FEE_PRESETS[1] : FEE_PRESETS[2];
}

/** Costs of one transaction under a preset: the platform fee rate plus priority fee + tip converted to dollars. */
export function costsFor(preset, solUsd) {
  const usd = isPositive(solUsd) ? solUsd : 0;
  return { platformFeeRate: FEE_RATE, networkCostUsd: ((preset?.priorityFeeSol ?? 0) + (preset?.tipSol ?? 0)) * usd };
}

const isPositive = value => Number.isFinite(value) && value > 0;

/** Quote-side reserve of a constant-product pool holding `liquidity` dollars in total. */
function quoteReserve(liquidity) {
  return Math.max(isPositive(liquidity) ? liquidity / 2 : 0, 1);
}

/** Price paid per token when buying `netAmount` dollars: average price of a constant-product swap. */
export function buyFillPrice(spotPrice, netAmount, liquidity) {
  const reserve = quoteReserve(liquidity);
  return spotPrice * (reserve + netAmount) / reserve;
}

/** Dollars received for selling tokens worth `grossValue` at spot, after price impact and fees. */
export function sellProceeds(grossValue, liquidity, costs = {}) {
  const reserve = quoteReserve(liquidity);
  const afterImpact = grossValue * reserve / (reserve + grossValue);
  return Math.max(afterImpact * (1 - (costs.platformFeeRate ?? FEE_RATE)) - (costs.networkCostUsd ?? 0), 0);
}

/** Share of the sale value lost to price impact (0..1). */
export const sellImpact = (grossValue, liquidity) => grossValue / (quoteReserve(liquidity) + grossValue);

export function quoteBuy({ price, liquidity }, amount, costs = {}) {
  if (!isPositive(price)) return null;
  const fee = amount * (costs.platformFeeRate ?? FEE_RATE);
  const network = costs.networkCostUsd ?? 0;
  const net = amount - fee - network;
  if (!(net > 0)) return null;
  const fillPrice = buyFillPrice(price, net, liquidity);
  return { fee, network, units: net / fillPrice, fillPrice, impact: fillPrice / price - 1 };
}

export function validateBuy(token, amount, balance, { preset = null, costs = {} } = {}) {
  if (!token || !isPositive(token.price)) return "Prix indisponible pour ce token.";
  if (!Number.isFinite(amount) || amount < MIN_TRADE) return `Le montant minimum est de ${MIN_TRADE} $.`;
  if (amount > balance + 1e-9) return "Solde paper insuffisant.";
  const quote = quoteBuy(token, amount, costs);
  if (!quote) return "Montant trop faible pour couvrir les frais du preset.";
  if (preset && quote.impact * 100 > preset.slippageBuyPct) {
    return `Slippage trop élevé : impact ${(quote.impact * 100).toFixed(1)} % > ${preset.slippageBuyPct} % (preset ${preset.label}). Réduis le montant ou choisis un preset plus agressif.`;
  }
  return null;
}

const optionalPercent = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

export function openPosition(token, amount, { stopLossPct = null, takeProfitPct = null, now = Date.now(), costs = {}, preset = null } = {}) {
  const quote = quoteBuy(token, amount, costs);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`,
    tokenId: token.id, tokenName: token.name, tokenSymbol: token.symbol, tokenInitials: token.initials,
    amount, fee: quote.fee, networkCostUsd: costs.networkCostUsd ?? 0, presetId: preset?.id ?? null, slippageSellPct: preset?.slippageSellPct ?? null, units: quote.units, entryPrice: quote.fillPrice, spotEntry: token.price,
    lastPrice: token.price, liquidity: token.liquidity, openedAt: now,
    stopLossPct: optionalPercent(stopLossPct) && Math.min(optionalPercent(stopLossPct), 99),
    takeProfitPct: optionalPercent(takeProfitPct)
  };
}

/** Net value if the whole position were sold now (price impact and fee included). */
export function positionValue(position, token) {
  const price = isPositive(token?.price) ? token.price : position.lastPrice ?? position.spotEntry;
  const liquidity = isPositive(token?.liquidity) ? token.liquidity : position.liquidity;
  return sellProceeds(position.units * price, liquidity, { networkCostUsd: position.networkCostUsd ?? 0 });
}

/** Sells `fraction` (0-1] of a position; returns the realized trade and what is left (null when fully closed). */
export function sellFraction(position, token, fraction, { reason = "manual", now = Date.now(), force = true } = {}) {
  const share = Math.min(Math.max(Number(fraction) || 0, 0), 1);
  if (share <= 0) return null;
  const price = isPositive(token?.price) ? token.price : position.lastPrice ?? position.spotEntry;
  const liquidity = isPositive(token?.liquidity) ? token.liquidity : position.liquidity;
  const grossValue = position.units * share * price;
  const impact = sellImpact(grossValue, liquidity);
  if (!force && position.slippageSellPct && impact * 100 > position.slippageSellPct) return { blocked: true, impact, limit: position.slippageSellPct };
  const proceeds = sellProceeds(grossValue, liquidity, { networkCostUsd: position.networkCostUsd ?? 0 });
  const cost = position.amount * share;
  const pnl = proceeds - cost;
  const remaining = share >= 0.999999 ? null : {
    ...position,
    amount: position.amount - cost,
    fee: position.fee * (1 - share),
    networkCostUsd: position.networkCostUsd ?? 0,
    units: position.units * (1 - share)
  };
  return {
    proceeds, remaining,
    trade: {
      id: `${position.id}-${now}`, positionId: position.id, tokenId: position.tokenId, tokenName: position.tokenName, tokenSymbol: position.tokenSymbol,
      amount: cost, proceeds, pnl, pnlPct: pnl / cost * 100, reason, fraction: share, impactPct: impact * 100, presetId: position.presetId ?? null, exitLiquidity: liquidity ?? null,
      entryPrice: position.entryPrice, exitPrice: price, openedAt: position.openedAt, closedAt: now, auto: Boolean(position.auto)
    }
  };
}

export function closePosition(position, token, now = Date.now()) {
  const { proceeds, trade } = sellFraction(position, token, 1, { now });
  return { proceeds, trade };
}

/** Returns "stop-loss" or "take-profit" when the net P&L of a position crossed one of its limits. */
export function checkTriggers(position, token) {
  const pnlPct = (positionValue(position, token) - position.amount) / position.amount * 100;
  if (position.stopLossPct && pnlPct <= -position.stopLossPct) return "stop-loss";
  if (position.takeProfitPct && pnlPct >= position.takeProfitPct) return "take-profit";
  return null;
}

export function summarizeHistory(history) {
  const realized = history.reduce((total, trade) => total + trade.pnl, 0);
  const wins = history.filter(trade => trade.pnl > 0).length;
  return { realized, count: history.length, winRate: history.length ? wins / history.length * 100 : null };
}

export function pushHistory(history, trade) {
  return [trade, ...history].slice(0, HISTORY_LIMIT);
}

/** Rebuilds a safe wallet from untrusted localStorage content, migrating positions saved before fees existed. */
export function normalizeWallet(raw) {
  const balance = Number(raw?.balance);
  const positions = (Array.isArray(raw?.positions) ? raw.positions : []).map(position => {
    const amount = Number(position?.amount);
    const entryPrice = Number(position?.entryPrice);
    if (!isPositive(amount) || !isPositive(entryPrice) || typeof position?.tokenId !== "string") return null;
    return {
      ...position,
      id: String(position.id ?? `${position.tokenId}-${position.openedAt ?? 0}`),
      amount, entryPrice,
      fee: Number(position.fee) || 0,
      networkCostUsd: Number(position.networkCostUsd) || 0,
      stopLossPct: optionalPercent(position.stopLossPct),
      takeProfitPct: optionalPercent(position.takeProfitPct),
      units: isPositive(Number(position.units)) ? Number(position.units) : amount / entryPrice,
      spotEntry: isPositive(Number(position.spotEntry)) ? Number(position.spotEntry) : entryPrice
    };
  }).filter(Boolean);
  const history = (Array.isArray(raw?.history) ? raw.history : []).filter(trade => Number.isFinite(trade?.pnl) && Number.isFinite(trade?.amount));
  return { balance: Number.isFinite(balance) && balance >= 0 ? balance : START_BALANCE, positions, history };
}

/** Rebuilds safe manual limit orders from untrusted localStorage content. */
export function normalizeLimitOrders(raw) {
  return (Array.isArray(raw) ? raw : []).filter(order => order && typeof order.tokenId === "string" && isPositive(Number(order.limitPrice)) && isPositive(Number(order.amount)) && Number(order.expiresAt) > 0)
    .map(order => ({
      id: String(order.id ?? `${order.tokenId}-${order.createdAt ?? 0}`), tokenId: order.tokenId, symbol: String(order.symbol ?? "").slice(0, 20), amount: Number(order.amount),
      limitPrice: Number(order.limitPrice), refPrice: Number(order.refPrice) || Number(order.limitPrice), dipPct: Number(order.dipPct) || 0,
      stopLossPct: optionalPercent(order.stopLossPct), takeProfitPct: optionalPercent(order.takeProfitPct), createdAt: Number(order.createdAt) || 0, expiresAt: Number(order.expiresAt)
    })).slice(0, 20);
}

/** Splits limit orders into filled (price at or below the limit), expired and still waiting. `tokenFor(id)` returns the live token. */
export function settleLimitOrders(orders, tokenFor, now = Date.now()) {
  const filled = []; const expired = []; const waiting = [];
  for (const order of orders) {
    if (now >= order.expiresAt) { expired.push(order); continue; }
    const token = tokenFor(order.tokenId);
    if (token && isPositive(token.price) && token.price <= order.limitPrice) filled.push({ order, token }); else waiting.push(order);
  }
  return { filled, expired, waiting };
}

export const TIMEFRAME_SECONDS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

/**
 * Chart markers for one token: one buy per position (open or since sold) and one sell per realized
 * trade, snapped to the candle that contains the event. Events before the first candle are skipped.
 */
export function buildTradeMarkers({ tokenId, positions, history, timeframe, firstCandleTime }) {
  const step = TIMEFRAME_SECONDS[timeframe] ?? 300;
  const bucket = ms => Math.floor(ms / 1000 / step) * step;
  const buys = new Map();
  for (const position of positions) {
    if (position.tokenId === tokenId) buys.set(position.id, { at: position.openedAt, price: position.spotEntry, amount: position.amount });
  }
  const sells = history.filter(trade => trade.tokenId === tokenId);
  for (const trade of sells) {
    const key = trade.positionId ?? `legacy-${trade.openedAt}`;
    const known = buys.get(key);
    buys.set(key, { at: trade.openedAt, price: known?.price ?? trade.entryPrice, amount: Math.max(known?.amount ?? 0, trade.amount / (trade.fraction || 1)) });
  }
  const label = { "stop-loss": "SL", "take-profit": "TP" };
  const markers = [
    ...[...buys.values()].map(buy => ({ time: bucket(buy.at), position: "belowBar", shape: "arrowUp", color: "#4ade80", text: `Achat $${Math.round(buy.amount)}`, price: buy.price })),
    ...sells.map(trade => ({
      time: bucket(trade.closedAt), position: "aboveBar", shape: "arrowDown", color: trade.pnl >= 0 ? "#86efac" : "#f87171",
      text: `${label[trade.reason] ?? `Vente ${Math.round((trade.fraction ?? 1) * 100)}%`} ${trade.pnl >= 0 ? "+" : "−"}$${Math.abs(Math.round(trade.pnl))}`, price: trade.exitPrice
    }))
  ];
  return markers.filter(marker => marker.time >= (firstCandleTime ?? 0)).sort((first, second) => first.time - second.time);
}
