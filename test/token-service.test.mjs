import test from "node:test";
import assert from "node:assert/strict";
import { buildPriceHistory, recordPrices } from "../src/token-service.mjs";

const anchors = [{ t: 0, price: 1 }, { t: 1_000, price: 2 }, { t: 5_000_000, price: 3 }];

test("falls back to reconstructed anchors until real prices are recorded", () => {
  const token = { id: "fresh", price: 3, priceAnchors: anchors };
  recordPrices([token], 10_000_000);
  assert.deepEqual(buildPriceHistory(token), [1, 2, 3]);
});

test("prefixes older anchors to recorded prices and ignores too-frequent samples", () => {
  const token = { id: "tracked", price: 3, priceAnchors: anchors };
  recordPrices([token], 6_000_000);
  recordPrices([{ ...token, price: 3.5 }], 6_001_000);
  recordPrices([{ ...token, price: 4 }], 6_020_000);
  assert.deepEqual(buildPriceHistory(token), [1, 2, 3, 3, 4]);
});

import { updateAthMarketCap } from "../src/token-service.mjs";

test("ATH is the highest of pump.fun, anchors and observed market caps", () => {
  const token = { id: "ath-1", price: 1, marketCap: 1000, athMarketCap: null, priceAnchors: [{ t: 0, price: 2.5 }, { t: 1, price: 1 }] };
  assert.equal(updateAthMarketCap(token), 2500);
  assert.equal(updateAthMarketCap({ ...token, marketCap: 3000, priceAnchors: [] }), 3000);
  assert.equal(updateAthMarketCap({ ...token, marketCap: 500, priceAnchors: [] }), 3000);
  assert.equal(updateAthMarketCap({ ...token, marketCap: 500, athMarketCap: 9000, priceAnchors: [] }), 9000);
  assert.equal(updateAthMarketCap({ id: "none", price: 1, marketCap: null, priceAnchors: [] }), null);
});

import { getHeldTokens } from "../src/token-service.mjs";

test("looks up held tokens directly and caches them briefly", async () => {
  let calls = 0;
  const pair = { chainId: "solana", baseToken: { address: "held-1", name: "Held", symbol: "HLD" }, priceUsd: "0.5", liquidity: { usd: 1000 }, pairAddress: "p" };
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => [pair] }; };
  const first = await getHeldTokens(["held-1"], { fetchImpl, now: 1_000 });
  assert.equal(first[0].price, 0.5);
  assert.equal(first[0].priceAnchors, undefined);
  assert.ok(first[0].signal);
  await getHeldTokens(["held-1"], { fetchImpl, now: 2_000 });
  assert.equal(calls, 1);
  assert.deepEqual(await getHeldTokens(["unknown"], { fetchImpl: async () => ({ ok: true, json: async () => [] }), now: 3_000 }), []);
});

import { enrichToken, getLiveQuotes } from "../src/token-service.mjs";

test("live quotes are cached for a second and carry a dynamic ATH", async () => {
  let calls = 0;
  const pair = (price, mcap) => ({ chainId: "solana", baseToken: { address: "live-1", name: "Live", symbol: "LV" }, priceUsd: String(price), marketCap: mcap, liquidity: { usd: 50_000 }, pairAddress: "pl", priceChange: { h1: 10 }, volume: { h24: 1000 }, txns: { h24: { buys: 5, sells: 5 } } });
  const prices = [[1, 1000], [2, 3000], [1.5, 2000]];
  const fetchImpl = async () => ({ ok: true, json: async () => [pair(...prices[calls++])] });
  const first = await getLiveQuotes(["live-1"], { fetchImpl, now: 5_000_000 });
  assert.equal(first[0].marketCap, 1000);
  await getLiveQuotes(["live-1"], { fetchImpl, now: 5_000_400 });
  assert.equal(calls, 1);
  const second = await getLiveQuotes(["live-1"], { fetchImpl, now: 5_002_000 });
  assert.equal(second[0].athMarketCap, 3000);
  const third = await getLiveQuotes(["live-1"], { fetchImpl, now: 5_004_000 });
  assert.equal(third[0].marketCap, 2000);
  assert.equal(third[0].athMarketCap, 3000);
  assert.deepEqual(await getLiveQuotes(["unknown"], { fetchImpl: async () => ({ ok: true, json: async () => [] }), now: 6_000_000 }), []);
});

test("enriched tokens carry a quality verdict and reuse the last known SOL price", () => {
  const base = { id: "q1", address: "q1", marketCap: 80_000, volume24h: 90_000, liquidity: 50_000, price: 1, priceAnchors: [], ageMinutes: 300 };
  const withSol = enrichToken({ ...base, solPriceUsd: 100 });
  assert.equal(withSol.quality.passes, true);
  const withoutSol = enrichToken({ ...base, id: "q2", address: "q2", solPriceUsd: 0 });
  assert.equal(withoutSol.quality.feesSol, 9);
  const junk = enrichToken({ ...base, id: "q3", address: "q3", marketCap: 5_000, solPriceUsd: 100 });
  assert.equal(junk.quality.passes, false);
  assert.ok(junk.signal.flagCodes.includes("below-minimums"));
  assert.equal(junk.signal.tradable, false);
});

import { getTokenStatuses } from "../src/token-service.mjs";

test("token statuses report the current price, liquidity and Pulse verdict, and skip unknown tokens", async () => {
  const pair = { chainId: "solana", dexId: "raydium", baseToken: { address: "st-1", name: "Status", symbol: "STA" }, quoteToken: { symbol: "SOL" }, priceUsd: "0.5", priceNative: "0.005", marketCap: 120_000, liquidity: { usd: 45_000 }, volume: { h24: 80_000 }, txns: { h24: { buys: 10, sells: 5 } }, pairAddress: "p-st", info: { websites: [{ url: "https://coin.xyz" }], socials: [{ type: "twitter", url: "https://x.com/coin" }] }, pairCreatedAt: 1_000_000 };
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => [pair] }; };
  const [status] = await getTokenStatuses(["st-1", "unknown-1"], { fetchImpl, now: 90_000_000 });
  assert.equal(status.price, 0.5);
  assert.equal(status.liquidity, 45_000);
  assert.equal(status.quality.passes, true);
  assert.deepEqual(await getTokenStatuses(["unknown-1"], { fetchImpl, now: 90_001_000 }), []);
  await getTokenStatuses(["st-1"], { fetchImpl, now: 90_002_000 });
  assert.equal(calls, 1);
});
