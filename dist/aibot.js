/**
 * AI Agent Bot (TEST mode only): buys the coins the AI Agent scores highest. The exits mirror the definition the agent learned on
 * (take-profit = the "win" move, stop-loss = the "loss" move), so the policy being traded is the one that was measured.
 * Pure decision logic like hrbot.js: it never decides alone, the probability comes from the server's validated model.
 */
export const DEFAULT_AI = { enabled: false, minProb: 55, amount: 100, takeProfitPct: 20, stopLossPct: 12, maxOpen: 3, dailyLossPct: 5, cooldownHours: 24, minLiquidity: 5000, minMcap: 0, maxMcap: 0 };
const BASE_ASSETS = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const clamp = (value, min, max, fallback) => { const number = Number(value); return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback; };

export function normalizeAi(raw) {
  const base = DEFAULT_AI;
  return {
    enabled: raw?.enabled === true,
    minProb: clamp(raw?.minProb, 5, 95, base.minProb),
    amount: clamp(raw?.amount, 10, 5000, base.amount),
    takeProfitPct: clamp(raw?.takeProfitPct, 1, 500, base.takeProfitPct),
    stopLossPct: clamp(raw?.stopLossPct, 1, 90, base.stopLossPct),
    maxOpen: Math.round(clamp(raw?.maxOpen, 1, 20, base.maxOpen)),
    dailyLossPct: clamp(raw?.dailyLossPct, 0.5, 100, base.dailyLossPct),
    cooldownHours: clamp(raw?.cooldownHours, 0, 168, base.cooldownHours),
    minLiquidity: clamp(raw?.minLiquidity, 0, 10_000_000, base.minLiquidity),
    minMcap: clamp(raw?.minMcap, 0, 1e12, base.minMcap),
    maxMcap: clamp(raw?.maxMcap, 0, 1e12, base.maxMcap) // 0 = no upper limit
  };
}

const startOfDay = now => { const date = new Date(now); date.setHours(0, 0, 0, 0); return date.getTime(); };
export const aiPnlToday = (history, now = Date.now()) => history.filter(trade => trade.ai && trade.closedAt >= startOfDay(now)).reduce((total, trade) => total + trade.pnl, 0);
export function aiStats(history) {
  const trades = history.filter(trade => trade.ai);
  const wins = trades.filter(trade => trade.pnl > 0);
  return { count: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : null, pnl: trades.reduce((total, trade) => total + trade.pnl, 0) };
}

/** { buys: [{ token, amount, p }], paused } — highest probability first. */
export function pickAiEntries({ coins, positions, history, balance, startBalance, config, lastEntries = {}, now = Date.now() }) {
  const result = { buys: [], paused: null };
  if (!config.enabled) return result;
  if (aiPnlToday(history, now) <= -(startBalance * config.dailyLossPct / 100)) return { ...result, paused: "daily-loss" };
  const held = new Set(positions.map(position => position.tokenId));
  let slots = config.maxOpen - positions.filter(position => position.ai).length;
  let available = balance;
  const cooldown = config.cooldownHours * 3_600_000;
  const seen = new Set();
  const eligible = coins.filter(token => {
    if (!token?.ai?.ready || !(token.ai.p * 100 >= config.minProb) || seen.has(token.id)) return false;
    seen.add(token.id);
    return !BASE_ASSETS.has(token.id) && !held.has(token.id) && token.price > 0 && Number(token.liquidity) >= config.minLiquidity && Number(token.marketCap ?? 0) >= config.minMcap && (!(config.maxMcap > 0) || Number(token.marketCap ?? 0) <= config.maxMcap) && now - (lastEntries[token.id] ?? 0) >= cooldown;
  }).sort((first, second) => second.ai.p - first.ai.p);
  for (const token of eligible) {
    if (slots <= 0 || available < config.amount) break;
    available -= config.amount; slots -= 1;
    result.buys.push({ token, amount: config.amount, p: token.ai.p });
  }
  return result;
}
