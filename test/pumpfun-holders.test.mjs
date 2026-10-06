import test from "node:test";
import assert from "node:assert/strict";
import { fetchHolderStats, summarizeHolders } from "../src/pumpfun-client.mjs";
import { evaluateSignal } from "../src/signal.mjs";

const holder = (percent, flags = {}) => ({ address: `h${percent}${Object.keys(flags)}`, amount: percent / 100 * 1_000_000_000, isDev: false, isSniper: false, isBundler: false, ...flags });

test("summarizes concentration and insiders, ignoring pool-like holders", () => {
  const stats = summarizeHolders({ totalHolders: 900, topHolders: [holder(70), holder(8), holder(5, { isSniper: true }), holder(4, { isBundler: true }), holder(3, { isDev: true }), holder(2)] });
  assert.equal(Math.round(stats.top10Pct), 22);
  assert.equal(stats.sniperPct, 5);
  assert.equal(stats.bundlerPct, 4);
  assert.equal(stats.devPct, 3);
  assert.equal(stats.insidersPct, 12);
  assert.equal(stats.sniperCount, 1);
  assert.equal(stats.reliable, true);
});

test("a token still on its bonding curve (one holder) is not reliable", () => {
  assert.equal(summarizeHolders({ totalHolders: 1, topHolders: [holder(97)] }).reliable, false);
  assert.equal(summarizeHolders(null).reliable, false);
});

test("fetches and caches holder stats", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ totalHolders: 800, topHolders: [holder(2), holder(1)] }) }; };
  assert.equal((await fetchHolderStats("mintpump", { fetchImpl, now: 1 })).totalHolders, 800);
  await fetchHolderStats("mintpump", { fetchImpl, now: 2 });
  assert.equal(calls, 1);
  assert.equal(await fetchHolderStats("other", { fetchImpl: async () => ({ ok: false }), now: 1 }), null);
});

test("concentration and insiders turn a tradable setup into an avoid", () => {
  const base = { liquidity: 150_000, marketCap: 1_200_000, athMarketCap: 1_400_000, ageMinutes: 240, volume5m: 9_000, volume: 90_000, volume6h: 300_000, volume24h: 700_000, buys: 300, sells: 160, buys5m: 30, sells5m: 12, change5m: 3, change: 30, change6h: 80, change24h: 150 };
  assert.equal(evaluateSignal(base).tradable, true);
  const concentrated = evaluateSignal({ ...base, holderStats: { reliable: true, top10Pct: 72, devPct: 0, sniperPct: 0, bundlerPct: 0, totalHolders: 900 } });
  assert.equal(concentrated.grade, "avoid");
  const insiders = evaluateSignal({ ...base, holderStats: { reliable: true, top10Pct: 20, devPct: 5, sniperPct: 12, bundlerPct: 12, totalHolders: 900 } });
  assert.ok(insiders.flagCodes.includes("insiders"));
  const spread = evaluateSignal({ ...base, holderStats: { reliable: true, top10Pct: 12, devPct: 0, sniperPct: 0, bundlerPct: 0, totalHolders: 2000 } });
  assert.ok(spread.reasons.includes("Supply bien répartie"));
});
