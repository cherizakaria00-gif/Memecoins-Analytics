const MIN_CANDLES = 30;
const MIN_VOLATILITY = 0.01;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) result.push(values[index] * k + result[index - 1] * (1 - k));
  return result;
}

/** Wilder average true range in price units. */
export function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const ranges = candles.slice(1).map((candle, index) => Math.max(candle.high - candle.low, Math.abs(candle.high - candles[index].close), Math.abs(candle.low - candles[index].close)));
  let value = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / Math.min(period, ranges.length);
  for (let index = period; index < ranges.length; index += 1) value = (value * (period - 1) + ranges[index]) / period;
  return value;
}

/** Local swing highs/lows: a candle that is the extreme of `k` candles on each side. */
export function pivots(candles, k = 2) {
  const highs = [];
  const lows = [];
  for (let index = k; index < candles.length - k; index += 1) {
    const window = candles.slice(index - k, index + k + 1);
    if (candles[index].high === Math.max(...window.map(candle => candle.high))) highs.push({ index, price: candles[index].high });
    if (candles[index].low === Math.min(...window.map(candle => candle.low))) lows.push({ index, price: candles[index].low });
  }
  return { highs, lows };
}

const average = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

/**
 * Entry / stop / targets from price action: trend (EMA 20 vs 50), distance from the mean in ATRs, nearest swing support
 * and resistance, and volume. The stop sits under the structure, targets are multiples of the risk capped by resistance.
 * It is a heuristic plan, not a prediction: costs (fees + impact) are subtracted before judging the risk/reward.
 */
export function buildTradePlan(candles, { price = null, signal = null, costPct = 0.03 } = {}) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) return { state: "unknown", label: "Pas assez de bougies", notes: ["Moins de 30 bougies sur cet intervalle : choisis un intervalle plus court (1m) ou attends que le coin ait plus d'historique."] };
  const last = candles[candles.length - 1];
  const current = price > 0 ? price : last.close;
  const closes = candles.map(candle => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const mean = ema20[ema20.length - 1];
  const slow = ema50[ema50.length - 1];
  const slope = (mean - ema20[Math.max(0, ema20.length - 6)]) / mean;
  const range = Math.max(atr(candles, 14), current * MIN_VOLATILITY);
  const trendUp = current > slow && mean >= slow * 0.995 && slope >= 0;
  const extension = (current - mean) / range;
  const recent = candles.slice(-120);
  const { highs, lows } = pivots(recent, 2);
  const resistanceCandidates = highs.map(pivot => pivot.price).filter(value => value > current * 1.003);
  const resistance = resistanceCandidates.length ? Math.min(...resistanceCandidates) : null;
  const supportCandidates = lows.map(pivot => pivot.price).filter(value => value < current * 0.997);
  const support = supportCandidates.length ? Math.max(...supportCandidates) : Math.min(...candles.slice(-24).map(candle => candle.low));
  const volumes = candles.map(candle => candle.volume ?? 0);
  const volumeRising = average(volumes.slice(-5)) > 1.1 * average(volumes.slice(-25, -5));

  const base = { atrPct: range / current, support, resistance, mean, extension, trendUp, volumeRising };
  const avoid = (label, notes) => ({ ...base, state: "avoid", label, notes });

  if (signal?.grade === "avoid") return avoid("Éviter : filtres de sécurité", [signal.flags?.[0] ?? "Le signal est rejeté par les filtres."]);
  if (!trendUp && current < mean) return avoid("Éviter : tendance baissière", ["Le prix est sous sa moyenne mobile et la pente est négative : n'achète pas un couteau qui tombe."]);

  let state;
  let label;
  let entry;
  let low;
  let high;
  const notes = [];
  if (extension > 2.5) {
    state = "wait"; label = "Attendre un repli";
    low = mean - 0.3 * range; high = mean + 0.6 * range; entry = (low + high) / 2;
    notes.push(`Prix étendu : ${extension.toFixed(1)} ATR au-dessus de sa moyenne, risque d'acheter un sommet. Place un ordre limite dans la zone.`);
  } else if (resistance && resistance - current < 0.6 * range && volumeRising) {
    state = "breakout"; label = "Cassure à surveiller";
    entry = resistance * 1.004; low = resistance; high = resistance + 0.3 * range;
    notes.push("Le prix est sous une résistance avec un volume en hausse : n'entre qu'après une clôture au-dessus.");
  } else if (extension <= 1.2) {
    state = "buy"; label = "Bon point d'entrée";
    entry = current; low = current - 0.3 * range; high = current + 0.2 * range;
    notes.push("Prix proche de sa moyenne dans une tendance haussière : entrée à faible risque.");
  } else {
    state = "wait"; label = "Attendre un léger repli";
    low = mean; high = mean + 0.8 * range; entry = (low + high) / 2;
    notes.push("Tendance haussière mais prix un peu loin de sa moyenne : un repli dans la zone améliore le ratio gain/risque.");
  }

  let stop = Math.min(support - 0.3 * range, entry - 1.2 * range);
  let stopPct = (entry - stop) / entry;
  if (stopPct < 0.05) { stop = entry * 0.95; stopPct = 0.05; }
  if (stopPct > 0.35) return avoid("Pas de bon point d'entrée", [`Le stop logique serait à −${Math.round(stopPct * 100)} % : risque trop grand pour un gain réaliste.`]);

  const risk = entry - stop;
  let tp1 = entry + 1.5 * risk;
  if (resistance && resistance > entry + 0.8 * risk && resistance < tp1) tp1 = resistance * 0.995;
  const tp2 = Math.max(entry + 3 * risk, tp1 * 1.05);
  const grossRr = (tp1 - entry) / risk;
  const netRr = ((tp1 - entry) / entry - costPct) / (stopPct + costPct);
  if (netRr < 1) return avoid("Pas de bon point d'entrée", [`Ratio gain/risque net de frais trop faible (${netRr.toFixed(2)}) : la cible 1 est trop proche du stop.`]);

  notes.push("Après la cible 1 : vends la moitié, remonte le stop à l'entrée, puis suis la moyenne 20 (sors sur clôture dessous).");
  return {
    ...base, state, label, notes,
    entry: { price: entry, low, high },
    stop: { price: stop, pct: stopPct },
    targets: [{ price: tp1, pct: tp1 / entry - 1, rr: grossRr }, { price: tp2, pct: tp2 / entry - 1, rr: (tp2 - entry) / risk }],
    netRr, costPct
  };
}

/** What to do with an open position given the plan and the latest price. */
export function exitAdvice(plan, position, price) {
  if (!plan?.stop || !position || !(price > 0)) return null;
  const grossPct = price / position.spotEntry - 1;
  const [tp1, tp2] = plan.targets;
  const entry = position.spotEntry;
  if (price <= Math.min(plan.stop.price, entry * (1 - plan.stop.pct))) return { action: "exit", text: "Stop du plan atteint : sors pour limiter la perte." };
  if (tp2 && price >= tp2.price) return { action: "take-profit", text: "Cible 2 atteinte : prends l'essentiel des gains et suis la moyenne 20 pour le reste." };
  if (tp1 && price >= tp1.price) return { action: "partial", text: "Cible 1 atteinte : vends 50 % et remonte le stop à ton prix d'entrée.", stop: entry };
  if (price < plan.mean && !plan.trendUp && grossPct > 0.02) return { action: "secure", text: "Le momentum faiblit (prix sous la moyenne 20) : sécurise une partie du gain." };
  return { action: "hold", text: grossPct >= 0 ? "Tiens la position : le plan est intact." : "Position sous l'entrée mais au-dessus du stop : respecte le stop." };
}

export const planPercents = plan => (plan?.stop && plan.targets
  ? { stopLossPct: Math.round((plan.stop.pct + plan.costPct) * 100), takeProfitPct: Math.max(1, Math.round((plan.targets[0].pct - plan.costPct) * 100)) }
  : null);
