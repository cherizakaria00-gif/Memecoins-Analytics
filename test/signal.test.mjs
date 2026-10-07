import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSignal } from "../src/signal.mjs";

const healthy = {
  liquidity: 150_000, marketCap: 1_200_000, athMarketCap: 1_400_000, ageMinutes: 240,
  volume5m: 9_000, volume: 90_000, volume6h: 300_000, volume24h: 700_000,
  buys: 300, sells: 160, buys5m: 30, sells5m: 12,
  change5m: 3, change: 30, change6h: 80, change24h: 150
};

test("a liquid token with fresh controlled buying earns a tradable grade", () => {
  const signal = evaluateSignal(healthy);
  assert.deepEqual(signal.flags, []);
  assert.ok(signal.score >= 65, `score ${signal.score}`);
  assert.equal(signal.tradable, true);
  assert.ok(signal.reasons.includes("Liquidité profonde"));
});

test("hard filters cap the score and explain why", () => {
  const cases = [
    [{ liquidity: 8_000 }, /Liquidité trop faible/],
    [{ ageMinutes: 5 }, /trop récent/],
    [{ change: 300 }, /trop monté/],
    [{ change: -40 }, /Chute/],
    [{ buys: 80, sells: 300 }, /vendeuse/],
    [{ athMarketCap: 10_000_000 }, /ATH/],
    [{ volume5m: 10 }, /s'éteint/],
    [{ marketCap: 30_000_000 }, /Market cap/]
  ];
  for (const [patch, pattern] of cases) {
    const signal = evaluateSignal({ ...healthy, ...patch });
    assert.ok(signal.flags.some(flag => pattern.test(flag)), `${JSON.stringify(patch)} -> ${signal.flags}`);
    assert.equal(signal.grade, "avoid");
    assert.ok(signal.score <= 39);
  }
});

test("a huge recent pump scores lower than a steady climb", () => {
  const steady = evaluateSignal(healthy);
  const pumped = evaluateSignal({ ...healthy, change: 600, change6h: 700 });
  assert.ok(steady.score > pumped.score);
});

test("missing data does not crash and yields no tradable signal", () => {
  const signal = evaluateSignal({});
  assert.equal(signal.tradable, false);
  assert.ok(Number.isFinite(signal.score));
});
