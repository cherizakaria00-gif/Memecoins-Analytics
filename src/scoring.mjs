const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Produces a transparent 0-100 safety score from observable token metrics.
 * It is deliberately conservative: authority and liquidity failures cap the result.
 */
export function calculateTokenScore(metrics) {
  const liquidity = Number(metrics?.liquidity ?? 0);
  const volume = Number(metrics?.volume ?? 0);
  const holders = Number(metrics?.holders ?? 0);
  const liquidityLocked = Number(metrics?.liquidityLocked ?? 0);
  const top10Concentration = Number(metrics?.top10Concentration ?? 100);
  const ageMinutes = Number(metrics?.ageMinutes ?? 0);

  const components = {
    liquidity: clamp(liquidity / 200_000, 0, 1) * 22,
    activity: clamp(volume / Math.max(liquidity, 1), 0, 1.5) / 1.5 * 12,
    holders: clamp(holders / 2_000, 0, 1) * 14,
    lock: clamp(liquidityLocked / 100, 0, 1) * 18,
    distribution: clamp((60 - top10Concentration) / 45, 0, 1) * 14,
    authorities: (metrics?.mintRevoked ? 8 : 0) + (metrics?.freezeRevoked ? 7 : 0),
    maturity: clamp(ageMinutes / 180, 0, 1) * 5
  };

  let score = Object.values(components).reduce((total, value) => total + value, 0);
  if (!metrics?.mintRevoked) score = Math.min(score, 48);
  if (liquidityLocked < 25) score = Math.min(score, 42);
  if (top10Concentration > 65) score = Math.min(score, 38);

  return Math.round(clamp(score, 0, 100));
}

export function classifyRisk(score) {
  if (score >= 70) return "Faible";
  if (score >= 50) return "Moyen";
  return "Élevé";
}

/**
 * Scores short-term market quality when contract-level security data is absent.
 * This is an opportunity signal, not a safety audit.
 */
export function calculateMarketSignal(metrics) {
  const liquidity = Number(metrics?.liquidity ?? 0);
  const volume = Number(metrics?.volume ?? 0);
  const buys = Number(metrics?.buys ?? 0);
  const sells = Number(metrics?.sells ?? 0);
  const ageMinutes = Number(metrics?.ageMinutes ?? 0);
  const priceChange = Number(metrics?.change ?? 0);
  const transactionCount = buys + sells;
  const buyRatio = transactionCount > 0 ? buys / transactionCount : 0;

  const components = {
    liquidity: clamp(liquidity / 250_000, 0, 1) * 25,
    volume: clamp(volume / Math.max(liquidity, 1), 0, 1.5) / 1.5 * 20,
    transactions: clamp(transactionCount / 250, 0, 1) * 20,
    buyPressure: clamp((buyRatio - 0.35) / 0.35, 0, 1) * 12,
    maturity: clamp(ageMinutes / 90, 0, 1) * 8,
    momentum: priceChange >= 0
      ? clamp(priceChange / 60, 0, 1) * 15
      : clamp(1 + priceChange / 35, 0, 1) * 6
  };

  return Math.round(clamp(Object.values(components).reduce((total, value) => total + value, 0), 0, 100));
}

/**
 * Adjusts a market signal (-12..+12) with pump.fun context: graduation, distance from the
 * all-time high, community replies and socials. It never rescues an illiquid token on its own.
 */
export function calculatePumpAdjustment(pump, marketCap) {
  if (!pump) return 0;
  let adjustment = 0;
  if (pump.graduated) adjustment += 3;
  if (pump.hasSocials) adjustment += 2;
  adjustment += clamp(Number(pump.replyCount ?? 0) / 100, 0, 1) * 3;
  const ath = Number(pump.athMarketCap);
  const cap = Number(marketCap);
  if (ath > 0 && cap > 0) {
    const ratio = Math.min(cap / ath, 1);
    adjustment += ratio >= 0.7 ? 4 : ratio >= 0.35 ? 0 : ratio >= 0.1 ? -6 : -12;
  }
  return Math.round(clamp(adjustment, -12, 12));
}
