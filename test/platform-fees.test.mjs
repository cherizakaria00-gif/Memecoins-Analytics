import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";

test("platform fees are recorded when prepared and only counted once confirmed", () => {
  const store = openStore(":memory:");
  store.createUser({ id: "u1", email: "a@x.co", passwordHash: "x", now: 1 });
  store.createUser({ id: "u2", email: "b@x.co", passwordHash: "x", now: 1 });
  store.recordPreparedFee({ id: "o1", userId: "u1", side: "buy", mint: "M", bps: 50, feeLamports: 2_500_000, now: 100 });
  store.recordPreparedFee({ id: "o2", userId: "u1", side: "sell", mint: "M", bps: 50, feeLamports: 1_000_000, now: 101 });
  assert.deepEqual(store.feeTotals(0), { count: 0, lamports: 0 });
  assert.equal(store.settleFee({ id: "o1", userId: "u2", status: "confirmed", signature: "s", now: 200 }), false, "another user cannot settle it");
  assert.equal(store.settleFee({ id: "o1", userId: "u1", status: "confirmed", signature: "s1", now: 200 }), true);
  assert.equal(store.settleFee({ id: "o1", userId: "u1", status: "confirmed", signature: "s1", now: 201 }), false, "only once");
  assert.equal(store.settleFee({ id: "o2", userId: "u1", status: "failed", now: 202 }), true);
  assert.deepEqual(store.feeTotals(0), { count: 1, lamports: 2_500_000 });
  assert.deepEqual(store.feeTotals(300), { count: 0, lamports: 0 });
  assert.deepEqual(store.recentFees(5).map(fee => [fee.id, fee.email]), [["o1", "a@x.co"]]);
  store.close();
});
