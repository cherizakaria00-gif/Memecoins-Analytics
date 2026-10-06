import test from "node:test";
import assert from "node:assert/strict";
import { getMintSecurity } from "../src/token-security.mjs";

const MINT = "Ew8KqgSitYucieR5KnSAL2SUFspcwA8AgSuZ5xWspump";
const rpc = value => async () => ({ ok: true, json: async () => ({ result: { value } }) });

test("reads revoked mint and freeze authorities", async () => {
  const fetchImpl = rpc({ data: { parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 6 } } } });
  assert.deepEqual(await getMintSecurity(MINT, { fetchImpl, now: 1 }), { mintRevoked: true, freezeRevoked: true, decimals: 6 });
});

test("flags active authorities and ignores non-mint accounts", async () => {
  const active = rpc({ data: { parsed: { type: "mint", info: { mintAuthority: "Auth1111111111111111111111111111111111111", freezeAuthority: null, decimals: 9 } } } });
  assert.deepEqual(await getMintSecurity("So11111111111111111111111111111111111111112", { fetchImpl: active, now: 1 }), { mintRevoked: false, freezeRevoked: true, decimals: 9 });
  assert.equal(await getMintSecurity("EnPjBjzy6zaufzpZ2m3Q8nPS3KpyiRxNLKtcSiMYwWCa", { fetchImpl: rpc({ data: { parsed: { type: "account" } } }), now: 1 }), null);
  assert.equal(await getMintSecurity("GMqwf2ct8runQarHgHxkbXgcMBJzwjVoL525ZLCAFLB2", { fetchImpl: rpc(null), now: 1 }), null);
});

test("caches results, validates input and surfaces RPC errors", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ result: { value: { data: { parsed: { type: "mint", info: { mintAuthority: null, freezeAuthority: null, decimals: 0 } } } } } }) }; };
  const mint = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  await getMintSecurity(mint, { fetchImpl, now: 100 });
  await getMintSecurity(mint, { fetchImpl, now: 200 });
  assert.equal(calls, 1);
  await assert.rejects(getMintSecurity("bad", { fetchImpl }), TypeError);
  await assert.rejects(getMintSecurity("4y2T1ghykCTq4EddoXjptZamk4qAsqcZw6eKxS8jdvE1", { fetchImpl: async () => ({ ok: false, status: 429 }), now: 1 }), /HTTP 429/);
});
