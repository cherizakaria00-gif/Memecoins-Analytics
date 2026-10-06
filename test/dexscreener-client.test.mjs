import test from "node:test";
import assert from "node:assert/strict";
import { fetchLiveSolanaTokens, mapPairToToken } from "../src/dexscreener-client.mjs";

const NOW = 1_800_000_000_000;
const pair = {
  chainId: "solana",
  dexId: "raydium",
  url: "https://dexscreener.com/solana/pair-a",
  pairAddress: "pair-a",
  baseToken: { address: "token-a", name: "Alpha Coin", symbol: "ALPHA" },
  priceUsd: "0.0025",
  txns: { h1: { buys: 120, sells: 40 }, h24: { buys: 900, sells: 600 } },
  volume: { h1: 90_000, h24: 640_000 },
  priceChange: { m5: 1.5, h1: 24, h6: 82, h24: 310 },
  liquidity: { usd: 180_000 },
  marketCap: 2_500_000,
  pairCreatedAt: NOW - 120 * 60_000
};

test("maps a market pair without inventing audit data", () => {
  const token = mapPairToToken(pair, NOW);
  assert.equal(token.name, "Alpha Coin");
  assert.equal(token.age, "2 h 00");
  assert.equal(token.mint, null);
  assert.equal(token.risk, "Non audité");
  assert.equal(token.marketCap, 2_500_000);
  assert.equal(token.transactions, 1_500);
  assert.equal(token.volume24h, 640_000);
  assert.equal(token.change5m, 1.5);
  assert.equal(token.change6h, 82);
  assert.equal(token.change24h, 310);
  assert.equal(token.traders, null);
  assert.ok(token.score > 60);
});

test("merges candidate lists, keeps the most liquid pair and ranks by 24h volume", async () => {
  const lessLiquid = { ...pair, pairAddress: "pair-b", liquidity: { usd: 20_000 } };
  const other = { ...pair, pairAddress: "pair-c", baseToken: { address: "token-c", name: "Gamma", symbol: "GAM" }, volume: { h24: 2_000_000 } };
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.includes("token-boosts/latest")) return { ok: true, json: async () => [{ chainId: "solana", tokenAddress: "token-a" }, { chainId: "ethereum", tokenAddress: "ignored" }] };
    if (url.includes("token-boosts/top")) return { ok: true, json: async () => [{ chainId: "solana", tokenAddress: "token-a" }] };
    if (url.includes("token-profiles")) return { ok: true, json: async () => [{ chainId: "solana", tokenAddress: "token-c" }] };
    return { ok: true, json: async () => [lessLiquid, pair, other] };
  };
  const tokens = await fetchLiveSolanaTokens({ fetchImpl, now: NOW });
  assert.deepEqual(tokens.map(token => token.address), ["token-c", "token-a"]);
  assert.equal(tokens[1].pairAddress, "pair-a");
  assert.equal(urls.filter(url => url.includes("/tokens/v1/")).length, 1);
});

test("survives one failing candidate list", async () => {
  const fetchImpl = async url => {
    if (url.includes("token-boosts/top")) return { ok: false, status: 500 };
    if (url.includes("token-boosts/latest")) return { ok: true, json: async () => [{ chainId: "solana", tokenAddress: "token-a" }] };
    if (url.includes("token-profiles")) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => [pair] };
  };
  const tokens = await fetchLiveSolanaTokens({ fetchImpl, now: NOW });
  assert.equal(tokens.length, 1);
});

test("only keeps token images served by the DEX Screener CDN", () => {
  const withImage = info => mapPairToToken({ ...pair, info }, NOW).imageUrl;
  assert.match(withImage({ imageUrl: "https://cdn.dexscreener.com/cms/images/x?width=800" }), /width=128/);
  assert.equal(withImage({ imageUrl: "https://evil.example/x.png" }), null);
  assert.equal(withImage({ imageUrl: "http://cdn.dexscreener.com/x.png" }), null);
  assert.equal(withImage(undefined), null);
});

test("enriches tokens with pump.fun data and adjusts the signal", async () => {
  const pumpCoin = { mint: "token-a", complete: true, ath_market_cap: 3_000_000, reply_count: 80, twitter: "https://x.com/a" };
  const fetchImpl = async url => {
    if (url.includes("frontend-api-v3.pump.fun")) return { ok: true, json: async () => [pumpCoin] };
    if (url.includes("token-boosts") || url.includes("token-profiles")) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => [pair] };
  };
  const [token] = await fetchLiveSolanaTokens({ fetchImpl, now: NOW });
  assert.equal(token.address, "token-a");
  assert.equal(token.pump.graduated, true);
  assert.equal(token.athMarketCap, 3_000_000);
  assert.ok(token.score > mapPairToToken(pair, NOW).score);
  assert.ok(token.priceAnchors.length >= 3);
});

test("a pump.fun outage does not break the feed", async () => {
  const fetchImpl = async url => {
    if (url.includes("frontend-api-v3.pump.fun")) return { ok: false, status: 429 };
    if (url.includes("token-boosts/latest")) return { ok: true, json: async () => [{ chainId: "solana", tokenAddress: "token-a" }] };
    if (url.includes("token-boosts") || url.includes("token-profiles")) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => [pair] };
  };
  const tokens = await fetchLiveSolanaTokens({ fetchImpl, now: NOW });
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].pump, null);
});

import { searchSolanaTokens } from "../src/dexscreener-client.mjs";

test("search keeps solana pairs only, best liquidity per token, most liquid first", async () => {
  const other = { ...pair, chainId: "ethereum", baseToken: { address: "eth-token", name: "Eth", symbol: "ETH" } };
  const small = { ...pair, pairAddress: "pair-small", liquidity: { usd: 5_000 } };
  const second = { ...pair, pairAddress: "pair-z", baseToken: { address: "token-z", name: "Zed", symbol: "ZED" }, liquidity: { usd: 900_000 } };
  const fetchImpl = async url => {
    assert.match(url, /latest\/dex\/search\?q=al%20pha/);
    return { ok: true, json: async () => ({ pairs: [small, pair, other, second] }) };
  };
  const tokens = await searchSolanaTokens("al pha", { fetchImpl, now: NOW });
  assert.deepEqual(tokens.map(token => token.address), ["token-z", "token-a"]);
  assert.equal(tokens[1].pairAddress, "pair-a");
});
