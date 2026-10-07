const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Safety flags (from the entry signal) that disqualify a start whatever its momentum. */
const BLOCKING_FLAGS = new Set(["low-liquidity", "sell-pressure", "dumping", "thin-vs-mcap", "big-orders", "turnover", "concentrated", "insiders", "below-minimums", "rugcheck", "one-sided-buys", "few-txns", "authority"]);

export const EARLY_MIN_SCORE = 60;

/**
 * Detects the first leg of a move: price up roughly +8..+80 % over 1 h and still rising now, volume and buying
 * accelerating, in a liquid, not-yet-extended token. This is the profile of coins that go on to run, but most starts
 * fizzle out: the signal tracker measures how many reach +50 / +100 / +200 % so the thresholds can be tuned.
 */
export function evaluateEarly(token, signal = token.signal) {
  const liquidity = num(token.liquidity);
  const ageMinutes = num(token.ageMinutes);
  const vol5m = num(token.volume5m);
  const vol1h = num(token.volume);
  const vol6h = num(token.volume6h);
  const buys1h = num(token.buys);
  const sells1h = num(token.sells);
  const buys5m = num(token.buys5m);
  const sells5m = num(token.sells5m);
  const change5m = num(token.change5m);
  const change1h = num(token.change);
  const change6h = num(token.change6h);
  const change24h = num(token.change24h);
  const txns5m = buys5m + sells5m;
  const txns1h = buys1h + sells1h;
  const buyRatio1h = txns1h > 0 ? buys1h / txns1h : 0;
  const buyRatio5m = txns5m > 0 ? buys5m / txns5m : 0;
  const acceleration = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
  const previousHourAvg = vol6h > vol1h ? (vol6h - vol1h) / 5 : 0;
  const hourVsPrevious = previousHourAvg > 0 ? vol1h / previousHourAvg : vol1h > 0 ? 5 : 0;
  const athRatio = token.athMarketCap > 0 && token.marketCap > 0 ? Math.min(token.marketCap / token.athMarketCap, 1) : null;
  const blocked = (signal?.flagCodes ?? []).filter(code => BLOCKING_FLAGS.has(code));

  const gates = {
    liquidity: liquidity >= 15_000,
    age: ageMinutes >= 20 && ageMinutes <= 72 * 60,
    start: change1h >= 8 && change1h <= 80,
    stillRising: change5m >= 0.5 && change5m <= 30,
    notExtended: change6h <= 200 && change24h <= 800,
    buyers: txns5m >= 10 && buyRatio1h >= 0.55 && buyRatio5m >= 0.55,
    volume: acceleration >= 1.3,
    safe: blocked.length === 0
  };
  const passed = Object.values(gates).every(Boolean);

  const reasons = [];
  const add = (points, text) => { if (points > 0) reasons.push(text); return points; };
  let score = 0;
  score += add(clamp(1 - Math.abs(change1h - 25) / 55, 0, 1) * 20, `+${Math.round(change1h)} % sur 1 h : début de mouvement`);
  score += add(clamp((acceleration - 1) / 2, 0, 1) * 20, `Volume ×${acceleration.toFixed(1)} vs la moyenne horaire`);
  score += add(clamp((hourVsPrevious - 1) / 3, 0, 1) * 10, `Heure ×${hourVsPrevious.toFixed(1)} vs les heures précédentes`);
  score += add(clamp((buyRatio5m - 0.5) / 0.3, 0, 1) * 15, `${Math.round(buyRatio5m * 100)} % d'achats sur 5 min`);
  score += add(clamp(txns5m / 40, 0, 1) * 10, `${txns5m} transactions en 5 min`);
  score += add(athRatio == null ? 0 : clamp((athRatio - 0.6) / 0.35, 0, 1) * 10, "Proche de son ATH");
  score += add(clamp(Math.log10(Math.max(liquidity, 1) / 15_000) / 1.2, 0, 1) * 8, "Liquidité suffisante pour sortir");
  const holders = token.holderStats?.reliable ? token.holderStats : null;
  score += add(holders && holders.top10Pct < 30 && holders.totalHolders >= 300 ? 5 : 0, "Supply bien répartie");
  if (token.pump?.graduated) score += add(2, "Gradué de pump.fun");
  score = Math.round(clamp(score, 0, 100));

  return {
    early: passed && score >= EARLY_MIN_SCORE,
    candidate: Object.entries(gates).filter(([, ok]) => !ok).length <= 1 && gates.safe,
    score, reasons,
    stage: change1h < 20 ? "démarrage précoce" : "accélération",
    acceleration, hourVsPrevious,
    missing: Object.entries(gates).filter(([, ok]) => !ok).map(([name]) => name)
  };
}
