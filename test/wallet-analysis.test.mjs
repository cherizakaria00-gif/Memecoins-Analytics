import assert from "node:assert/strict";
import test from "node:test";
import { _test, accountTokens, analyzeWallet, classify, heliusKeyFromRpc, parseHeliusSwap, parseTransaction } from "../src/wallet-analysis.mjs";

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT_A = "CyMZ6T9fvj6AmdbvaXijQoSXb3TjiKAAECz51qPwpump";
const MINT_B = "Fxx9hyFDDxtFet2pa68a4LSBYjBqq6E5dDy8bpcppump";
const MINT_DUST = "7EVSYwZkhqEbdSSrFHBVkLG7y44CuxFdgsQcZH6Bpump";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const RENT = 0.00203928;

/** A transaction where OWNER pays `solSpent` SOL (negative = receives) for `tokens` of `mint`. */
function swap({ time, mint, tokens, sol, newAccount = false, closeAccount = false }) {
  const lamports = 5_000_000_000;
  const delta = Math.round((newAccount ? -RENT : 0) * 1e9) + Math.round((closeAccount ? RENT : 0) * 1e9) - 5000 + Math.round(-sol * 1e9);
  const pre = tokens > 0 && !newAccount ? [{ accountIndex: 2, mint, owner: OWNER, uiTokenAmount: { uiAmountString: "1000" } }] : tokens < 0 ? [{ accountIndex: 2, mint, owner: OWNER, uiTokenAmount: { uiAmountString: String(Math.abs(tokens) + 500) } }] : [];
  const post = closeAccount ? [] : [{ accountIndex: 2, mint, owner: OWNER, uiTokenAmount: { uiAmountString: String((pre[0] ? Number(pre[0].uiTokenAmount.uiAmountString) : 0) + tokens) } }];
  return { blockTime: time / 1000, transaction: { message: { accountKeys: [{ pubkey: OWNER }, { pubkey: "Pool" }] } }, meta: { err: null, fee: 5000, preBalances: [lamports, 1], postBalances: [lamports + delta, 1], preTokenBalances: pre, postTokenBalances: post } };
}
const HOUR = 3_600_000, T0 = 1_760_000_000_000;

test("parseTransaction: removes fee and rent, reads the token change", () => {
  const parsed = parseTransaction(swap({ time: T0, mint: MINT_A, tokens: 5000, sol: 0.5, newAccount: true }), OWNER);
  assert.ok(Math.abs(parsed.sol + 0.5) < 1e-6);
  assert.deepEqual(parsed.tokens.map(token => [token.mint, token.delta]), [[MINT_A, 5000]]);
  assert.equal(parseTransaction({ meta: { err: { InstructionError: [] } } }, OWNER), null);
});

test("classify and accountTokens: realized profit uses average cost, receipts are free", () => {
  const parsed = [
    parseTransaction(swap({ time: T0, mint: MINT_A, tokens: 1000, sol: 1 }), OWNER),
    parseTransaction(swap({ time: T0 + HOUR, mint: MINT_A, tokens: 1000, sol: 3 }), OWNER),
    parseTransaction(swap({ time: T0 + 2 * HOUR, mint: MINT_A, tokens: -1000, sol: -5 }), OWNER),
    parseTransaction(swap({ time: T0 + 3 * HOUR, mint: MINT_B, tokens: 4000, sol: 0 }), OWNER),
    parseTransaction(swap({ time: T0 + 4 * HOUR, mint: MINT_B, tokens: -4000, sol: -2 }), OWNER)
  ];
  const { events } = classify(parsed, 0);
  assert.deepEqual(events.map(event => event.type), ["buy", "buy", "sell", "receive", "sell"]);
  const [a, b] = accountTokens(events).sort((x, y) => x.mint.localeCompare(y.mint));
  const token = Object.fromEntries([a, b].map(item => [item.mint, item]));
  assert.ok(Math.abs(token[MINT_A].realized - 3) < 1e-6); // sold 1000 of 2000 bought for 4 SOL (avg 2): 5 - 2
  assert.ok(Math.abs(token[MINT_A].cost - 2) < 1e-6);
  assert.ok(Math.abs(token[MINT_B].realized - 2) < 1e-6); // received for free, sold for 2
  assert.ok(token[MINT_B].freeProceeds > 1.9);
});

test("analyzeWallet end to end with a fake RPC, prices and rate limiting retries", async () => {
  _test.cache.clear();
  const txs = new Map([
    ["s3", swap({ time: T0 + 2 * HOUR, mint: MINT_A, tokens: -1000, sol: -5 })],
    ["s2", swap({ time: T0 + HOUR, mint: MINT_A, tokens: 1000, sol: 3 })],
    ["s1", swap({ time: T0, mint: MINT_A, tokens: 1000, sol: 1 })],
    ["s0", swap({ time: T0 - HOUR, mint: MINT_B, tokens: 3000, sol: 0 })],
    ["sd", swap({ time: T0 - 2 * HOUR, mint: MINT_DUST, tokens: 200000, sol: 0 })]
  ]);
  let limitedOnce = false;
  const fetchImpl = async (url, init) => {
    if (url.includes("dexscreener")) return { ok: true, status: 200, json: async () => [{ chainId: "solana", dexId: "pumpswap", baseToken: { address: MINT_A, name: "A", symbol: "AAA" }, quoteToken: { symbol: "SOL" }, priceUsd: "0.2", priceNative: "0.001", liquidity: { usd: 50000 }, volume: { h24: 1000 }, marketCap: 1, pairAddress: "p", pairCreatedAt: T0 - 600_000 }, { chainId: "solana", dexId: "pumpswap", baseToken: { address: MINT_B, name: "B", symbol: "BBB" }, quoteToken: { symbol: "SOL" }, priceUsd: "1", priceNative: "0.005", liquidity: { usd: 50000 }, volume: { h24: 1000 }, marketCap: 1, pairAddress: "pb", pairCreatedAt: T0 - 7_200_000 }] };
    const body = JSON.parse(init.body);
    if (body.method === "getSignaturesForAddress") return { ok: true, status: 200, json: async () => ({ result: [...txs.keys()].map(signature => ({ signature, err: null })) }) };
    if (!limitedOnce) { limitedOnce = true; return { ok: false, status: 429, json: async () => ({ error: { code: 429 } }) }; }
    return { ok: true, status: 200, json: async () => ({ result: txs.get(body.params[0]) }) };
  };
  const result = await analyzeWallet(OWNER, { rpcUrl: "http://rpc", fetchImpl, now: T0 + 5 * HOUR, retryDelay: 1 });
  assert.equal(result.coverage.analysed, 5);
  assert.equal(result.coverage.dustTokens, 1);
  assert.equal(result.tokens.some(token => token.mint === MINT_DUST), false);
  assert.equal(result.coverage.failed, 0);
  const a = result.tokens.find(token => token.mint === MINT_A);
  assert.ok(Math.abs(a.realizedSol - 3) < 1e-6);
  assert.equal(a.entryMinutes, 10);
  const b = result.tokens.find(token => token.mint === MINT_B);
  assert.equal(b.free, true);
  assert.ok(result.stats.totalSol >= result.stats.realizedSol - 1e-9 || result.stats.unrealizedSol < 0);
  const cached = await analyzeWallet(OWNER, { rpcUrl: "http://rpc", fetchImpl: async () => { throw new Error("cached"); }, now: T0 + 5 * HOUR + 60_000 });
  assert.equal(cached.at, result.at);
});

test("invalid addresses and RPC limits give clear errors", async () => {
  _test.cache.clear();
  await assert.rejects(() => analyzeWallet("nope", { rpcUrl: "x" }), /invalide/);
  const limited = async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429 } }) });
  await assert.rejects(() => analyzeWallet(OWNER, { rpcUrl: "x", fetchImpl: limited, retryDelay: 1 }), /limite les requêtes/);
});

test("rent is only removed when the wallet really paid it (airdrops are paid by the sender)", () => {
  const airdrop = swap({ time: T0, mint: MINT_A, tokens: 500, sol: 0, newAccount: false });
  airdrop.meta.postTokenBalances = [{ accountIndex: 5, mint: MINT_A, owner: OWNER, uiTokenAmount: { uiAmountString: "500" } }];
  airdrop.meta.preTokenBalances = [];
  airdrop.meta.preBalances = [5_000_000_000, 1]; airdrop.meta.postBalances = [5_000_000_000, 1]; airdrop.meta.fee = 0;
  const parsed = parseTransaction(airdrop, OWNER);
  assert.equal(parsed.sol, 0);
  assert.equal(classify([parsed], 0).events[0].type, "receive");
});

test("Helius: key detection and swap parsing (event swaps and balance-change fallback)", () => {
  assert.equal(heliusKeyFromRpc("https://mainnet.helius-rpc.com/?api-key=abc-123"), "abc-123");
  assert.equal(heliusKeyFromRpc("https://api.mainnet-beta.solana.com"), null);
  assert.equal(heliusKeyFromRpc("not a url"), null);
  const sell = parseHeliusSwap({ timestamp: 1000, events: { swap: { nativeInput: null, nativeOutput: { account: OWNER, amount: "2500000000" }, tokenInputs: [{ userAccount: OWNER, mint: MINT_A, rawTokenAmount: { tokenAmount: "50000000", decimals: 6 } }], tokenOutputs: [] } } }, OWNER);
  assert.equal(sell.sol, 2.5);
  assert.deepEqual(sell.tokens, [{ mint: MINT_A, delta: -50 }]);
  const buy = parseHeliusSwap({ timestamp: 1000, fee: 5000, feePayer: OWNER, accountData: [
    { account: OWNER, nativeBalanceChange: -1_000_005_000, tokenBalanceChanges: [] },
    { account: "ata", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: OWNER, mint: MINT_A, rawTokenAmount: { tokenAmount: "7000000", decimals: 6 } }, { userAccount: "someone", mint: MINT_B, rawTokenAmount: { tokenAmount: "1", decimals: 0 } }] }] }, OWNER);
  assert.ok(Math.abs(buy.sol + 1) < 1e-9);
  assert.deepEqual(buy.tokens, [{ mint: MINT_A, delta: 7 }]);
  assert.equal(classify([buy], 0).events[0].type, "buy");
  assert.equal(parseHeliusSwap({ timestamp: 1 }, OWNER), null);
});

test("with a Helius URL the analyzer uses enhanced transactions and reports sales whose cost is unknown", async () => {
  _test.cache.clear();
  const page = [
    { timestamp: T0 / 1000 + 3600, signature: "b", events: { swap: { nativeOutput: { account: OWNER, amount: "4000000000" }, tokenInputs: [{ userAccount: OWNER, mint: MINT_B, rawTokenAmount: { tokenAmount: "1000", decimals: 0 } }], tokenOutputs: [] } } },
    { timestamp: T0 / 1000, signature: "a", events: { swap: { nativeInput: { account: OWNER, amount: "1000000000" }, tokenOutputs: [{ userAccount: OWNER, mint: MINT_A, rawTokenAmount: { tokenAmount: "1000", decimals: 0 } }], tokenInputs: [] } } }
  ];
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.includes("api.helius.xyz")) return { ok: true, status: 200, json: async () => page };
    return { ok: true, status: 200, json: async () => [] };
  };
  const result = await analyzeWallet(OWNER, { rpcUrl: "https://mainnet.helius-rpc.com/?api-key=KEY1", fetchImpl, now: T0 + 5 * HOUR });
  assert.equal(result.coverage.source, "helius");
  assert.equal(result.coverage.analysed, 2);
  assert.match(urls[0], /api\.helius\.xyz\/v0\/addresses\/.*type=SWAP/);
  assert.ok(Math.abs(result.stats.unknownCostProceedsSol - 4) < 1e-9);
  assert.ok(result.notes.includes("older-history"));
});
