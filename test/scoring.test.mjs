import test from "node:test";
import assert from "node:assert/strict";
import { calculateMarketSignal, calculateTokenScore, classifyRisk } from "../src/scoring.mjs";

const healthyToken = {
  liquidity: 250_000,
  volume: 180_000,
  holders: 2_500,
  liquidityLocked: 100,
  top10Concentration: 15,
  ageMinutes: 240,
  mintRevoked: true,
  freezeRevoked: true
};

test("a healthy token earns a strong score", () => {
  assert.ok(calculateTokenScore(healthyToken) >= 85);
});

test("an active mint authority caps the score", () => {
  assert.ok(calculateTokenScore({ ...healthyToken, mintRevoked: false }) <= 48);
});

test("unlocked liquidity caps the score", () => {
  assert.ok(calculateTokenScore({ ...healthyToken, liquidityLocked: 0 }) <= 42);
});

test("high concentration caps the score", () => {
  assert.ok(calculateTokenScore({ ...healthyToken, top10Concentration: 80 }) <= 38);
});

test("missing metrics return a valid minimum score", () => {
  assert.equal(calculateTokenScore(undefined), 0);
});

test("risk classification uses stable boundaries", () => {
  assert.equal(classifyRisk(70), "Faible");
  assert.equal(classifyRisk(50), "Moyen");
  assert.equal(classifyRisk(49), "Élevé");
});

test("market signal rewards liquid active markets", () => {
  const strong = calculateMarketSignal({ liquidity: 300_000, volume: 250_000, buys: 190, sells: 60, ageMinutes: 120, change: 35 });
  const weak = calculateMarketSignal({ liquidity: 8_000, volume: 500, buys: 2, sells: 12, ageMinutes: 3, change: -30 });
  assert.ok(strong >= 75);
  assert.ok(weak < 20);
});
