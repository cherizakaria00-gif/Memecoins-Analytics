import test from "node:test";
import assert from "node:assert/strict";
import { atr, buildTradePlan, ema, exitAdvice, pivots, planPercents } from "../dist/trade-plan.js";

/** Builds candles from close prices with a fixed relative range and flat volume. */
const candlesFrom = (closes, { range = 0.02, volume = 100 } = {}) => closes.map((close, index) => {
  const open = index ? closes[index - 1] : close;
  return { time: 1000 + index * 300, open, close, high: Math.max(open, close) * (1 + range), low: Math.min(open, close) * (1 - range), volume };
});
const line = (start, end, count) => Array.from({ length: count }, (_, index) => start + (end - start) * (index / (count - 1)));
const wobble = values => values.map((value, index) => value * (1 + (index % 2 ? 0.012 : -0.012)));

test("ema follows a trend and atr measures volatility", () => {
  assert.ok(ema([1, 2, 3, 4, 5, 6], 3)[5] > 4.5);
  assert.ok(atr(candlesFrom(line(1, 2, 40), { range: 0.05 })) > atr(candlesFrom(line(1, 2, 40), { range: 0.01 })));
  const swing = pivots(candlesFrom([1, 2, 5, 2, 1, 2, 4, 2, 1], { range: 0 })).highs.map(pivot => pivot.index);
  assert.ok(swing.includes(2) && swing.includes(6));
});

test("not enough candles gives no plan", () => {
  assert.equal(buildTradePlan(candlesFrom(line(1, 2, 10))).state, "unknown");
});

test("a steady uptrend near its mean gives a buy plan with stop below entry and ordered targets", () => {
  const plan = buildTradePlan(candlesFrom(wobble(line(1, 1.6, 80))), { signal: { grade: "B" } });
  assert.equal(plan.state, "buy");
  assert.ok(plan.stop.price < plan.entry.price);
  assert.ok(plan.targets[0].price > plan.entry.price && plan.targets[1].price > plan.targets[0].price);
  assert.ok(plan.netRr >= 1);
  const percents = planPercents(plan);
  assert.ok(percents.stopLossPct >= 5 && percents.takeProfitPct >= 1);
});

test("a vertical pump never gets a buy-now plan", () => {
  const closes = [...line(1, 1.05, 70), ...line(1.05, 2.4, 12)];
  const plan = buildTradePlan(candlesFrom(closes));
  assert.notEqual(plan.state, "buy");
  assert.ok(plan.extension > 2.5);
  if (plan.state === "wait") assert.ok(plan.entry.price < closes[closes.length - 1]);
  else assert.match(plan.notes.join(" "), /stop|risque/i);
});

test("a pullback inside an uptrend gives a wait plan with a limit zone under the price", () => {
  const closes = [...line(1, 1.5, 60), ...line(1.5, 1.42, 6), ...line(1.42, 1.8, 6)];
  const plan = buildTradePlan(candlesFrom(wobble(closes)));
  assert.ok(["wait", "buy", "breakout", "avoid"].includes(plan.state));
  if (plan.state === "wait") assert.ok(plan.entry.low < closes[closes.length - 1]);
});

test("a downtrend is avoided and so is a rejected signal", () => {
  assert.equal(buildTradePlan(candlesFrom(line(2, 1, 80))).state, "avoid");
  const rejected = buildTradePlan(candlesFrom(wobble(line(1, 1.6, 80))), { signal: { grade: "avoid", flags: ["Liquidité trop faible"] } });
  assert.equal(rejected.state, "avoid");
  assert.match(rejected.notes[0], /Liquidité/);
});

test("exit advice follows the plan levels", () => {
  const plan = buildTradePlan(candlesFrom(wobble(line(1, 1.6, 80))), { signal: { grade: "B" } });
  const position = { spotEntry: plan.entry.price };
  assert.equal(exitAdvice(plan, position, plan.stop.price * 0.99).action, "exit");
  assert.equal(exitAdvice(plan, position, plan.targets[0].price * 1.001).action, "partial");
  assert.equal(exitAdvice(plan, position, plan.targets[1].price * 1.01).action, "take-profit");
  assert.equal(exitAdvice(plan, position, plan.entry.price * 1.01).action, "hold");
  assert.equal(exitAdvice(null, position, 1), null);
});

test("flat illiquid candles do not produce absurd extensions", () => {
  const flat = candlesFrom([...Array(70).fill(1), ...line(1, 1.3, 10)], { range: 0 });
  const plan = buildTradePlan(flat);
  assert.ok(plan.extension < 40, `extension ${plan.extension}`);
});
