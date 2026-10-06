import test from "node:test";
import assert from "node:assert/strict";
import { extractMints, fetchActiveMints } from "../src/geckoterminal-client.mjs";

const MINT_A = "5tCju6YNxHq5zrA6tGndr6F7TK42mpUFmeE31cSFpump";
const MINT_B = "HcRLc9xwL5Zq8bY2n3VtKd7mPfJ4sAeUgXoWiRhCq1Nz";
const pool = mint => ({ relationships: { base_token: { data: { id: `solana_${mint}` } } } });

test("extracts valid solana base-token mints only", () => {
  const mints = extractMints({ data: [pool(MINT_A), pool("bad"), { relationships: {} }, { relationships: { base_token: { data: { id: `eth_${MINT_B}` } } } }] });
  assert.deepEqual(mints, [MINT_A]);
  assert.deepEqual(extractMints(null), []);
});

test("merges lists, survives failures and caches", async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    if (url.includes("new_pools")) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ data: [pool(MINT_A), pool(url.includes("duration=24h") ? MINT_B : MINT_A)] }) };
  };
  const mints = await fetchActiveMints({ fetchImpl, now: 10_000_000 });
  assert.deepEqual(mints.sort(), [MINT_A, MINT_B].sort());
  const first = calls;
  await fetchActiveMints({ fetchImpl, now: 10_010_000 });
  assert.equal(calls, first);
});
