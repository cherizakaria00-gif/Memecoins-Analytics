import assert from "node:assert/strict";
import test from "node:test";
import { _test, fetchJupiterTokens, mapJupiterToken } from "../src/jupiter-client.mjs";
import { evaluateSignal } from "../src/signal.mjs";

const RAW = {
  id: "MintA", holderCount: 1200, organicScore: 64.2, organicScoreLabel: "high", isVerified: false,
  audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 21.5, devBalancePercentage: 0.8 },
  stats1h: { numOrganicBuyers: 40, numNetBuyers: 12, numTraders: 300, buyVolume: 6000, sellVolume: 4000, buyOrganicVolume: 3000, sellOrganicVolume: 1000 }
};

test("maps the Jupiter payload", () => {
  const jup = mapJupiterToken(RAW);
  assert.equal(jup.holderCount, 1200);
  assert.equal(jup.organicScore, 64.2);
  assert.equal(jup.organicVolumeRatio, 0.4);
  assert.equal(jup.topHoldersPct, 21.5);
  assert.equal(mapJupiterToken({}).organicVolumeRatio, null);
});

test("no API key means no request and an empty result", async () => {
  let calls = 0;
  const result = await fetchJupiterTokens(["MintA"], { fetchImpl: async () => { calls++; }, env: {} });
  assert.equal(result.size, 0);
  assert.equal(calls, 0);
});

test("batches mints, sends the key, caches and survives failures", async () => {
  _test.cache.clear();
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, key: init.headers["x-api-key"] }); return { ok: true, json: async () => [RAW] }; };
  const env = { JUPITER_API_KEY: "k" };
  const first = await fetchJupiterTokens(["MintA", "MintB"], { fetchImpl, env, now: 1000 });
  assert.equal(first.get("MintA").holderCount, 1200);
  assert.equal(first.has("MintB"), false);
  assert.match(seen[0].url, /search\?query=MintA,MintB$/);
  assert.equal(seen[0].key, "k");
  await fetchJupiterTokens(["MintA", "MintB"], { fetchImpl, env, now: 20_000 });
  assert.equal(seen.length, 1);
  const failed = await fetchJupiterTokens(["MintC"], { fetchImpl: async () => ({ ok: false, status: 429 }), env, now: 30_000 });
  assert.equal(failed.size, 0);
});

test("an active mint or freeze authority is a hard flag", () => {
  const base = { liquidity: 80_000, marketCap: 200_000, ageMinutes: 300, volume5m: 9_000, volume: 90_000, volume24h: 700_000, buys: 300, sells: 150, buys5m: 40, sells5m: 15, change5m: 3, change: 30, change24h: 100 };
  assert.equal(evaluateSignal({ ...base, jup: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } }).flagCodes.includes("authority"), false);
  const risky = evaluateSignal({ ...base, jup: { mintAuthorityDisabled: true, freezeAuthorityDisabled: false } });
  assert.ok(risky.flagCodes.includes("authority"));
  assert.ok(risky.score <= 39);
});
