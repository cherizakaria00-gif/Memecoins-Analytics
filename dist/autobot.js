/**
 * Auto-trade bot (TEST mode only). Pure decision logic: given the scanned tokens and the paper wallet it returns the
 * buys to make, using fixed rules set by the user: entry size as a % of the balance, fixed stop-loss / take-profit,
 * a cap on open bot positions, a cooldown per token and a daily loss limit that pauses the bot.
 */
/** Base assets (SOL, USDC, USDT): never a bot target. */
export const BASE_ASSETS = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
export const BOT_SOURCES = ["both", "qualified", "early"];
export const DEFAULT_BOT = { enabled: false, source: "both", minScore: 70, sizePct: 5, maxAmount: 500, stopLossPct: 25, takeProfitPct: 50, maxOpen: 3, dailyLossPct: 5, cooldownHours: 24, entryDipPct: 3, orderTimeoutMin: 30 };

const clamp = (value, min, max, fallback) => { const number = Number(value); return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback; };

/** Rebuilds a safe config from untrusted localStorage content. */
export function normalizeBot(raw) {
  const base = DEFAULT_BOT;
  return {
    enabled: raw?.enabled === true,
    source: BOT_SOURCES.includes(raw?.source) ? raw.source : base.source,
    minScore: clamp(raw?.minScore, 0, 100, base.minScore),
    sizePct: clamp(raw?.sizePct, 0.5, 50, base.sizePct),
    maxAmount: clamp(raw?.maxAmount, 10, 100000, base.maxAmount),
    stopLossPct: clamp(raw?.stopLossPct, 1, 90, base.stopLossPct),
    takeProfitPct: clamp(raw?.takeProfitPct, 1, 1000, base.takeProfitPct),
    maxOpen: Math.round(clamp(raw?.maxOpen, 1, 20, base.maxOpen)),
    dailyLossPct: clamp(raw?.dailyLossPct, 0.5, 100, base.dailyLossPct),
    cooldownHours: clamp(raw?.cooldownHours, 0, 168, base.cooldownHours),
    entryDipPct: clamp(raw?.entryDipPct, 0, 30, base.entryDipPct),
    orderTimeoutMin: Math.round(clamp(raw?.orderTimeoutMin, 1, 720, base.orderTimeoutMin))
  };
}

const startOfDay = now => { const date = new Date(now); date.setHours(0, 0, 0, 0); return date.getTime(); };

/** Realized P&L of the bot's own trades since local midnight. */
export function botPnlToday(history, now = Date.now()) {
  const from = startOfDay(now);
  return history.filter(trade => trade.auto && trade.closedAt >= from).reduce((total, trade) => total + trade.pnl, 0);
}

export function botStats(history) {
  const trades = history.filter(trade => trade.auto);
  const wins = trades.filter(trade => trade.pnl > 0);
  const pnl = trades.reduce((total, trade) => total + trade.pnl, 0);
  return { count: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : null, pnl, avgPct: trades.length ? trades.reduce((total, trade) => total + trade.pnlPct, 0) / trades.length : null };
}

/** Rebuilds safe pending limit orders from untrusted localStorage content. */
export function normalizePending(raw) {
  return (Array.isArray(raw) ? raw : []).filter(order => order && typeof order.tokenId === "string" && order.limitPrice > 0 && order.expiresAt > 0)
    .map(order => ({ tokenId: order.tokenId, symbol: String(order.symbol ?? "").slice(0, 20), limitPrice: Number(order.limitPrice), refPrice: Number(order.refPrice) || Number(order.limitPrice), score: Number(order.score) || 0, source: order.source === "early" ? "early" : "qualified", createdAt: Number(order.createdAt) || 0, expiresAt: Number(order.expiresAt) })).slice(0, 20);
}

/**
 * Decides what the bot does now. `isQualified(token)` is the app's qualified-signal test; `lastEntries` maps tokenId → last bot entry time.
 * With an entry dip (e.g. 3 %) a new signal does not buy at market: it places a limit order at `price × (1 − dip)` that is filled when the price
 * comes down to it and cancelled after `orderTimeoutMin`. Returns { buys: [{ token, amount, score, source, limit? }], pending, expired, placed, paused }.
 */
export function pickEntries({ tokens, positions, history, balance, startBalance, config, lastEntries = {}, pending = [], isQualified, now = Date.now() }) {
  const result = { buys: [], pending: [], expired: [], placed: [], paused: null };
  if (!config.enabled) return result;
  const lossLimit = startBalance * config.dailyLossPct / 100;
  if (botPnlToday(history, now) <= -lossLimit) return { ...result, pending, paused: "daily-loss" };
  const byId = new Map(tokens.map(token => [token.id, token]));
  const held = new Set(positions.map(position => position.tokenId));
  const botOpen = positions.filter(position => position.auto).length;
  let slots = config.maxOpen - botOpen;
  let available = balance;
  const sizeFor = () => Math.floor(Math.min(config.maxAmount, balance * config.sizePct / 100, available) * 100) / 100;
  const buy = (token, score, source, extra = {}) => {
    const amount = sizeFor();
    if (amount < 10 || slots <= 0) return false;
    available -= amount; slots -= 1; held.add(token.id);
    result.buys.push({ token, score, source, amount, ...extra });
    return true;
  };

  // 1. pending limit orders: expire, fill or keep waiting
  const waiting = [];
  for (const order of pending) {
    const token = byId.get(order.tokenId);
    if (now >= order.expiresAt) { result.expired.push(order); continue; }
    if (held.has(order.tokenId) || !token) { waiting.push(order); continue; }
    if (token.price > 0 && token.price <= order.limitPrice && buy(token, order.score, order.source, { limit: order.limitPrice })) continue;
    waiting.push(order);
  }
  const queued = new Set(waiting.map(order => order.tokenId));

  // 2. new signals: buy at market, or queue a limit order below the current price
  const cooldown = config.cooldownHours * 3_600_000;
  const candidates = [];
  for (const token of tokens) {
    if (BASE_ASSETS.has(token.id) || held.has(token.id) || queued.has(token.id) || !(token.price > 0) || !(token.liquidity > 0)) continue;
    if (now - (lastEntries[token.id] ?? 0) < cooldown) continue;
    const qualified = config.source !== "early" && isQualified(token);
    const early = config.source !== "qualified" && Boolean(token.early?.early);
    if (!qualified && !early) continue;
    const score = Math.max(qualified ? Number(token.score) || 0 : 0, early ? Number(token.early.score) || 0 : 0);
    if (score < config.minScore) continue;
    candidates.push({ token, score, source: early && !qualified ? "early" : "qualified" });
  }
  candidates.sort((first, second) => second.score - first.score);
  for (const { token, score, source } of candidates) {
    if (slots - waiting.length <= 0 && config.entryDipPct > 0) break;
    if (config.entryDipPct > 0) {
      const order = { tokenId: token.id, symbol: token.symbol, limitPrice: token.price * (1 - config.entryDipPct / 100), refPrice: token.price, score, source, createdAt: now, expiresAt: now + config.orderTimeoutMin * 60_000 };
      waiting.push(order); result.placed.push(order);
    } else if (!buy(token, score, source)) break;
  }
  result.pending = waiting;
  return result;
}
