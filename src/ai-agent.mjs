/**
 * AI Agent: learns from the coins Pulse has already seen.
 *  1. every few minutes it snapshots each coin (age, market cap, liquidity, volume, buy pressure, holder security, holder growth, socials, scores…),
 *  2. it follows the price afterwards and labels the snapshot WIN (price +WIN_PCT % before −STOP_PCT %, within HORIZON) or LOSS,
 *  3. it trains a logistic regression on the labeled snapshots and, once validated on the most recent ones it did not train on,
 *     gives every new coin a probability of winning plus the reasons.
 * It only says "this coin looks like the past winners": past patterns can stop working, so a probability is never a guarantee.
 */
export const WIN_PCT = 20;
export const STOP_PCT = 12;
export const HORIZON_MS = 2 * 3_600_000;
export const MIN_LABELED = 150;
export const MIN_PER_CLASS = 20;
const SNAPSHOT_EVERY_MS = 30 * 60_000;
const MAX_SNAPSHOTS_PER_TICK = 120;
const MIN_LIQUIDITY = 3000;
const VANISHED_MS = 30 * 60_000;
const RETRAIN_EVERY = 25;
const KEEP_LABELED = 30_000;
const BASE_ASSETS = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const clip = (value, low, high) => Math.min(Math.max(value, low), high);
const logp = value => Math.log1p(Math.max(num(value), 0));
const slog = value => Math.sign(num(value)) * Math.log1p(Math.abs(num(value)));

/** Feature name → [label shown to the user, extractor]. Everything here is known at the moment the coin is first seen. */
export const FEATURES = {
  age: ["âge", t => logp(t.ageMinutes)],
  mcap: ["market cap", t => logp(t.marketCap)],
  liquidity: ["liquidité", t => logp(t.liquidity)],
  volume24h: ["volume 24 h", t => logp(t.volume24h)],
  volume1h: ["volume 1 h", t => logp(t.volume)],
  turnover: ["rotation du volume", t => clip(num(t.volume) / Math.max(num(t.liquidity), 1), 0, 30)],
  mcapLiquidity: ["market cap / liquidité", t => logp(clip(num(t.marketCap) / Math.max(num(t.liquidity), 1), 0, 300))],
  change5m: ["variation 5 min", t => slog(clip(num(t.change5m), -90, 500))],
  change1h: ["variation 1 h", t => slog(clip(num(t.change), -90, 2000))],
  change6h: ["variation 6 h", t => slog(clip(num(t.change6h), -90, 5000))],
  buyRatio1h: ["achats vs ventes (1 h)", t => (num(t.buys) + num(t.sells) >= 5 ? num(t.buys) / (num(t.buys) + num(t.sells)) : 0.5)],
  buyRatio5m: ["achats vs ventes (5 min)", t => (num(t.buys5m) + num(t.sells5m) >= 3 ? num(t.buys5m) / (num(t.buys5m) + num(t.sells5m)) : 0.5)],
  acceleration: ["accélération du volume", t => clip((num(t.volume5m) * 12) / Math.max(num(t.volume), 1), 0, 10)],
  transactions: ["transactions", t => logp(num(t.buys) + num(t.sells))],
  athRatio: ["proximité de l'ATH", t => (num(t.athMarketCap) > 0 ? clip(num(t.marketCap) / num(t.athMarketCap), 0, 1) : 0.5)],
  signalScore: ["score du signal", t => num(t.signal?.score ?? t.score) / 100],
  sniperScore: ["Sniper Score", t => num(t.sniper?.score) / 100],
  earlyScore: ["score de démarrage", t => num(t.early?.score) / 100],
  hasHolders: ["données holders", t => (t.holderStats?.reliable ? 1 : 0)],
  holders: ["nombre de holders", t => (t.holderStats?.reliable ? logp(t.holderStats.totalHolders) : 0)],
  top10: ["concentration top 10", t => (t.holderStats?.reliable ? clip(num(t.holderStats.top10Pct), 0, 100) / 100 : 0)],
  dev: ["dev holding", t => (t.holderStats?.reliable ? clip(num(t.holderStats.devPct), 0, 100) / 100 : 0)],
  snipers: ["snipers", t => (t.holderStats?.reliable ? clip(num(t.holderStats.sniperPct), 0, 100) / 100 : 0)],
  insiders: ["insiders", t => (t.holderStats?.reliable ? clip(num(t.holderStats.insidersPct), 0, 100) / 100 : 0)],
  bundlers: ["bundles", t => (t.holderStats?.reliable ? clip(num(t.holderStats.bundlerPct), 0, 100) / 100 : 0)],
  holderGrowth: ["croissance des holders", t => slog(clip(num(t.holderStats?.growthPct), -90, 500))],
  socials: ["réseaux sociaux", t => num(t.socials?.count)],
  website: ["site web", t => (t.socials?.website ? 1 : 0)],
  organic: ["Organic Score", t => (t.jup?.organicScore != null ? num(t.jup.organicScore) / 100 : 0)],
  rugDanger: ["alerte RugCheck", t => (t.rug?.danger?.length ? 1 : 0)],
  fees: ["frais globaux payés", t => logp(t.quality?.feesSol)],
  pump: ["coin pump.fun", t => (t.pump ? 1 : 0)],
  graduated: ["gradué (migré)", t => (t.pump?.graduated ? 1 : 0)],
  unlisted: ["pas encore sur DexScreener", t => (t.synthetic ? 1 : 0)]
};
export const FEATURE_NAMES = Object.keys(FEATURES);

export function extractFeatures(token) {
  return FEATURE_NAMES.map(name => { const value = FEATURES[name][1](token); return Number.isFinite(value) ? value : 0; });
}

const sigmoid = value => 1 / (1 + Math.exp(-clip(value, -30, 30)));

/** Area under the ROC curve (probability that a random winner is scored above a random loser). */
export function auc(scores, labels) {
  const positives = labels.filter(Boolean).length, negatives = labels.length - positives;
  if (!positives || !negatives) return null;
  const order = scores.map((score, index) => [score, labels[index]]).sort((first, second) => first[0] - second[0]);
  let rankSum = 0;
  for (let index = 0; index < order.length;) {
    let end = index;
    while (end + 1 < order.length && order[end + 1][0] === order[index][0]) end++;
    const rank = (index + end) / 2 + 1;
    for (let k = index; k <= end; k++) if (order[k][1]) rankSum += rank;
    index = end + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Class-balanced, L2-regularised logistic regression on standardised features. Returns a plain JSON model. */
export function trainLogistic(rows, labels, { epochs = 500, rate = 0.3, l2 = 0.02 } = {}) {
  const n = rows.length, d = rows[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(1);
  for (const row of rows) row.forEach((value, index) => { mean[index] += value / n; });
  const variance = Array(d).fill(0);
  for (const row of rows) row.forEach((value, index) => { variance[index] += (value - mean[index]) ** 2 / n; });
  variance.forEach((value, index) => { std[index] = Math.sqrt(value) || 1; });
  const standard = rows.map(row => row.map((value, index) => (value - mean[index]) / std[index]));
  const positives = labels.filter(Boolean).length, negatives = n - positives;
  const weightPositive = n / (2 * positives), weightNegative = n / (2 * negatives);
  let weights = Array(d).fill(0), bias = 0;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = Array(d).fill(0);
    let gradientBias = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let k = 0; k < d; k++) z += weights[k] * standard[i][k];
      const error = (sigmoid(z) - (labels[i] ? 1 : 0)) * (labels[i] ? weightPositive : weightNegative) / n;
      for (let k = 0; k < d; k++) gradient[k] += error * standard[i][k];
      gradientBias += error;
    }
    const step = rate / (1 + epoch / 200);
    weights = weights.map((weight, k) => weight - step * (gradient[k] + l2 * weight));
    bias -= step * gradientBias;
  }
  return { names: FEATURE_NAMES, mean, std, weights, bias, prior: Math.log(positives / negatives) };
}

/** Probability of winning plus the features that pushed it up or down. */
export function predict(model, features) {
  const contributions = [];
  let z = model.bias;
  for (let k = 0; k < model.weights.length; k++) {
    const standardised = (features[k] - model.mean[k]) / model.std[k];
    z += model.weights[k] * standardised;
    contributions.push({ name: model.names[k], value: model.weights[k] * standardised });
  }
  return { p: sigmoid(z + model.prior), contributions };
}

export function reasons(contributions, { up = 3, down = 1 } = {}) {
  const sorted = [...contributions].sort((first, second) => second.value - first.value);
  const label = name => FEATURES[name]?.[0] ?? name;
  return {
    pros: sorted.filter(item => item.value > 0.05).slice(0, up).map(item => label(item.name)),
    cons: sorted.reverse().filter(item => item.value < -0.05).slice(0, down).map(item => label(item.name))
  };
}

/** Train on the oldest 75 % of the labeled snapshots, measure on the newest 25 %, then refit on everything. */
export function fitAndValidate(samples) {
  const ordered = [...samples].sort((first, second) => first.takenAt - second.takenAt);
  const split = Math.floor(ordered.length * 0.75);
  const trainSet = ordered.slice(0, split), testSet = ordered.slice(split);
  const metrics = { n: ordered.length, wins: ordered.filter(item => item.win).length, baseRate: ordered.filter(item => item.win).length / ordered.length, holdoutN: testSet.length, holdoutWins: testSet.filter(item => item.win).length, auc: null, lift: null };
  if (trainSet.filter(item => item.win).length >= 5 && trainSet.some(item => !item.win) && testSet.length) {
    const check = trainLogistic(trainSet.map(item => item.features), trainSet.map(item => item.win));
    const scores = testSet.map(item => predict(check, item.features).p);
    metrics.auc = auc(scores, testSet.map(item => item.win));
    const top = scores.map((score, index) => [score, testSet[index].win]).sort((first, second) => second[0] - first[0]).slice(0, Math.max(Math.ceil(testSet.length * 0.2), 5));
    const topRate = top.filter(item => item[1]).length / top.length;
    const holdoutBase = metrics.holdoutWins / testSet.length;
    metrics.topRate = topRate;
    metrics.lift = holdoutBase > 0 ? topRate / holdoutBase : null;
  }
  const model = trainLogistic(ordered.map(item => item.features), ordered.map(item => item.win));
  const ready = metrics.auc != null && metrics.auc >= 0.55 && metrics.holdoutN >= 40 && metrics.holdoutWins >= 8;
  return { model, metrics: { ...metrics, ready } };
}

/** Market-cap bands the page can focus on. */
export const BANDS = [
  { id: "micro", label: "< 100K", min: 0, max: 100_000 },
  { id: "small", label: "100K – 500K", min: 100_000, max: 500_000 },
  { id: "mid", label: "500K – 2M (zone 1M)", min: 500_000, max: 2_000_000 },
  { id: "large", label: "2M – 10M", min: 2_000_000, max: 10_000_000 },
  { id: "huge", label: "> 10M", min: 10_000_000, max: Infinity }
];

export function createAiAgent({ store, now = () => Date.now() } = {}) {
  let model = null, metrics = null, trainedAt = null, lastTick = 0, labeledSinceTrain = 0, picksCache = [];
  const lastSnapshot = new Map();

  const saved = store.aiLoadModel?.();
  if (saved) { try { ({ model, metrics } = JSON.parse(saved.json)); trainedAt = saved.trained_at; } catch { model = null; } }

  function train() {
    const rows = store.aiLabeled(KEEP_LABELED).map(row => ({ takenAt: row.taken_at, win: row.status === "win", features: JSON.parse(row.features) })).filter(row => row.features.length === FEATURE_NAMES.length);
    const wins = rows.filter(row => row.win).length;
    if (rows.length < MIN_LABELED || wins < MIN_PER_CLASS || rows.length - wins < MIN_PER_CLASS) return null;
    const result = fitAndValidate(rows);
    model = result.model; metrics = result.metrics; trainedAt = now(); labeledSinceTrain = 0;
    store.aiSaveModel(JSON.stringify({ model, metrics }), trainedAt);
    return metrics;
  }

  /** Called with each fresh market snapshot (scanner list, new coins). Records snapshots, follows prices, labels outcomes, retrains. */
  function observe(tokens, { at = now() } = {}) {
    const byMint = new Map();
    for (const token of tokens) if (token?.id && token.price > 0) byMint.set(token.id, token);
    // 1. follow open snapshots
    let resolved = 0;
    for (const sample of store.aiOpen()) {
      const token = byMint.get(sample.mint);
      const up = sample.entry_price * (1 + WIN_PCT / 100), down = sample.entry_price * (1 - STOP_PCT / 100);
      if (token) {
        const price = token.price;
        const max = Math.max(sample.max_price, price), min = Math.min(sample.min_price, price);
        let status = null;
        if (price >= up) status = "win"; else if (price <= down) status = "loss";
        else if (at - sample.taken_at >= HORIZON_MS) status = "loss"; // no win inside the horizon
        if (status) { store.aiResolve(sample.id, status, at, price / sample.entry_price - 1, max, min); resolved++; }
        else store.aiTouch(sample.id, max, min, at);
      } else if (at - sample.last_seen >= VANISHED_MS) store.aiResolve(sample.id, "lost", at, null, sample.max_price, sample.min_price); // outcome unknown: kept out of the training data
    }
    labeledSinceTrain += resolved;
    // 2. snapshot coins we have not captured recently
    let taken = 0;
    for (const token of tokens) {
      if (taken >= MAX_SNAPSHOTS_PER_TICK) break;
      if (!(token?.price > 0) || BASE_ASSETS.has(token.id) || !(num(token.liquidity) >= MIN_LIQUIDITY)) continue;
      if (at - (lastSnapshot.get(token.id) ?? -Infinity) < SNAPSHOT_EVERY_MS) continue;
      lastSnapshot.set(token.id, at);
      store.aiAdd({ mint: token.id, takenAt: at, source: token.synthetic ? "new" : "scan", features: JSON.stringify(extractFeatures(token)), price: token.price });
      taken++;
    }
    if (lastSnapshot.size > 5000) for (const [mint, time] of lastSnapshot) if (at - time > SNAPSHOT_EVERY_MS) lastSnapshot.delete(mint);
    // 3. retrain when enough new outcomes arrived
    if (labeledSinceTrain >= RETRAIN_EVERY || (!model && labeledSinceTrain > 0)) { try { train(); } catch (error) { console.warn("AI training failed:", error.message); } }
    if (resolved && Math.random() < 0.01) store.aiPrune(KEEP_LABELED);
    lastTick = at;
    return { taken, resolved };
  }

  /** Adds token.ai = { ready, p, pros, cons } to each token (p is null until the model is validated). */
  function annotate(tokens) {
    const ready = Boolean(model && metrics?.ready);
    const scored = [];
    for (const token of tokens) {
      if (!ready || !(token?.price > 0)) { token.ai = { ready, p: null }; continue; }
      const { p, contributions } = predict(model, extractFeatures(token));
      const why = reasons(contributions);
      token.ai = { ready: true, p: Math.round(p * 1000) / 1000, pros: why.pros, cons: why.cons };
      if (!BASE_ASSETS.has(token.id)) scored.push(token);
    }
    return scored;
  }

  let bandCache = { at: 0, value: [] };
  /** Known outcomes per market-cap band, from the stored snapshots: shows how many coins of each size the agent has actually learned from. */
  function bandStats() {
    if (now() - bandCache.at < 60_000) return bandCache.value;
    const index = FEATURE_NAMES.indexOf("mcap");
    const stats = BANDS.map(band => ({ ...band, max: Number.isFinite(band.max) ? band.max : null, win: 0, loss: 0 }));
    for (const row of store.aiLabeled(KEEP_LABELED)) {
      let features;
      try { features = JSON.parse(row.features); } catch { continue; }
      const mcap = Math.expm1(features[index] ?? 0);
      const band = BANDS.findIndex(item => mcap >= item.min && mcap < item.max);
      if (band >= 0) stats[band][row.status === "win" ? "win" : "loss"]++;
    }
    bandCache = { at: now(), value: stats };
    return stats;
  }

  function status() {
    const counts = store.aiCounts();
    const importance = model ? model.names.map((name, index) => ({ name, label: FEATURES[name]?.[0] ?? name, weight: Math.round(model.weights[index] * 1000) / 1000 })).sort((first, second) => Math.abs(second.weight) - Math.abs(first.weight)).slice(0, 12) : [];
    return {
      definition: { winPct: WIN_PCT, stopPct: STOP_PCT, horizonMin: HORIZON_MS / 60_000, minLabeled: MIN_LABELED, minPerClass: MIN_PER_CLASS },
      samples: counts, bands: bandStats(), model: metrics ? { ...metrics, trainedAt } : null, ready: Boolean(model && metrics?.ready), importance, lastTick
    };
  }

  return { observe, annotate, train, status, get ready() { return Boolean(model && metrics?.ready); }, get model() { return model; } };
}
