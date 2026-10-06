import test from "node:test";
import assert from "node:assert/strict";
import { getNewCoins, newCoinsConfig, resetNewCoinsCache } from "../src/new-coins.mjs";

const NOW = 1_800_000_000_000;
const coin = (mint, symbol, minutesOld, usdMarketCap, extra = {}) => ({ mint, name: symbol, symbol, created_timestamp: NOW - minutesOld * 60_000, usd_market_cap: usdMarketCap, market_cap: usdMarketCap / 120, real_sol_reserves: 20e9, complete: false, ...extra });
const pair = (mint, symbol, volume, liquidity = 40_000, marketCap = 50_000) => ({ chainId: "solana", dexId: "pumpswap", baseToken: { address: mint, name: symbol, symbol }, quoteToken: { symbol: "SOL" }, priceUsd: "0.00005", priceNative: "0.0000004", marketCap, liquidity: { usd: liquidity }, volume: { h24: volume, h1: volume }, txns: { h24: { buys: 80, sells: 40 } }, pairCreatedAt: NOW - 120_000, pairAddress: `pair-${mint}` });

function client({ coins, pairs }) {
  return async url => {
    if (url.includes("pump.fun")) return { ok: true, status: 200, json: async () => coins };
    return { ok: true, status: 200, json: async () => pairs };
  };
}

test("keeps new coins that pass the filter and flags those that do not", async () => {
  resetNewCoinsCache();
  const fetchImpl = client({
    coins: [coin("MintGoodGoodGoodGoodGoodGoodGoodGoodpump", "GOOD", 2, 60_000), coin("MintLowVolLowVolLowVolLowVolLowVolLowpump", "LOW", 3, 60_000), coin("MintBrandNewBrandNewBrandNewBrandNewNewpump", "FRESH", 1, 8_000), coin("MintTinyTinyTinyTinyTinyTinyTinyTinyTinypump", "TINY", 4, 2_000)],
    pairs: [pair("MintGoodGoodGoodGoodGoodGoodGoodGoodpump", "GOOD", 25_000), pair("MintLowVolLowVolLowVolLowVolLowVolLowpump", "LOW", 900), pair("MintTinyTinyTinyTinyTinyTinyTinyTinyTinypump", "TINY", 30_000, 40_000, 2_000)]
  });
  const { tokens, passed } = await getNewCoins({ fetchImpl, now: NOW, config: newCoinsConfig({}) });
  const bySymbol = Object.fromEntries(tokens.map(token => [token.symbol, token]));
  assert.equal(bySymbol.GOOD.quality.passes, true);
  assert.equal(bySymbol.LOW.quality.passes, false);
  assert.ok(bySymbol.LOW.quality.checks.some(check => check.id === "volume24h" && !check.ok));
  assert.equal(bySymbol.TINY.quality.passes, false);
  assert.equal(bySymbol.FRESH.synthetic, true);
  assert.equal(bySymbol.FRESH.quality.passes, false);
  assert.equal(bySymbol.GOOD.ageMinutes, 2);
  assert.equal(passed, 1);
});

test("the age minimum is waived and the volume floor is configurable", () => {
  const config = newCoinsConfig({ NEW_MIN_VOLUME: "500" });
  assert.equal(config.minAgeMinutes, 0);
  assert.equal(config.minVolume24h, 500);
  assert.equal(newCoinsConfig({}).minVolume24h, 8960);
});

test("falls back to pump.fun data when DEX Screener fails and caches briefly", async () => {
  resetNewCoinsCache();
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    if (url.includes("pump.fun")) return { ok: true, status: 200, json: async () => [coin("MintOnlyOnlyOnlyOnlyOnlyOnlyOnlyOnlyOnlypump", "ONLY", 1, 30_000)] };
    throw new Error("dexscreener down");
  };
  const first = await getNewCoins({ fetchImpl, now: NOW, config: newCoinsConfig({}) });
  assert.equal(first.tokens.length, 1);
  assert.equal(first.tokens[0].synthetic, true);
  const afterFirst = calls;
  await getNewCoins({ fetchImpl, now: NOW + 2_000, config: newCoinsConfig({}) });
  assert.equal(calls, afterFirst);
});

test("a coin not yet on DEX Screener gets a lower-bound volume from its bonding curve", async () => {
  resetNewCoinsCache();
  const fetchImpl = client({ coins: [coin("MintCurveCurveCurveCurveCurveCurveCurvepump", "CURVE", 1, 30_000, { real_sol_reserves: 60e9 })], pairs: [pair("OtherOtherOtherOtherOtherOtherOtherOtherpump", "OTH", 5_000)] });
  const { tokens } = await getNewCoins({ fetchImpl, now: NOW, config: newCoinsConfig({}) });
  const curve = tokens[0];
  assert.equal(curve.synthetic, true);
  assert.equal(curve.volumeEstimated, true);
  assert.equal(Math.round(curve.volume24h), Math.round(60 * 120));
  assert.equal(curve.quality.checks.find(check => check.id === "volume24h").ok, false);
});
