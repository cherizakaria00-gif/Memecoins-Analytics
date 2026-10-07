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
