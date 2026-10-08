import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../src/db.mjs";
import { BANDS, FEATURE_NAMES, HORIZON_MS, STOP_PCT, WIN_PCT, auc, createAiAgent, extractFeatures, fitAndValidate, predict, reasons, trainLogistic } from "../src/ai-agent.mjs";

const token = (id, extra = {}) => ({ id, price: 1, liquidity: 20_000, marketCap: 50_000, volume24h: 30_000, volume: 5_000, volume5m: 600, ageMinutes: 30, buys: 60, sells: 40, buys5m: 8, sells5m: 3, change5m: 2, change: 10, change6h: 20, ...extra });

// deterministic pseudo random numbers
const random = (seed => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; })(42);

test("features: fixed length, finite, missing data neutral", () => {
  const features = extractFeatures(token("A"));
  assert.equal(features.length, FEATURE_NAMES.length);
  assert.ok(features.every(Number.isFinite));
  const bare = extractFeatures({ id: "B", price: 1 });
  assert.ok(bare.every(Number.isFinite));
  assert.equal(extractFeatures(token("C", { holderStats: { reliable: true, totalHolders: 500, top10Pct: 20, devPct: 0, sniperPct: 0, insidersPct: 0, bundlerPct: 0 } }))[FEATURE_NAMES.indexOf("hasHolders")], 1);
});

test("auc: perfect, random and inverted rankings", () => {
  assert.equal(auc([0.9, 0.8, 0.2, 0.1], [true, true, false, false]), 1);
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [true, true, false, false]), 0);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [true, false, true, false]), 0.5);
  assert.equal(auc([0.5], [true]), null);
});

function planted(count, offset = 0) {
  // winners tend to have strong holder growth and low sniper share; losers the opposite; the rest is noise
  return Array.from({ length: count }, (_, index) => {
    const win = random() < 0.3;
    const growth = win ? 40 + random() * 80 : -10 + random() * 40;
    const snipers = win ? random() * 3 : 4 + random() * 30;
    const t = token(`P${offset + index}`, { ageMinutes: random() * 120, marketCap: 10_000 + random() * 200_000, holderStats: { reliable: true, totalHolders: 50 + random() * 400, top10Pct: 10 + random() * 40, devPct: random() * 5, sniperPct: snipers, insidersPct: random() * 20, bundlerPct: random() * 10, growthPct: growth } });
    return { takenAt: offset + index, win, features: extractFeatures(t) };
  });
}

test("the model learns a planted pattern and validates it on unseen, newer samples", () => {
  const samples = planted(600);
  const { model, metrics } = fitAndValidate(samples);
  assert.ok(metrics.auc > 0.85, `auc ${metrics.auc}`);
  assert.equal(metrics.ready, true);
  assert.ok(metrics.lift > 1.5);
  const winner = token("W", { holderStats: { reliable: true, totalHolders: 300, top10Pct: 15, devPct: 0, sniperPct: 0, insidersPct: 1, bundlerPct: 0, growthPct: 90 } });
  const loser = token("L", { holderStats: { reliable: true, totalHolders: 300, top10Pct: 15, devPct: 0, sniperPct: 25, insidersPct: 1, bundlerPct: 0, growthPct: 0 } });
  const good = predict(model, extractFeatures(winner)), bad = predict(model, extractFeatures(loser));
  assert.ok(good.p > 0.5 && bad.p < 0.2 && good.p > bad.p);
  assert.ok(reasons(good.contributions).pros.some(label => /holders|snipers/.test(label)));
});

test("pure noise is not declared ready", () => {
  const noise = Array.from({ length: 500 }, (_, index) => ({ takenAt: index, win: random() < 0.3, features: extractFeatures(token(`N${index}`, { ageMinutes: random() * 100, marketCap: 10_000 + random() * 90_000, change: random() * 40 - 20 })) }));
  const { metrics } = fitAndValidate(noise);
  assert.ok(metrics.auc < 0.7);
  assert.equal(metrics.ready && metrics.auc >= 0.55 && metrics.lift > 3, false);
});

test("the agent snapshots coins once per interval, labels win / loss / timeout and drops vanished coins", () => {
  const store = openStore(":memory:");
  const agent = createAiAgent({ store });
  const T0 = 1_000_000;
  agent.observe([token("WIN"), token("LOSE"), token("SLOW"), token("GONE"), token("TINY", { liquidity: 100 })], { at: T0 });
  assert.equal(store.aiCounts().open, 4);
  agent.observe([token("WIN"), token("LOSE")], { at: T0 + 60_000 });
  assert.equal(store.aiCounts().open, 4, "no second snapshot inside the interval");
  agent.observe([token("WIN", { price: 1 + WIN_PCT / 100 + 0.01 }), token("LOSE", { price: 1 - STOP_PCT / 100 - 0.01 }), token("SLOW", { price: 1.05 })], { at: T0 + 5 * 60_000 });
  assert.deepEqual([store.aiCounts().win, store.aiCounts().loss, store.aiCounts().open], [1, 1, 2]);
  agent.observe([token("SLOW", { price: 1.05 })], { at: T0 + HORIZON_MS + 1000 });
  assert.equal(store.aiCounts().loss, 2, "no win inside the horizon is a loss");
  assert.equal(store.aiCounts().lost, 1, "a coin that left the feed for 30 minutes has an unknown outcome and is not used for training");
  assert.equal(store.aiCounts().open, 1, "only the new snapshot of SLOW is still open");
});

test("end to end: collects, trains once enough outcomes exist, scores new coins and persists the model", () => {
  const store = openStore(":memory:");
  const agent = createAiAgent({ store });
  let at = 10_000_000;
  const mk = (id, win) => token(id, { holderStats: { reliable: true, totalHolders: 100 + random() * 300, top10Pct: 10 + random() * 30, devPct: 0, sniperPct: win ? random() * 2 : 5 + random() * 25, insidersPct: random() * 10, bundlerPct: random() * 5, growthPct: win ? 40 + random() * 60 : random() * 25 }, marketCap: 20_000 + random() * 100_000 });
  for (let round = 0; round < 40; round++) {
    const batch = Array.from({ length: 12 }, (_, index) => { const win = random() < 0.35; const t = mk(`R${round}-${index}`, win); t.__win = win; return t; });
    agent.observe(batch, { at });
    at += 31 * 60_000; // a new snapshot window opens each round, so prices must move to resolve the old ones
    agent.observe(batch.map(item => ({ ...item, price: item.__win ? 1.3 : 0.8 })), { at });
  }
  const status = agent.status();
  assert.ok(status.samples.win + status.samples.loss >= 150, JSON.stringify(status.samples));
  assert.equal(status.ready, true, JSON.stringify(status.model));
  const probe = [mk("PROBE-WIN", true), mk("PROBE-LOSE", false)];
  agent.annotate(probe);
  assert.ok(probe[0].ai.ready && probe[0].ai.p > probe[1].ai.p);
  assert.ok(Array.isArray(probe[0].ai.pros));
  const reopened = createAiAgent({ store });
  assert.equal(reopened.ready, true);
  const notReady = createAiAgent({ store: openStore(":memory:") });
  const fresh = [token("X")];
  notReady.annotate(fresh);
  assert.deepEqual(fresh[0].ai, { ready: false, p: null });
});

test("the status counts known outcomes per market-cap band", () => {
  const store = openStore(":memory:");
  const agent = createAiAgent({ store });
  const T0 = 20_000_000;
  const batch = [token("S1", { marketCap: 60_000 }), token("M1", { marketCap: 1_000_000 }), token("M2", { marketCap: 1_400_000 }), token("L1", { marketCap: 4_000_000 })];
  agent.observe(batch, { at: T0 });
  agent.observe(batch.map((item, index) => ({ ...item, price: index === 1 || index === 3 ? 1.3 : 0.8 })), { at: T0 + 5 * 60_000 });
  const bands = Object.fromEntries(agent.status().bands.map(band => [band.id, [band.win, band.loss]]));
  assert.deepEqual([bands.micro, bands.mid, bands.large, bands.huge], [[0, 1], [1, 1], [1, 0], [0, 0]]);
  assert.equal(BANDS.length, 5);
});
