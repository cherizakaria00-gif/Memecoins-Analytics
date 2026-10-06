/**
 * Auto-trade bot (TEST mode only). Pure decision logic: given the scanned tokens and the paper wallet it returns the
 * buys to make, using fixed rules set by the user: entry size as a % of the balance, fixed stop-loss / take-profit,
 * a cap on open bot positions, a cooldown per token and a daily loss limit that pauses the bot.
 */
export const BOT_SOURCES = ["both", "qualified", "early"];
export const DEFAULT_BOT = { enabled: false, source: "both", minScore: 70, sizePct: 5, maxAmount: 500, stopLossPct: 25, takeProfitPct: 50, maxOpen: 3, dailyLossPct: 5, cooldownHours: 24 };

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
    cooldownHours: clamp(raw?.cooldownHours, 0, 168, base.cooldownHours)
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

/**
 * Decides what the bot buys now. `isQualified(token)` is the app's qualified-signal test; `lastEntries` maps tokenId → last bot entry time.
 * Returns { buys: [{ token, amount, score, source }], paused: string|null }.
 */
export function pickEntries({ tokens, positions, history, balance, startBalance, config, lastEntries = {}, isQualified, now = Date.now() }) {
  if (!config.enabled) return { buys: [], paused: null };
  const lossLimit = startBalance * config.dailyLossPct / 100;
  if (botPnlToday(history, now) <= -lossLimit) return { buys: [], paused: "daily-loss" };
  const botOpen = positions.filter(position => position.auto).length;
  const slots = config.maxOpen - botOpen;
  if (slots <= 0) return { buys: [], paused: null };
  const held = new Set(positions.map(position => position.tokenId));
  const cooldown = config.cooldownHours * 3_600_000;
  const candidates = [];
  for (const token of tokens) {
    if (held.has(token.id) || !(token.price > 0) || !(token.liquidity > 0)) continue;
    if (now - (lastEntries[token.id] ?? 0) < cooldown) continue;
    const qualified = config.source !== "early" && isQualified(token);
    const early = config.source !== "qualified" && Boolean(token.early?.early);
    if (!qualified && !early) continue;
    const score = Math.max(qualified ? Number(token.score) || 0 : 0, early ? Number(token.early.score) || 0 : 0);
    if (score < config.minScore) continue;
    candidates.push({ token, score, source: early && !qualified ? "early" : "qualified" });
  }
  candidates.sort((first, second) => second.score - first.score);
  const buys = [];
  let available = balance;
  for (const candidate of candidates.slice(0, slots)) {
    const amount = Math.floor(Math.min(config.maxAmount, balance * config.sizePct / 100, available) * 100) / 100;
    if (amount < 10) break;
    available -= amount;
    buys.push({ ...candidate, amount });
  }
  return { buys, paused: null };
}
