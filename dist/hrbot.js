/**
 * High Risk Bot (TEST mode only): buys brand-new pump.fun coins by itself and sells them as soon as the position is up by a small
 * fixed take-profit (5 % by default, net of fees). It is deliberately aggressive: a new coin can drop 50 % in a minute or never reach +5 %.
 * Pure decision logic, like autobot.js: given the "New coins" list and the paper wallet it returns the buys to make.
 */
export const DEFAULT_HR = {
  enabled: false, amount: 50, takeProfitPct: 5, stopLossPct: 15, maxAgeMin: 15, minMcap: 5500, maxMcap: 100_000, minVolume: 1000,
  maxOpen: 5, dailyLossPct: 10, cooldownHours: 24, requireFilter: false, requireSocials: false, requireSecurity: true, minHolderGrowthPct: 30
};

/** Security limits of the High Risk Bot: top 10 under 25 %, dev / snipers / insiders / bundles at 0 % (below 0.05 %, i.e. shown as 0.0 %), fees of at least 0.5 SOL. */
export const SECURITY_GREEN = { top10Pct: 25, devPct: 0.05, sniperPct: 0.05, insidersPct: 0.05, bundlerPct: 0.05, minFeesSol: 0.5 };

const clamp = (value, min, max, fallback) => { const number = Number(value); return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback; };

/** Rebuilds a safe config from untrusted localStorage content. */
export function normalizeHr(raw) {
  const base = DEFAULT_HR;
  return {
    enabled: raw?.enabled === true,
    amount: clamp(raw?.amount, 10, 5000, base.amount),
    takeProfitPct: clamp(raw?.takeProfitPct, 1, 100, base.takeProfitPct),
    stopLossPct: clamp(raw?.stopLossPct, 1, 90, base.stopLossPct),
    maxAgeMin: Math.round(clamp(raw?.maxAgeMin, 1, 240, base.maxAgeMin)),
    minMcap: clamp(raw?.minMcap, 0, 10_000_000, base.minMcap),
    maxMcap: clamp(raw?.maxMcap, 1000, 100_000_000, base.maxMcap),
    minVolume: clamp(raw?.minVolume, 0, 10_000_000, base.minVolume),
    maxOpen: Math.round(clamp(raw?.maxOpen, 1, 20, base.maxOpen)),
    dailyLossPct: clamp(raw?.dailyLossPct, 0.5, 100, base.dailyLossPct),
    cooldownHours: clamp(raw?.cooldownHours, 0, 168, base.cooldownHours),
    requireFilter: raw?.requireFilter === true,
    requireSocials: raw?.requireSocials === true,
    minHolderGrowthPct: clamp(raw?.minHolderGrowthPct, 0, 1000, base.minHolderGrowthPct),
    requireSecurity: raw?.requireSecurity === undefined ? base.requireSecurity : raw.requireSecurity === true
  };
}

const startOfDay = now => { const date = new Date(now); date.setHours(0, 0, 0, 0); return date.getTime(); };
const mine = trade => Boolean(trade.hr);

export function hrPnlToday(history, now = Date.now()) {
  const from = startOfDay(now);
  return history.filter(trade => mine(trade) && trade.closedAt >= from).reduce((total, trade) => total + trade.pnl, 0);
}

export function hrStats(history) {
  const trades = history.filter(mine);
  const wins = trades.filter(trade => trade.pnl > 0);
  return { count: trades.length, wins: wins.length, winRate: trades.length ? wins.length / trades.length * 100 : null, pnl: trades.reduce((total, trade) => total + trade.pnl, 0) };
}

/** Null when the coin meets every security limit above; otherwise the first problem. */
export function securityProblem(token) {
  const holders = token.holderStats?.reliable ? token.holderStats : null;
  if (!holders) return "données holders absentes";
  const limit = SECURITY_GREEN;
  const insiders = holders.insidersPct ?? holders.devPct + holders.sniperPct + holders.bundlerPct;
  if (holders.top10Pct >= limit.top10Pct) return "top 10 holders ≥ 25 %";
  if (holders.devPct >= limit.devPct) return "dev holding au-dessus de 0 %";
  if (holders.sniperPct >= limit.sniperPct) return "snipers au-dessus de 0 %";
  if (insiders >= limit.insidersPct) return "insiders au-dessus de 0 %";
  if (holders.bundlerPct >= limit.bundlerPct) return "bundles au-dessus de 0 %";
  if (!(token.authorities?.mintRevoked && token.authorities?.freezeRevoked)) return "mint ou freeze authority";
  const fees = token.quality?.feesSol;
  if (!(fees >= limit.minFeesSol)) return "frais globaux insuffisants";
  return null;
}

/** Why a coin is (not) eligible. Returns null when it qualifies, otherwise a short reason. */
export function hrRejection(token, config) {
  if (["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"].includes(token.id)) return "actif de base";
  if (!(token.price > 0)) return "prix inconnu";
  if (!(Number(token.ageMinutes) <= config.maxAgeMin)) return "trop vieux";
  const mcap = Number(token.marketCap) || 0;
  if (mcap < config.minMcap) return "market cap trop bas";
  if (mcap > config.maxMcap) return "market cap trop haut";
  if ((Number(token.volume24h) || 0) < config.minVolume) return "volume trop bas";
  if (config.requireFilter && !token.quality?.passes) return "filtre Pulse";
  if (config.requireSocials && !(token.socials?.count > 0)) return "aucun réseau social";
  if (config.minHolderGrowthPct > 0) {
    const growth = token.holderStats?.growthPct;
    if (!Number.isFinite(growth)) return "croissance des holders inconnue";
    if (growth < config.minHolderGrowthPct) return `holders +${config.minHolderGrowthPct} % requis`;
  }
  if (config.requireSecurity) return securityProblem(token);
  return null;
}

/** { buys: [{ token, amount }], paused } — newest eligible coins first. `lastEntries` maps tokenId → last High Risk Bot entry time. */
export function pickHrEntries({ coins, positions, history, balance, startBalance, config, lastEntries = {}, now = Date.now() }) {
  const result = { buys: [], paused: null };
  if (!config.enabled) return result;
  if (hrPnlToday(history, now) <= -(startBalance * config.dailyLossPct / 100)) return { ...result, paused: "daily-loss" };
  const held = new Set(positions.map(position => position.tokenId));
  let slots = config.maxOpen - positions.filter(position => position.hr).length;
  let available = balance;
  const cooldown = config.cooldownHours * 3_600_000;
  const eligible = coins.filter(token => !held.has(token.id) && now - (lastEntries[token.id] ?? 0) >= cooldown && !hrRejection(token, config))
    .sort((first, second) => (first.ageMinutes ?? 0) - (second.ageMinutes ?? 0) || (second.volume24h ?? 0) - (first.volume24h ?? 0));
  for (const token of eligible) {
    const amount = config.amount; // fixed ticket: when the balance cannot cover one, the bot stops buying
    if (slots <= 0 || available < amount) break;
    available -= amount; slots -= 1;
    result.buys.push({ token, amount });
  }
  return result;
}
