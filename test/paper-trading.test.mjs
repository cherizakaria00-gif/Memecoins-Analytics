import test from "node:test";
import assert from "node:assert/strict";
import { closePosition, normalizeWallet, openPosition, positionValue, quoteBuy, sellProceeds, summarizeHistory, validateBuy } from "../dist/paper-trading.js";

const token = { id: "t1", name: "Token", symbol: "TKN", initials: "TK", price: 0.01, liquidity: 100_000 };

test("buy charges a fee and price impact", () => {
  const quote = quoteBuy(token, 1000);
  assert.equal(quote.fee, 10);
  assert.ok(quote.fillPrice > token.price);
  assert.ok(quote.units * token.price < 990);
});

test("an immediate round trip loses fees and slippage, never gains", () => {
  const position = openPosition(token, 1000);
  const { proceeds, trade } = closePosition(position, token);
  assert.ok(proceeds < 1000 && proceeds > 900);
  assert.ok(trade.pnl < 0);
});

test("price changes drive the pnl in the right direction", () => {
  const position = openPosition(token, 1000);
  assert.ok(positionValue(position, { ...token, price: 0.02 }) > 1000);
  assert.ok(positionValue(position, { ...token, price: 0.005 }) < 500);
});

test("thin liquidity makes exits expensive but bounded", () => {
  const thin = { ...token, liquidity: 2_000 };
  const proceeds = sellProceeds(5_000, thin.liquidity);
  assert.ok(proceeds > 0 && proceeds < 5_000 * 0.5);
});

test("validates buys", () => {
  assert.match(validateBuy(token, 5, 1000), /minimum/);
  assert.match(validateBuy(token, 2000, 1000), /insuffisant/);
  assert.match(validateBuy({ ...token, price: 0 }, 100, 1000), /Prix/);
  assert.equal(validateBuy(token, 100, 1000), null);
});

test("closing a position whose token left the feed uses its last known price", () => {
  const position = { ...openPosition(token, 1000), lastPrice: 0.02 };
  assert.ok(closePosition(position, undefined).proceeds > 1000);
});

test("normalizes untrusted and legacy wallets", () => {
  assert.deepEqual(normalizeWallet(null), { balance: 10000, positions: [], history: [] });
  const wallet = normalizeWallet({ balance: "x", positions: [{ id: 1, tokenId: "a", amount: 100, entryPrice: 0.5 }, { tokenId: "b", amount: -5, entryPrice: 1 }] });
  assert.equal(wallet.balance, 10000);
  assert.equal(wallet.positions.length, 1);
  assert.equal(wallet.positions[0].units, 200);
});

test("summarizes realized results", () => {
  const summary = summarizeHistory([{ pnl: 50 }, { pnl: -20 }, { pnl: 10 }]);
  assert.equal(summary.realized, 40);
  assert.equal(Math.round(summary.winRate), 67);
});

import { checkTriggers, sellFraction } from "../dist/paper-trading.js";

test("partial sell splits cost basis and keeps the rest open", () => {
  const position = openPosition(token, 1000);
  const sale = sellFraction(position, token, 0.5);
  assert.equal(sale.trade.amount, 500);
  assert.equal(sale.remaining.amount, 500);
  assert.ok(Math.abs(sale.remaining.units - position.units / 2) < 1e-9);
  const rest = sellFraction(sale.remaining, token, 1);
  assert.equal(rest.remaining, null);
  assert.ok(Math.abs(sale.proceeds + rest.proceeds - closePositionProceeds(position)) < 15);
});

function closePositionProceeds(position) {
  return positionValue(position, token);
}

test("stop-loss and take-profit trigger on net pnl", () => {
  const position = openPosition(token, 1000, { stopLossPct: 20, takeProfitPct: 50 });
  assert.equal(checkTriggers(position, token), null);
  assert.equal(checkTriggers(position, { ...token, price: 0.007 }), "stop-loss");
  assert.equal(checkTriggers(position, { ...token, price: 0.017 }), "take-profit");
  assert.equal(checkTriggers(openPosition(token, 1000), { ...token, price: 0.0001 }), null);
});

test("ignores invalid limits", () => {
  const position = openPosition(token, 1000, { stopLossPct: "abc", takeProfitPct: -5 });
  assert.equal(position.stopLossPct, null);
  assert.equal(position.takeProfitPct, null);
});

import { buildTradeMarkers } from "../dist/paper-trading.js";

test("builds one buy and one sell marker per trade, snapped to candle buckets", () => {
  const position = { ...openPosition(token, 1000, { now: 1_000_000_000_000 }), id: "p1" };
  const sale = sellFraction(position, token, 0.5, { reason: "take-profit", now: 1_000_000_700_000 });
  const markers = buildTradeMarkers({
    tokenId: "t1", positions: [sale.remaining], history: [sale.trade], timeframe: "5m", firstCandleTime: 0
  });
  assert.equal(markers.length, 2);
  assert.equal(markers[0].shape, "arrowUp");
  assert.equal(markers[0].time % 300, 0);
  assert.match(markers[1].text, /^TP /);
  assert.equal(buildTradeMarkers({ tokenId: "other", positions: [sale.remaining], history: [sale.trade], timeframe: "5m" }).length, 0);
  assert.equal(buildTradeMarkers({ tokenId: "t1", positions: [], history: [sale.trade], timeframe: "5m", firstCandleTime: 2e9 }).length, 0);
});

import { FEE_PRESETS, costsFor, presetById, presetForCapital, sellImpact } from "../dist/paper-trading.js";

test("fee presets match the reference table", () => {
  const [normal, aggressive, sniper] = FEE_PRESETS;
  assert.deepEqual([normal.priorityFeeSol, normal.tipSol, normal.slippageBuyPct, normal.slippageSellPct, normal.passiveSol, normal.deepPassSol], [0.002, 0.002, 15, 20, 0.1, 0.3]);
  assert.deepEqual([aggressive.priorityFeeSol, aggressive.tipSol, aggressive.slippageBuyPct, aggressive.slippageSellPct, aggressive.passiveSol, aggressive.deepPassSol], [0.008, 0.008, 30, 40, 0.3, 1]);
  assert.deepEqual([sniper.priorityFeeSol, sniper.tipSol, sniper.slippageBuyPct, sniper.slippageSellPct, sniper.passiveSol, sniper.deepPassSol], [0.015, 0.015, 50, 70, 1, 3]);
  assert.equal(presetForCapital(0.3).id, "normal");
  assert.equal(presetForCapital(1).id, "normal");
  assert.equal(presetForCapital(2.5).id, "aggressive");
  assert.equal(presetForCapital(5).id, "aggressive");
  assert.equal(presetForCapital(12).id, "sniper");
  assert.equal(presetById("nope").id, "normal");
  assert.equal(costsFor(aggressive, 100).networkCostUsd, 1.6);
});

test("priority fee and tip are charged on entry and on exit", () => {
  const costs = costsFor(FEE_PRESETS[1], 100);
  const withCosts = openPosition(token, 1000, { costs, preset: FEE_PRESETS[1] });
  const without = openPosition(token, 1000);
  assert.equal(withCosts.networkCostUsd, 1.6);
  assert.ok(withCosts.units < without.units);
  assert.ok(positionValue(withCosts, token) < positionValue({ ...withCosts, networkCostUsd: 0 }, token));
  assert.equal(withCosts.presetId, "aggressive");
});

test("a buy is refused when its impact exceeds the preset slippage", () => {
  const thin = { ...token, liquidity: 4_000 };
  const normal = FEE_PRESETS[0];
  assert.match(validateBuy(thin, 500, 10_000, { preset: normal, costs: costsFor(normal, 100) }), /Slippage trop élevé/);
  assert.equal(validateBuy(thin, 500, 10_000, { preset: FEE_PRESETS[2], costs: costsFor(FEE_PRESETS[2], 100) }), null);
  assert.equal(validateBuy(token, 500, 10_000, { preset: normal, costs: costsFor(normal, 100) }), null);
});

test("manual sells respect the sell slippage while stop-loss sells are forced", () => {
  const thin = { ...token, liquidity: 6_000 };
  const position = openPosition(thin, 500, { costs: costsFor(FEE_PRESETS[2], 100), preset: { ...FEE_PRESETS[0], slippageSellPct: 5 } });
  assert.ok(sellImpact(position.units * thin.price, thin.liquidity) * 100 > 5);
  const manual = sellFraction(position, thin, 1, { force: false });
  assert.equal(manual.blocked, true);
  const forced = sellFraction(position, thin, 1, { reason: "stop-loss" });
  assert.ok(forced.proceeds > 0 && forced.trade.impactPct > 5);
  const partial = sellFraction(position, thin, 0.1, { force: false });
  assert.equal(Boolean(partial.blocked), false);
});

test("manual limit orders: sanitising and settling against live prices", async () => {
  const { normalizeLimitOrders, settleLimitOrders } = await import("../dist/paper-trading.js");
  assert.deepEqual(normalizeLimitOrders("x"), []);
  const orders = normalizeLimitOrders([
    { id: "a", tokenId: "A", symbol: "A", amount: 250, limitPrice: 0.97, expiresAt: 2_000, stopLossPct: "20", takeProfitPct: "" },
    { id: "b", tokenId: "B", symbol: "B", amount: 100, limitPrice: 1, expiresAt: 500 },
    { tokenId: "C", amount: -5, limitPrice: 1, expiresAt: 9 }, null
  ]);
  assert.equal(orders.length, 2);
  assert.deepEqual([orders[0].stopLossPct, orders[0].takeProfitPct], [20, null]);
  const prices = { A: 0.96, B: 0.5 };
  const result = settleLimitOrders(orders, id => ({ price: prices[id] }), 1_000);
  assert.deepEqual(result.filled.map(item => item.order.id), ["a"]);
  assert.deepEqual(result.expired.map(order => order.id), ["b"], "expired before it could fill");
  assert.equal(settleLimitOrders(orders, () => ({ price: 1.2 }), 100).waiting.length, 2);
  assert.equal(settleLimitOrders(orders, () => null, 100).waiting.length, 2, "unknown token: keeps waiting");
});
