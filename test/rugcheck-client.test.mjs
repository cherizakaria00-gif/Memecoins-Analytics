import assert from "node:assert/strict";
import test from "node:test";
import { _test, fetchRugChecks, mapRugCheck } from "../src/rugcheck-client.mjs";
import { evaluateSignal } from "../src/signal.mjs";

const RAW = { risks: [{ name: "Creator history of rugged tokens", level: "danger" }, { name: "Low Liquidity", level: "warn" }, { name: "Info", level: "info" }], score_normalised: 80, lpLockedPct: 100 };
const base = { liquidity: 80_000, marketCap: 200_000, ageMinutes: 300, volume5m: 9_000, volume: 90_000, volume24h: 700_000, transactions: 4000, buys: 300, sells: 150, buys5m: 40, sells5m: 15, change5m: 3, change: 30, change24h: 100 };

test("maps danger and warning risks", () => {
  assert.deepEqual(mapRugCheck(RAW), { danger: ["Creator history of rugged tokens"], warnings: ["Low Liquidity"], score: 80, lpLockedPct: 100 });
  assert.deepEqual(mapRugCheck({}), { danger: [], warnings: [], score: null, lpLockedPct: null });
});

test("fetches with limited concurrency, caches and treats failures as unavailable", async () => {
  _test.cache.clear();
  let active = 0, peak = 0, calls = 0;
  const fetchImpl = async url => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return url.includes("BAD") ? { ok: false, status: 500 } : { ok: true, json: async () => RAW };
  };
  const mints = ["A1", "A2", "A3", "A4", "A5", "A6", "BAD"];
  const result = await fetchRugChecks(mints, { fetchImpl, now: 1000, env: {} });
  assert.equal(result.size, 6);
  assert.equal(result.has("BAD"), false);
  assert.ok(peak <= 4);
  await fetchRugChecks(mints, { fetchImpl, now: 2000, env: {} });
  assert.equal(calls, 7);
  assert.equal((await fetchRugChecks(["A1"], { fetchImpl, env: { RUGCHECK: "0" } })).size, 0);
});

test("danger risks, one-sided buying and fake volume are hard flags", () => {
  assert.equal(evaluateSignal({ ...base, rug: { danger: [], warnings: [] } }).flagCodes.length, 0);
  const rugged = evaluateSignal({ ...base, rug: { danger: ["Creator history of rugged tokens"], warnings: [] } });
  assert.ok(rugged.flagCodes.includes("rugcheck") && rugged.score <= 39);
  assert.ok(evaluateSignal({ ...base, buys: 400, sells: 8 }).flagCodes.includes("one-sided-buys"));
  assert.equal(evaluateSignal({ ...base, buys: 40, sells: 30 }).flagCodes.includes("one-sided-buys"), false);
  assert.ok(evaluateSignal({ ...base, transactions: 6, volume24h: 50_000 }).flagCodes.includes("few-txns"));
});
