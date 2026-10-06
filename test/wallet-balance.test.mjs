import test from "node:test";
import assert from "node:assert/strict";
import { getSolBalance, isValidSolanaAddress } from "../src/wallet-balance.mjs";

const ADDRESS = "83astBRguLMdt2h5U1Tpdq5tjFoJ6noeGwaY3mDLVcri";

test("validates base58 Solana public keys", () => {
  assert.equal(isValidSolanaAddress(ADDRESS), true);
  assert.equal(isValidSolanaAddress("../../etc/passwd"), false);
  assert.equal(isValidSolanaAddress("0OIl-not-base58"), false);
});

test("requests a confirmed balance and converts lamports to SOL", async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async () => ({ result: { value: 2_500_000_000 } }) };
  };
  const balance = await getSolBalance(ADDRESS, { fetchImpl, rpcUrl: "https://rpc.example" });
  assert.equal(requestBody.method, "getBalance");
  assert.equal(requestBody.params[0], ADDRESS);
  assert.equal(balance.sol, 2.5);
});

test("rejects malformed RPC balances", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { value: "oops" } }) });
  await assert.rejects(() => getSolBalance(ADDRESS, { fetchImpl }), /Invalid balance/);
});
