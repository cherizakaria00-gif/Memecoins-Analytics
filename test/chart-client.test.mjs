import test from "node:test";
import assert from "node:assert/strict";
import { getCandles, mapCandles } from "../src/chart-client.mjs";

const POOL = "8ewuF2o8ACro7fqWepZ3tKhkbBjndZU4Ldk9scRPw83d";

test("maps newest-first rows to ascending candles and drops bad rows", () => {
  const candles = mapCandles([[200, 2, 3, 1, 2.5, 10], [100, 1, 2, 0.5, 1.5, 5], [100, 1, 2, 0.5, 1.5, 5], [300, "x", 1, 1, 1, 1], [400, 1, 1, 1, 0, 1]]);
  assert.deepEqual(candles.map(candle => candle.time), [100, 200]);
  assert.equal(candles[1].close, 2.5);
});

test("fetches, validates input and caches by pool and timeframe", async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    assert.match(url, /ohlcv\/minute\?aggregate=5/);
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[100, 1, 2, 1, 2, 3]] } } }) };
  };
  assert.equal((await getCandles(POOL, "5m", { fetchImpl, now: 1_000_000 })).length, 1);
  await getCandles(POOL, "5m", { fetchImpl, now: 1_005_000 });
  assert.equal(calls, 1);
  await assert.rejects(getCandles("not a pool", "5m", { fetchImpl }), TypeError);
  await assert.rejects(getCandles(POOL, "2s", { fetchImpl }), TypeError);
});

test("returns no candles for an unindexed pool", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  assert.deepEqual(await getCandles("9vxJ3AwXFZ4Vnnw71H8h2hDSqBDNafV3X73TgKAU9Mzv", "1h", { fetchImpl }), []);
});

test("a 429 backs off globally and serves the last candles instead of failing", async () => {
  const { getCandles, _test } = await import("../src/chart-client.mjs");
  _test.reset();
  const pool = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const ok = { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[1, 1, 2, 1, 1.5, 10]] } } }) };
  let calls = 0;
  const limited = async () => { calls++; return { ok: false, status: 429, headers: new Headers({ "retry-after": "30" }) }; };
  assert.equal((await getCandles(pool, "1m", { fetchImpl: async () => ok, now: 1_000 })).length, 1);
  assert.equal((await getCandles(pool, "1m", { fetchImpl: limited, now: 20_000 })).length, 1);
  assert.equal((await getCandles(pool, "1m", { fetchImpl: limited, now: 40_000 })).length, 1);
  assert.equal(calls, 1);
  await assert.rejects(() => getCandles(pool, "5m", { fetchImpl: limited, now: 41_000 }), /rate limit/);
  _test.reset();
});

test("a chart the user opens waits for the rate limit to clear instead of failing; background refreshes do not wait", async () => {
  const { getCandles, _test } = await import("../src/chart-client.mjs");
  _test.reset();
  const pool = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const ok = { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[1, 1, 2, 1, 1.5, 10]] } } }) };
  const limited = async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "5" }) });
  await assert.rejects(() => getCandles(pool, "1m", { fetchImpl: limited, now: 1_000 }), /rate limit/); // no candles yet: nothing to serve
  const waits = [];
  const candles = await getCandles(pool, "1m", { fetchImpl: async () => ok, now: 2_000, sleepImpl: async ms => { waits.push(ms); } });
  assert.equal(candles.length, 1);
  assert.ok(waits.length === 1 && waits[0] > 3000 && waits[0] <= 5_100);
  _test.reset();
  await assert.rejects(() => getCandles(pool, "1m", { fetchImpl: limited, now: 1_000 }), /rate limit/);
  await assert.rejects(() => getCandles(pool, "5m", { fetchImpl: async () => ok, now: 2_000, background: true, sleepImpl: async () => { throw new Error("must not wait"); } }), /rate limit/);
  _test.reset();
});

test("with a CoinGecko key candles use the keyed API and fall back to the public one when the key is limited or refused", async () => {
  const { getCandles, _test } = await import("../src/chart-client.mjs");
  _test.reset();
  const pool = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const ok = { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[1, 1, 2, 1, 1.5, 10]] } } }) };
  const env = { COINGECKO_API_KEY: "CG-testkey12345" };
  const seen = [];
  const keyedOk = async (url, init) => { seen.push({ url, key: init.headers["x-cg-demo-api-key"] }); return ok; };
  assert.equal((await getCandles(pool, "1m", { fetchImpl: keyedOk, env, now: 1_000 })).length, 1);
  assert.match(seen[0].url, /^https:\/\/api\.coingecko\.com\/api\/v3\/onchain\/networks\/solana\/pools\//);
  assert.equal(seen[0].key, "CG-testkey12345");

  const limitedKey = async (url, init) => (init.headers["x-cg-demo-api-key"] ? { ok: false, status: 429, headers: new Headers() } : ok);
  assert.equal((await getCandles(pool, "5m", { fetchImpl: limitedKey, env, now: 2_000 })).length, 1);

  const refusedKey = async (url, init) => { seen.push({ url }); return init.headers["x-cg-demo-api-key"] ? { ok: false, status: 401, headers: new Headers() } : ok; };
  const before = seen.length;
  await getCandles(pool, "15m", { fetchImpl: refusedKey, env, now: 3_000 });
  await getCandles(pool, "1h", { fetchImpl: refusedKey, env, now: 4_000 });
  const urls = seen.slice(before).map(item => item.url);
  assert.ok(urls[0].includes("api.coingecko.com") && urls[1].includes("api.geckoterminal.com") && urls[2].includes("api.geckoterminal.com") && urls.length === 3); // key disabled after the 401
  _test.reset();
});
