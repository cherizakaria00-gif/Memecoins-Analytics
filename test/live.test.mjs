import test from "node:test";
import assert from "node:assert/strict";
import { base58Encode, base64ToBytes, costBasis, describeOrder, limitBreach, orderPrioritySol, positionValue, rawFraction, rawToUi, upsertOrder } from "../dist/live.js";

test("encodes bytes as base58 (signatures) and decodes base64 transactions", () => {
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), "112");
  assert.equal(base58Encode(new TextEncoder().encode("hello")), "Cn8eVZg");
  assert.deepEqual([...base64ToBytes("AQID")], [1, 2, 3]);
});

test("converts raw amounts and fractions without exceeding the balance", () => {
  assert.equal(rawToUi("1500000", 6), 1.5);
  assert.equal(rawFraction("1000", 0.25), "250");
  assert.equal(rawFraction("1001", 0.5), "500");
  assert.equal(rawFraction("123456789012345678", 1), "123456789012345678");
  assert.equal(rawFraction("7", 0.1), "0");
});

test("merges priority fee and tip of a preset", () => {
  assert.equal(orderPrioritySol({ priorityFeeSol: 0.008, tipSol: 0.008 }), 0.016);
  assert.equal(orderPrioritySol(null), 0);
});

test("describes a buy and a sell, flagging risky quotes", () => {
  const buy = describeOrder({ side: "buy", inAmount: "500000000", outAmount: "2000000000", minOutAmount: "1700000000", slippageBps: 1500, priceImpactPct: 1.2, routes: ["Pump.fun Amm"], priorityLamports: 4_000_000 }, { decimals: 6, symbol: "WIF", solUsd: 100 });
  assert.equal(buy.title, "Acheter $WIF");
  assert.equal(buy.pay.amount, 0.5);
  assert.equal(buy.pay.usd, 50);
  assert.equal(buy.receive.amount, 2000);
  assert.equal(buy.receive.min, 1700);
  assert.equal(buy.priorityFeeSol, 0.004);
  assert.deepEqual(buy.warnings, []);
  const sell = describeOrder({ side: "sell", inAmount: "2000000000", outAmount: "480000000", minOutAmount: "408000000", slippageBps: 300, priceImpactPct: 12, simulationError: "InsufficientFunds", priorityLamports: 0 }, { decimals: 6, symbol: "WIF", solUsd: 100 });
  assert.equal(sell.receive.amount, 0.48);
  assert.equal(sell.blocking, true);
  assert.equal(sell.warnings.length, 3);
});

test("average-cost basis across buys and a partial sell, ignoring unconfirmed orders", () => {
  const orders = [
    { mint: "A", side: "buy", state: "confirmed", ts: 1, solLamports: "1000000000", outRaw: "1000" },
    { mint: "A", side: "buy", state: "finalized", ts: 2, solLamports: "1000000000", outRaw: "500" },
    { mint: "A", side: "sell", state: "confirmed", ts: 3, solLamports: "1500000000", inRaw: "750" },
    { mint: "A", side: "buy", state: "pending", ts: 4, solLamports: "9000000000", outRaw: "9" },
    { mint: "B", side: "buy", state: "failed", ts: 1, solLamports: "1000000000", outRaw: "5" }
  ];
  const book = costBasis(orders);
  const a = book.get("A");
  assert.equal(a.tokens, "750");
  assert.equal(a.costSol, 1);
  assert.equal(a.realizedSol, 0.5);
  assert.equal(book.has("B"), false);
});

test("position value, pnl and limit alerts", () => {
  const value = positionValue({ raw: "2000000", decimals: 6, priceUsd: 5, solUsd: 100, costSol: 0.05 });
  assert.equal(value.valueSol, 0.1);
  assert.equal(value.pnlPct, 100);
  assert.equal(positionValue({ raw: "1", decimals: 0, priceUsd: 0, solUsd: 100, costSol: 1 }).valueSol, null);
  assert.equal(positionValue({ raw: "2000000", decimals: 6, priceUsd: 5, solUsd: 100, costSol: 0 }).pnlPct, null);
  assert.equal(limitBreach(-26, { sl: 25 }), "stop-loss");
  assert.equal(limitBreach(41, { sl: 25, tp: 40 }), "take-profit");
  assert.equal(limitBreach(10, { sl: 25, tp: 40 }), null);
  assert.equal(limitBreach(null, { sl: 25 }), null);
});

test("order log keeps the newest first and bounded", () => {
  let log = [];
  for (let index = 0; index < 5; index += 1) log = upsertOrder(log, { id: `o${index}`, state: "pending" }, 3);
  assert.deepEqual(log.map(order => order.id), ["o4", "o3", "o2"]);
  log = upsertOrder(log, { id: "o3", state: "confirmed" }, 3);
  assert.deepEqual(log.map(order => [order.id, order.state]), [["o3", "confirmed"], ["o4", "pending"], ["o2", "pending"]]);
});
