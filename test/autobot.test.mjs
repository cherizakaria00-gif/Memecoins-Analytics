import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BOT, botPnlToday, botStats, normalizeBot, pickEntries } from "../dist/autobot.js";

const NOW = new Date("2026-10-06T15:00:00").getTime();
const token = (id, extra = {}) => ({ id, price: 1, liquidity: 50_000, score: 80, signal: { tradable: true }, ...extra });
const run = (overrides = {}) => pickEntries({
  tokens: [token("a"), token("b", { score: 90 }), token("c", { signal: { tradable: false }, score: 50 })],
  positions: [], history: [], balance: 10_000, startBalance: 10_000, config: { ...DEFAULT_BOT, enabled: true }, isQualified: item => item.signal.tradable, now: NOW, ...overrides
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

test("a disabled bot never buys", () => assert.deepEqual(run({ config: DEFAULT_BOT }), { buys: [], paused: null }));

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
  const config = { ...DEFAULT_BOT, enabled: true, maxOpen: 2 };
  assert.equal(run({ config, positions: [{ tokenId: "x", auto: true }] }).buys.length, 1);
  assert.equal(run({ config, positions: [{ tokenId: "x", auto: true }, { tokenId: "y", auto: true }] }).buys.length, 0);
  assert.equal(run({ config, positions: [{ tokenId: "x" }, { tokenId: "y" }] }).buys.length, 2, "manual positions do not use bot slots");
  assert.deepEqual(run({ positions: [{ tokenId: "b" }] }).buys.map(buy => buy.token.id), ["a"]);
  assert.deepEqual(run({ lastEntries: { b: NOW - 3_600_000 } }).buys.map(buy => buy.token.id), ["a"]);
  assert.equal(run({ config: { ...DEFAULT_BOT, enabled: true, minScore: 95 } }).buys.length, 0);
});

test("early starts are used when selected and ignored for the qualified-only source", () => {
  const tokens = [token("e", { signal: { tradable: false }, score: 40, early: { early: true, score: 82 } })];
  assert.deepEqual(run({ tokens, config: { ...DEFAULT_BOT, enabled: true, source: "early" } }).buys.map(buy => buy.source), ["early"]);
  assert.equal(run({ tokens, config: { ...DEFAULT_BOT, enabled: true, source: "qualified" } }).buys.length, 0);
  assert.equal(run({ tokens }).buys.length, 1);
});

test("the daily loss limit pauses the bot, yesterday's losses do not", () => {
  const loss = { auto: true, pnl: -600, closedAt: NOW - 60_000 };
  assert.equal(botPnlToday([loss, { auto: false, pnl: -9999, closedAt: NOW }], NOW), -600);
  assert.deepEqual(run({ history: [loss] }), { buys: [], paused: "daily-loss" });
  assert.equal(run({ history: [{ ...loss, closedAt: NOW - 86_400_000 * 2 }] }).buys.length, 2);
});

test("bot stats only count automatic trades", () => {
  const stats = botStats([{ auto: true, pnl: 10, pnlPct: 4 }, { auto: true, pnl: -5, pnlPct: -2 }, { auto: false, pnl: 100, pnlPct: 50 }]);
  assert.deepEqual(stats, { count: 2, wins: 1, winRate: 50, pnl: 5, avgPct: 1 });
  assert.equal(botStats([]).winRate, null);
});
