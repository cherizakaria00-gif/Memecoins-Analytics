/**
 * Channel Call Bot (TEST mode only): enters a coin right away when a call is posted in the owner's Telegram channel.
 * It never chases: a call that is too old, a coin that already ran up since the post, a result post ("X3") or a coin it already holds is ignored.
 * Pure decision logic like hrbot.js; the calls come from the server (/api/channel-calls).
 */
export const DEFAULT_CALL = { enabled: false, amount: 100, takeProfitPct: 20, stopLossPct: 15, maxAgeMin: 5, maxChasePct: 15, minLiquidity: 5000, maxOpen: 3, dailyLossPct: 10, cooldownHours: 24, reentries: true, useChannelSl: true };
const BASE_ASSETS = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
const clamp = (value, min, max, fallback) => { const number = Number(value); return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback; };

export function normalizeCall(raw) {
  const base = DEFAULT_CALL;
  return {
    enabled: raw?.enabled === true,
    amount: clamp(raw?.amount, 10, 5000, base.amount),
    takeProfitPct: clamp(raw?.takeProfitPct, 1, 500, base.takeProfitPct),
    stopLossPct: clamp(raw?.stopLossPct, 1, 90, base.stopLossPct),
    maxAgeMin: clamp(raw?.maxAgeMin, 1, 120, base.maxAgeMin),
    maxChasePct: clamp(raw?.maxChasePct, 0, 200, base.maxChasePct),
    minLiquidity: clamp(raw?.minLiquidity, 0, 10_000_000, base.minLiquidity),
    maxOpen: Math.round(clamp(raw?.maxOpen, 1, 20, base.maxOpen)),
    dailyLossPct: clamp(raw?.dailyLossPct, 0.5, 100, base.dailyLossPct),
    cooldownHours: clamp(raw?.cooldownHours, 0, 168, base.cooldownHours),
    reentries: raw?.reentries === undefined ? base.reentries : raw.reentries === true,
    useChannelSl: raw?.useChannelSl === undefined ? base.useChannelSl : raw.useChannelSl === true
  };
}

const startOfDay = now => { const date = new Date(now); date.setHours(0, 0, 0, 0); return date.getTime(); };
export const callPnlToday = (history, now = Date.now()) => history.filter(trade => trade.call && trade.closedAt >= startOfDay(now)).reduce((total, trade) => total + trade.pnl, 0);
export function callStats(history) {
  const trades = history.filter(trade => trade.call);
  const wins = trades.filter(trade => trade.pnl > 0);
  return { count: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : null, pnl: trades.reduce((total, trade) => total + trade.pnl, 0) };
}

/**
 * The stop-loss written in the post ("SL 100K") is a market-cap level. Without one, the bot's own stop-loss % below the price at the call applies.
 * Returns the reason when the coin is already under that level (the call is dead: it leaves the early-start list and is never entered), otherwise null.
 */
export function callStopReason(call, config) {
  const token = call.token;
  if (!token) return null;
  if (config.useChannelSl && call.slMcap > 0) return Number(token.marketCap) > 0 && token.marketCap <= call.slMcap ? "SL du canal atteint" : null;
  if (call.priceAtCall > 0 && token.price > 0 && token.price <= call.priceAtCall * (1 - config.stopLossPct / 100)) return "stop-loss atteint depuis le call";
  return null;
}

/** Stop-loss % to place on an entry: the channel's level converted from market cap to a percentage of today's market cap, else the configured one. */
export function entryStopPct(call, config) {
  const token = call.token;
  if (config.useChannelSl && call.slMcap > 0 && token?.marketCap > 0) return clamp((1 - call.slMcap / token.marketCap) * 100, 1, 90, config.stopLossPct);
  return config.stopLossPct;
}

/** Why a call is not entered right now (null = it can be entered). */
export function callRejection(call, config, now = Date.now()) {
  if (call.kind === "update") return "résultat ou réponse, pas une entrée";
  if (call.kind === "repeat" || (call.kind === "reentry" && !config.reentries)) return call.kind === "repeat" ? "coin déjà annoncé" : "ré-entrée désactivée";
  if (now - call.at > config.maxAgeMin * 60_000) return "call trop ancien";
  const token = call.token;
  if (!(token?.price > 0)) return "prix introuvable";
  if (BASE_ASSETS.has(token.id)) return "actif de base";
  if (!(Number(token.liquidity) >= config.minLiquidity)) return "liquidité trop faible";
  if (call.priceAtCall > 0 && (token.price / call.priceAtCall - 1) * 100 > config.maxChasePct) return "le prix a déjà trop monté";
  const stopped = callStopReason(call, config);
  if (stopped) return stopped;
  if (config.useChannelSl && call.slMcap > 0 && entryStopPct(call, config) < 2) return "SL du canal trop proche";
  return null;
}

/** { buys: [{ token, call, amount }], paused } — newest calls first. */
export function pickCallEntries({ calls, positions, history, balance, startBalance, config, lastEntries = {}, now = Date.now() }) {
  const result = { buys: [], paused: null };
  if (!config.enabled) return result;
  if (callPnlToday(history, now) <= -(startBalance * config.dailyLossPct / 100)) return { ...result, paused: "daily-loss" };
  const held = new Set(positions.map(position => position.tokenId));
  let slots = config.maxOpen - positions.filter(position => position.call).length;
  let available = balance;
  const cooldown = config.cooldownHours * 3_600_000;
  for (const call of [...calls].sort((first, second) => second.at - first.at)) {
    if (slots <= 0 || available < config.amount) break;
    const token = call.token;
    if (callRejection(call, config, now) || held.has(token.id) || now - (lastEntries[token.id] ?? 0) < cooldown) continue;
    held.add(token.id); available -= config.amount; slots -= 1;
    result.buys.push({ token, call, amount: config.amount, stopLossPct: entryStopPct(call, config) });
  }
  return result;
}
