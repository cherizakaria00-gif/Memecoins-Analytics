import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOT, botPnlToday, botStats, normalizeBot, normalizePending, pickEntries } from "../dist/autobot.js";

const IMMEDIATE = { ...DEFAULT_BOT, enabled: true, entryDipPct: 0 };
const NOW = new Date("2026-10-06T15:00:00").getTime();
const token = (id, extra = {}) => ({ id, price: 1, liquidity: 50_000, score: 80, signal: { tradable: true }, ...extra });
const run = (overrides = {}) => pickEntries({
  tokens: [token("a"), token("b", { score: 90 }), token("c", { signal: { tradable: false }, score: 50 })],
  positions: [], history: [], balance: 10_000, startBalance: 10_000, config: IMMEDIATE, isQualified: item => item.signal.tradable, now: NOW, ...overrides
});

test("config is clamped and unknown values fall back to safe defaults", () => {
  assert.deepEqual(normalizeBot(null), DEFAULT_BOT);
  const config = normalizeBot({ enabled: true, source: "nope", sizePct: 999, stopLossPct: -4, maxOpen: 500, takeProfitPct: "abc" });
  assert.equal(config.enabled, true);
  assert.equal(config.source, "both");
  assert.equal(config.sizePct, 50);
  assert.equal(config.stopLossPct, 1);
  assert.equal(config.maxOpen, 20);
  assert.equal(config.takeProfitPct, DEFAULT_BOT.takeProfitPct);
});

test("a disabled bot never buys", () => { const result = run({ config: DEFAULT_BOT }); assert.deepEqual([result.buys, result.placed, result.paused], [[], [], null]); });

test("buys the best qualified signals first, sized as a percentage of the balance", () => {
  const { buys } = run();
  assert.deepEqual(buys.map(buy => buy.token.id), ["b", "a"]);
  assert.equal(buys[0].amount, 500);
  assert.equal(buys[0].source, "qualified");
});

test("size is a % of the balance but capped by the max amount", () => {
  assert.equal(run({ balance: 2000 }).buys[0].amount, 100);
  assert.equal(run({ balance: 100000, startBalance: 100000 }).buys[0].amount, 500);
  assert.equal(run({ balance: 150 }).buys.length, 0, "below the 10 $ minimum");
});

test("respects the slot limit, held tokens, cooldown and minimum score", () => {
  const config = { ...IMMEDIATE, maxOpen: 2 };
  assert.equal(run({ config, positions: [{ tokenId: "x", auto: true }] }).buys.length, 1);
  assert.equal(run({ config, positions: [{ tokenId: "x", auto: true }, { tokenId: "y", auto: true }] }).buys.length, 0);
  assert.equal(run({ config, positions: [{ tokenId: "x" }, { tokenId: "y" }] }).buys.length, 2, "manual positions do not use bot slots");
  assert.deepEqual(run({ positions: [{ tokenId: "b" }] }).buys.map(buy => buy.token.id), ["a"]);
  assert.deepEqual(run({ lastEntries: { b: NOW - 3_600_000 } }).buys.map(buy => buy.token.id), ["a"]);
  assert.equal(run({ config: { ...IMMEDIATE, minScore: 95 } }).buys.length, 0);
});

test("early starts are used when selected and ignored for the qualified-only source", () => {
  const tokens = [token("e", { signal: { tradable: false }, score: 40, early: { early: true, score: 82 } })];
  assert.deepEqual(run({ tokens, config: { ...IMMEDIATE, source: "early" } }).buys.map(buy => buy.source), ["early"]);
  assert.equal(run({ tokens, config: { ...IMMEDIATE, source: "qualified" } }).buys.length, 0);
  assert.equal(run({ tokens }).buys.length, 1);
});

test("the daily loss limit pauses the bot, yesterday's losses do not", () => {
  const loss = { auto: true, pnl: -600, closedAt: NOW - 60_000 };
  assert.equal(botPnlToday([loss, { auto: false, pnl: -9999, closedAt: NOW }], NOW), -600);
  const paused = run({ history: [loss] });
  assert.deepEqual([paused.buys, paused.paused], [[], "daily-loss"]);
  assert.equal(run({ history: [{ ...loss, closedAt: NOW - 86_400_000 * 2 }] }).buys.length, 2);
});

test("bot stats only count automatic trades", () => {
  const stats = botStats([{ auto: true, pnl: 10, pnlPct: 4 }, { auto: true, pnl: -5, pnlPct: -2 }, { auto: false, pnl: 100, pnlPct: 50 }]);
  assert.deepEqual(stats, { count: 2, wins: 1, winRate: 50, pnl: 5, avgPct: 1 });
  assert.equal(botStats([]).winRate, null);
});

test("with an entry dip a signal places a limit order below the price instead of buying", () => {
  const config = { ...IMMEDIATE, entryDipPct: 3, orderTimeoutMin: 30 };
  const first = run({ config });
  assert.equal(first.buys.length, 0);
  assert.deepEqual(first.placed.map(order => [order.tokenId, order.limitPrice, order.refPrice]), [["b", 0.97, 1], ["a", 0.97, 1]]);
  assert.equal(first.placed[0].expiresAt, NOW + 30 * 60_000);
  assert.deepEqual(first.pending, first.placed);
});

test("a pending order fills when the price reaches the limit, stays while above and expires after its timeout", () => {
  const config = { ...IMMEDIATE, entryDipPct: 3, orderTimeoutMin: 30 };
  const order = { tokenId: "a", symbol: "A", limitPrice: 0.97, refPrice: 1, score: 80, source: "qualified", createdAt: NOW, expiresAt: NOW + 30 * 60_000 };
  const above = run({ config, pending: [order], tokens: [token("a")] });
  assert.deepEqual([above.buys.length, above.pending.length], [0, 1], "price 1 is above the 0.97 limit");
  const dipped = run({ config, pending: [order], tokens: [token("a", { price: 0.96 })] });
  assert.deepEqual([dipped.buys.map(buy => buy.token.id), dipped.buys[0].limit, dipped.pending.length], [["a"], 0.97, 0]);
  const late = run({ config, pending: [order], tokens: [token("a", { price: 0.5 })], now: NOW + 31 * 60_000 });
  assert.deepEqual([late.buys.length, late.expired.length, late.pending.length], [0, 1, 1], "an expired order never fills; a still-valid signal gets a fresh one");
  assert.equal(late.pending[0].refPrice, 0.5);
});

test("pending orders count against the slots and are not duplicated", () => {
  const config = { ...IMMEDIATE, entryDipPct: 3, maxOpen: 2 };
  const first = run({ config });
  assert.equal(first.placed.length, 2);
  const again = run({ config, pending: first.pending });
  assert.equal(again.placed.length, 0);
  const oneSlot = run({ config: { ...config, maxOpen: 1 } });
  assert.equal(oneSlot.placed.length, 1);
});

test("saved pending orders are sanitised", () => {
  assert.deepEqual(normalizePending("x"), []);
  assert.equal(normalizePending([{ tokenId: "a", limitPrice: 1, expiresAt: 5 }, { tokenId: 4 }, null]).length, 1);
});
