import test from "node:test";
import assert from "node:assert/strict";
import { MAX_VALUE_BYTES, sanitizeState } from "../src/user-state.mjs";

test("keeps only pulse-* string values", () => {
  assert.deepEqual(sanitizeState({ keys: { "pulse-wallet": "{}", "pulse-fee-mode": "auto", other: "x", "pulse-bad key": "x", "pulse-num": 5, "__proto__": "x" } }), { "pulse-wallet": "{}", "pulse-fee-mode": "auto" });
});

test("rejects malformed and oversized state", () => {
  assert.throws(() => sanitizeState(null), TypeError);
  assert.throws(() => sanitizeState({ keys: [] }), TypeError);
  assert.throws(() => sanitizeState({ keys: { "pulse-big": "x".repeat(MAX_VALUE_BYTES + 1) } }), RangeError);
  const many = Object.fromEntries(Array.from({ length: 31 }, (_, index) => [`pulse-k${index}`, "1"]));
  assert.throws(() => sanitizeState({ keys: many }), RangeError);
  const total = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`pulse-t${index}`, "x".repeat(250_000)]));
  assert.throws(() => sanitizeState({ keys: total }), /too large/);
});
