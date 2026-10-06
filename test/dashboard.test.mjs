import test from "node:test";
import assert from "node:assert/strict";
import { profitTransition, addEquityPoint, allocation, barScale, donutSvg, formatDuration, limitProgress, maxDrawdown, pnlByDay, pnlByToken, tradeStats } from "../dist/dashboard.js";

const trade = (pnl, tokenId = "a", extra = {}) => ({ pnl, tokenId, tokenSymbol: tokenId.toUpperCase(), openedAt: 0, closedAt: 600_000, ...extra });

test("computes win rate, profit factor and extremes", () => {
  const stats = tradeStats([trade(50), trade(-20), trade(30), trade(-10)]);
  assert.equal(stats.count, 4);
  assert.equal(stats.winRate, 0.5);
  assert.equal(stats.realized, 50);
  assert.equal(stats.profitFactor, 80 / 30);
  assert.equal(stats.avgWin, 40);
  assert.equal(stats.avgLoss, -15);
  assert.equal(stats.best, 50);
  assert.equal(stats.worst, -20);
  assert.equal(stats.expectancy, 12.5);
  assert.equal(stats.avgHoldMs, 600_000);
  const empty = tradeStats([]);
  assert.equal(empty.winRate, null);
  assert.equal(tradeStats([trade(10)]).profitFactor, Infinity);
});

test("max drawdown measures the deepest fall from a peak", () => {
  const drawdown = maxDrawdown([100, 120, 90, 110, 80, 130].map((v, t) => ({ t, v })));
  assert.equal(Math.round(drawdown.pct * 1000) / 1000, 0.333);
  assert.equal(drawdown.abs, 40);
  assert.deepEqual(maxDrawdown([]), { pct: 0, abs: 0 });
});

test("equity samples are throttled, forceable and bounded", () => {
  let series = addEquityPoint([], { t: 0, v: 100 });
  series = addEquityPoint(series, { t: 5_000, v: 101 });
  assert.equal(series.length, 1);
  series = addEquityPoint(series, { t: 12_000, v: 102 });
  assert.equal(series.length, 2);
  series = addEquityPoint(series, { t: 13_000, v: 103 }, { force: true });
  assert.equal(series.length, 3);
  let long = [];
  for (let index = 0; index < 40; index += 1) long = addEquityPoint(long, { t: index * 20_000, v: index }, { max: 20 });
  assert.ok(long.length <= 21 && long[long.length - 1].v === 39);
  assert.equal(addEquityPoint(series, { t: NaN, v: 1 }), series);
});

test("aggregates pnl per token and per day", () => {
  const byToken = pnlByToken([trade(50, "a"), trade(-70, "b"), trade(10, "a")], [{ tokenId: "b", symbol: "B", pnl: 90 }, { tokenId: "c", symbol: "C", pnl: -5 }]);
  assert.deepEqual(byToken.map(item => [item.id, item.total]), [["a", 60], ["b", 20], ["c", -5]]);
  const now = new Date(2026, 9, 5, 15).getTime();
  const days = pnlByDay([trade(10, "a", { closedAt: now }), trade(-4, "a", { closedAt: now - 60_000 }), trade(7, "a", { closedAt: now - 2 * 86_400_000 })], 5, now);
  assert.equal(days.length, 5);
  assert.equal(days[4].pnl, 6);
  assert.equal(days[2].pnl, 7);
  assert.equal(days[0].pnl, 0);
});

test("allocation shares sum to one and skip empty slices", () => {
  const parts = allocation(500, [{ symbol: "A", value: 300, tokenId: "a" }, { symbol: "B", value: 200, tokenId: "b" }, { symbol: "Z", value: 0, tokenId: "z" }]);
  assert.deepEqual(parts.map(part => part.label), ["Cash", "$A", "$B"]);
  assert.ok(Math.abs(parts.reduce((total, part) => total + part.pct, 0) - 1) < 1e-9);
  assert.match(donutSvg(parts, ["#1", "#2", "#3"]), /<svg/);
});

test("limit progress places the position between stop and target", () => {
  assert.equal(limitProgress(-20, 20, 40).position, 0);
  assert.equal(limitProgress(40, 20, 40).position, 1);
  assert.equal(Math.round(limitProgress(0, 20, 40).position * 100), 33);
  const open = limitProgress(5, null, null);
  assert.equal(open.hasStop, false);
  assert.ok(open.position > 0 && open.position < 1);
});

test("formats durations and bar widths", () => {
  assert.equal(formatDuration(30_000), "< 1 min");
  assert.equal(formatDuration(90 * 60_000), "1 h 30");
  assert.equal(formatDuration(5 * 86_400_000), "5 j");
  assert.equal(formatDuration(NaN), "—");
  assert.deepEqual(barScale([{ total: 50 }, { total: -100 }]).map(item => item.width), [0.5, 1]);
});

test("a position notifies once when it turns positive, with a hysteresis around zero", () => {
  assert.deepEqual(profitTransition(undefined, 3), { next: "up", crossed: false }, "first sight: baseline only");
  assert.deepEqual(profitTransition(undefined, -4), { next: "down", crossed: false });
  assert.deepEqual(profitTransition("down", 0.2), { next: "down", crossed: false }, "below the +0.5 % threshold");
  assert.deepEqual(profitTransition("down", 0.8), { next: "up", crossed: true });
  assert.deepEqual(profitTransition("up", 2), { next: "up", crossed: false }, "already positive: no repeat");
  assert.deepEqual(profitTransition("up", 0.2), { next: "up", crossed: false }, "dips between 0 and 0.5 % keep the state");
  const dipped = profitTransition("up", -0.1);
  assert.deepEqual(dipped, { next: "down", crossed: false });
  assert.equal(profitTransition(dipped.next, 1.2).crossed, true, "a new crossing after a real dip notifies again");
});
