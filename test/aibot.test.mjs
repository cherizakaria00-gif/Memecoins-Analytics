import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AI, aiPnlToday, aiStats, normalizeAi, pickAiEntries } from "../dist/aibot.js";

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const coin = (id, p, extra = {}) => ({ id, price: 1, liquidity: 20_000, ai: { ready: true, p }, ...extra });
const config = { ...DEFAULT_AI, enabled: true };
const run = (overrides = {}) => pickAiEntries({ coins: [], positions: [], history: [], balance: 10_000, startBalance: 10_000, config, now: NOW, ...overrides });

test("defaults mirror the agent's win / loss definition and untrusted input is clamped", () => {
  assert.equal(DEFAULT_AI.enabled, false);
  assert.deepEqual([DEFAULT_AI.takeProfitPct, DEFAULT_AI.stopLossPct], [20, 12]);
  const safe = normalizeAi({ enabled: 1, minProb: 500, amount: -1, takeProfitPct: "x", maxOpen: 99 });
  assert.deepEqual([safe.enabled, safe.minProb, safe.amount, safe.takeProfitPct, safe.maxOpen], [false, 95, 10, 20, 20]);
});

test("buys the highest probabilities above the threshold, never without a validated model", () => {
  const coins = [coin("LOW", 0.4), coin("MID", 0.6), coin("TOP", 0.8), coin("NOMODEL", 0.9, { ai: { ready: false, p: null } }), coin("SOL", 0.95, { id: "So11111111111111111111111111111111111111112" }), coin("ILLIQ", 0.9, { liquidity: 500 })];
  assert.deepEqual(run({ coins }).buys.map(buy => buy.token.id), ["TOP", "MID"]);
  assert.equal(run({ coins, config: { ...config, minProb: 70 } }).buys.map(buy => buy.token.id).join(), "TOP");
});

test("respects slots, held coins, cooldown, balance and the daily loss limit", () => {
  const coins = ["A", "B", "C", "D", "E"].map((id, index) => coin(id, 0.9 - index * 0.01));
  assert.equal(run({ coins }).buys.length, 3);
  assert.deepEqual(run({ coins, positions: [{ tokenId: "A", ai: true }, { tokenId: "Z", hr: true }] }).buys.map(buy => buy.token.id), ["B", "C"]);
  assert.deepEqual(run({ coins, lastEntries: { A: NOW - 1000 } }).buys.map(buy => buy.token.id), ["B", "C", "D"]);
  assert.equal(run({ coins, balance: 150 }).buys.length, 1);
  const losing = [{ ai: true, closedAt: NOW - 1000, pnl: -300 }, { ai: true, closedAt: NOW - 2000, pnl: -250 }, { closedAt: NOW, pnl: -9999 }];
  assert.equal(aiPnlToday(losing, NOW), -550);
  assert.equal(run({ coins, history: losing }).paused, "daily-loss");
  assert.deepEqual(aiStats([{ ai: true, pnl: 20 }, { ai: true, pnl: -5 }, { pnl: 50 }]), { count: 2, wins: 1, winRate: 50, pnl: 15 });
});

test("the market-cap band keeps the bot on coins of the chosen size", () => {
  const band = { ...config, minMcap: 500_000, maxMcap: 2_000_000 };
  const coins = [coin("TINY", 0.9, { marketCap: 80_000 }), coin("ONEM", 0.8, { marketCap: 1_100_000 }), coin("HUGE", 0.95, { marketCap: 9_000_000 }), coin("NOCAP", 0.7, { marketCap: undefined })];
  assert.deepEqual(run({ coins, config: band }).buys.map(buy => buy.token.id), ["ONEM"]);
  assert.equal(run({ coins, config: { ...band, maxMcap: 0 } }).buys.map(buy => buy.token.id).join(), "HUGE,ONEM");
  assert.equal(run({ coins }).buys.length, 3);
});
