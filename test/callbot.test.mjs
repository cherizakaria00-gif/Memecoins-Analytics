import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CALL, callPnlToday, callRejection, callStats, callStopReason, entryStopPct, normalizeCall, pickCallEntries } from "../dist/callbot.js";

const NOW = new Date(2026, 9, 8, 15, 0, 0).getTime();
const call = (id, extra = {}, tokenExtra = {}) => ({ id, kind: "call", at: NOW - 60_000, priceAtCall: 1, token: { id: `T${id}`, price: 1.02, liquidity: 30_000, ...tokenExtra }, ...extra });
const config = { ...DEFAULT_CALL, enabled: true };
const run = (overrides = {}) => pickCallEntries({ calls: [], positions: [], history: [], balance: 10_000, startBalance: 10_000, config, now: NOW, ...overrides });

test("defaults and clamping", () => {
  assert.equal(DEFAULT_CALL.enabled, false);
  const safe = normalizeCall({ enabled: "yes", amount: 1, maxAgeMin: 9999, takeProfitPct: "x", reentries: 0 });
  assert.deepEqual([safe.enabled, safe.amount, safe.maxAgeMin, safe.takeProfitPct, safe.reentries], [false, 10, 120, 20, false]);
  assert.equal(normalizeCall({}).reentries, true);
});

test("a fresh call is entered right away at the current price", () => {
  const result = run({ calls: [call(1)] });
  assert.equal(result.buys.length, 1);
  assert.equal(result.buys[0].amount, 100);
  assert.equal(result.buys[0].token.id, "T1");
});

test("stale calls, results, repeats, runners, thin liquidity and base assets are ignored", () => {
  assert.equal(callRejection(call(1, { at: NOW - 6 * 60_000 }), config, NOW), "call trop ancien");
  assert.match(callRejection(call(1, { kind: "update" }), config, NOW), /résultat/);
  assert.equal(callRejection(call(1, { kind: "repeat" }), config, NOW), "coin déjà annoncé");
  assert.equal(callRejection(call(1, {}, { price: 1.3 }), config, NOW), "le prix a déjà trop monté");
  assert.equal(callRejection(call(1, {}, { liquidity: 900 }), config, NOW), "liquidité trop faible");
  assert.equal(callRejection(call(1, {}, { price: 0 }), config, NOW), "prix introuvable");
  assert.equal(callRejection(call(1, {}, { id: "So11111111111111111111111111111111111111112" }), config, NOW), "actif de base");
  assert.equal(callRejection(call(1), config, NOW), null);
});

test("re-entries follow the setting; the safety rules still apply", () => {
  assert.equal(callRejection(call(1, { kind: "reentry" }), config, NOW), null);
  assert.equal(callRejection(call(1, { kind: "reentry" }), { ...config, reentries: false }, NOW), "ré-entrée désactivée");
  assert.equal(callRejection(call(1, { kind: "reentry", at: NOW - 3_600_000 }), config, NOW), "call trop ancien");
});

test("slots, held coins, cooldown, balance, daily loss; other bots' positions do not count", () => {
  const calls = [1, 2, 3, 4].map(id => call(id, { at: NOW - id * 1000 }));
  assert.equal(run({ calls }).buys.length, 3);
  assert.deepEqual(run({ calls, positions: [{ tokenId: "T1", call: true }, { tokenId: "X", hr: true }] }).buys.map(buy => buy.token.id), ["T2", "T3"]);
  assert.deepEqual(run({ calls, lastEntries: { T1: NOW - 1000 } }).buys.map(buy => buy.token.id), ["T2", "T3", "T4"]);
  assert.equal(run({ calls, balance: 150 }).buys.length, 1);
  const losing = [{ call: true, closedAt: NOW - 1000, pnl: -700 }, { call: true, closedAt: NOW - 2000, pnl: -400 }, { closedAt: NOW, pnl: -9999 }];
  assert.equal(callPnlToday(losing, NOW), -1100);
  assert.equal(run({ calls, history: losing }).paused, "daily-loss");
  assert.deepEqual(callStats([{ call: true, pnl: 10 }, { call: true, pnl: -4 }, { pnl: 99 }]), { count: 2, wins: 1, winRate: 50, pnl: 6 });
});

test("the stop-loss written in the post (a market-cap level) kills the call once reached and sets the entry stop", () => {
  const live = (marketCap, slMcap = 100_000) => call(1, { slMcap }, { marketCap, price: 1.0 });
  assert.equal(callStopReason(live(28_600), config), "SL du canal atteint");
  assert.equal(callStopReason(live(250_000), config), null);
  assert.equal(callRejection(live(28_600), config, NOW), "SL du canal atteint");
  assert.equal(Math.round(entryStopPct(live(250_000), config)), 60); // 100K under 250K = −60 %
  assert.equal(run({ calls: [live(250_000)] }).buys[0].stopLossPct, 60);
  assert.equal(callRejection(live(101_000), config, NOW), "SL du canal trop proche");
  assert.equal(entryStopPct(call(1), config), 15); // no level in the post: the configured stop-loss
  assert.equal(entryStopPct(live(250_000), { ...config, useChannelSl: false }), 15);
  assert.equal(callRejection(live(28_600), { ...config, useChannelSl: false }, NOW), null);
});

test("without a level in the post the call dies when the price falls under the configured stop-loss", () => {
  const dead = call(1, { priceAtCall: 1 }, { price: 0.8 });
  assert.equal(callStopReason(dead, config), "stop-loss atteint depuis le call");
  assert.equal(callStopReason(call(1, { priceAtCall: 1 }, { price: 0.9 }), config), null);
});
