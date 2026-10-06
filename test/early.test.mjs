import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEarly } from "../src/early.mjs";

const starting = {
  liquidity: 90_000, marketCap: 600_000, athMarketCap: 640_000, ageMinutes: 300,
  volume5m: 6_000, volume: 40_000, volume6h: 120_000, volume24h: 400_000,
  buys: 260, sells: 120, buys5m: 40, sells5m: 14,
  change5m: 4, change: 22, change6h: 35, change24h: 60, signal: { flagCodes: [] }
};

test("a fresh +22 % start with accelerating volume and buyers is detected", () => {
  const early = evaluateEarly(starting);
  assert.equal(early.early, true, JSON.stringify(early));
  assert.ok(early.score >= 60);
  assert.equal(early.stage, "accélération");
  assert.ok(early.reasons.some(reason => /Volume ×/.test(reason)));
});

test("a token that is already far up is not an early start", () => {
  assert.equal(evaluateEarly({ ...starting, change6h: 450 }).early, false);
  assert.equal(evaluateEarly({ ...starting, change: 140 }).early, false);
});

test("no start without buyers, acceleration or a rising price", () => {
  assert.equal(evaluateEarly({ ...starting, buys5m: 8, sells5m: 22 }).early, false);
  assert.equal(evaluateEarly({ ...starting, volume5m: 800 }).early, false);
  assert.equal(evaluateEarly({ ...starting, change5m: -2 }).early, false);
  assert.equal(evaluateEarly({ ...starting, change: 3 }).early, false);
});

test("safety flags and thin liquidity block a start", () => {
  assert.equal(evaluateEarly({ ...starting, signal: { flagCodes: ["insiders"] } }).early, false);
  assert.equal(evaluateEarly({ ...starting, liquidity: 9_000 }).early, false);
  assert.equal(evaluateEarly({ ...starting, ageMinutes: 8 }).early, false);
});

test("a nearly-passing token is flagged as a candidate and handles missing data", () => {
  const near = evaluateEarly({ ...starting, volume5m: 1_500 });
  assert.equal(near.early, false);
  assert.equal(near.candidate, true);
  assert.deepEqual(near.missing, ["volume"]);
  assert.equal(evaluateEarly({}).early, false);
});
