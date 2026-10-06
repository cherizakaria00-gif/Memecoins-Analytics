import test from "node:test";
import assert from "node:assert/strict";
import { LiveTradingError, SOL_MINT, checkFeeAccount, getPortfolio, getSignatureState, liveConfig, parseOrder, prepareSwap } from "../src/live-trading.mjs";

const USER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const config = { ...liveConfig({}), maxOrderSol: 2 };
const buy = { side: "buy", mint: MINT, userPublicKey: USER, amountSol: 0.5, slippageBps: 1500, prioritySol: 0.004 };
const rejects = (input, pattern) => assert.throws(() => parseOrder(input, config), error => error instanceof LiveTradingError && pattern.test(error.message));

test("normalizes a buy and a sell order", () => {
  assert.deepEqual(parseOrder(buy, config), { side: "buy", mint: MINT, userPublicKey: USER, slippageBps: 1500, priorityLamports: 4_000_000, amount: "500000000" });
  const sell = parseOrder({ side: "sell", mint: MINT, userPublicKey: USER, amountRaw: "123456789", slippageBps: 2000, prioritySol: 0 }, config);
  assert.equal(sell.amount, "123456789");
  assert.equal(sell.priorityLamports, 0);
});

test("rejects unsafe or malformed orders", () => {
  rejects({ ...buy, side: "short" }, /Sens/);
  rejects({ ...buy, mint: SOL_MINT }, /Token invalide/);
  rejects({ ...buy, mint: "nope" }, /Token invalide/);
  rejects({ ...buy, userPublicKey: "x" }, /wallet invalide/);
  rejects({ ...buy, amountSol: 3 }, /limite de 2 SOL/);
  rejects({ ...buy, amountSol: 0.0001 }, /minimum/);
  rejects({ ...buy, amountSol: -1 }, /Montant invalide/);
  rejects({ ...buy, slippageBps: 5 }, /Slippage/);
  rejects({ ...buy, slippageBps: 10_000 }, /Slippage/);
  rejects({ ...buy, prioritySol: 1 }, /priorité/);
  rejects({ side: "sell", mint: MINT, userPublicKey: USER, amountRaw: "0", slippageBps: 1000 }, /Quantité/);
  rejects({ side: "sell", mint: MINT, userPublicKey: USER, amountRaw: "1e9", slippageBps: 1000 }, /Quantité/);
});

test("prepares an unsigned swap and summarizes it", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/quote")) return { ok: true, json: async () => ({ inAmount: "500000000", outAmount: "1610000000000", otherAmountThreshold: "1368500000000", priceImpactPct: "0.012", routePlan: [{ swapInfo: { label: "Pump.fun Amm" } }] }) };
    return { ok: true, json: async () => ({ swapTransaction: "AQID", lastValidBlockHeight: 99, prioritizationFeeLamports: 3_999_999, simulationError: null }) };
  };
  const result = await prepareSwap(buy, { config, fetchImpl, now: 5 });
  assert.equal(result.transaction, "AQID");
  assert.deepEqual(result.summary.routes, ["Pump.fun Amm"]);
  assert.equal(result.summary.priceImpactPct, 1.2);
  assert.equal(result.summary.minOutAmount, "1368500000000");
  assert.equal(result.summary.simulationError, null);
  const quoteUrl = new URL(calls[0].url);
  assert.equal(quoteUrl.searchParams.get("inputMint"), SOL_MINT);
  assert.equal(quoteUrl.searchParams.get("outputMint"), MINT);
  assert.equal(quoteUrl.searchParams.get("amount"), "500000000");
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.userPublicKey, USER);
  assert.equal(body.prioritizationFeeLamports, 4_000_000);
  assert.equal(body.wrapAndUnwrapSol, true);
});

test("surfaces missing routes, simulation errors and the kill switch", async () => {
  const noRoute = async () => ({ ok: false, json: async () => ({ error: "Could not find any route" }) });
  await assert.rejects(prepareSwap(buy, { config, fetchImpl: noRoute }), error => error.status === 422 && /Aucune route/.test(error.message));
  const failing = async url => (String(url).includes("/quote") ? { ok: true, json: async () => ({ outAmount: "1", inAmount: "1" }) } : { ok: true, json: async () => ({ swapTransaction: "AQID", simulationError: { error: "InsufficientFunds" } }) });
  assert.equal((await prepareSwap(buy, { config, fetchImpl: failing })).summary.simulationError, "InsufficientFunds");
  await assert.rejects(prepareSwap(buy, { config: { ...config, enabled: false }, fetchImpl: failing }), error => error.status === 403);
});

test("reads the wallet portfolio and merges token accounts", async () => {
  const account = (mint, amount, decimals = 6) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "getBalance") return { ok: true, json: async () => ({ result: { value: 2_500_000_000 } }) };
    const legacy = body.params[1].programId.startsWith("Tokenkeg");
    return { ok: true, json: async () => ({ result: { value: legacy ? [account(MINT, "1000"), account(MINT, "500"), account("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "0")] : [account("Ew8KqgSitYucieR5KnSAL2SUFspcwA8AgSuZ5xWspump", "42")] } }) };
  };
  const portfolio = await getPortfolio(USER, { config, fetchImpl });
  assert.equal(portfolio.sol, 2.5);
  assert.deepEqual(portfolio.tokens.map(token => [token.mint.slice(0, 4), token.raw]).sort(), [["DezX", "1500"], ["Ew8K", "42"]]);
  await assert.rejects(getPortfolio("bad", { config, fetchImpl }), LiveTradingError);
});

test("reports the state of a transaction signature", async () => {
  const signature = "5".repeat(88);
  const respond = value => async () => ({ ok: true, json: async () => ({ result: { value: [value] } }) });
  assert.deepEqual(await getSignatureState(signature, { config, fetchImpl: respond(null) }), { state: "pending" });
  assert.deepEqual(await getSignatureState(signature, { config, fetchImpl: respond({ confirmationStatus: "confirmed", err: null }) }), { state: "confirmed" });
  assert.equal((await getSignatureState(signature, { config, fetchImpl: respond({ err: { InstructionError: [0, "Custom"] } }) })).state, "failed");
  await assert.rejects(getSignatureState("short", { config }), LiveTradingError);
});

const FEE_ACCOUNT = "HBfXgJgBY9tJvDkxk3kxvhsFSWuyqiL2c8s7spPmdYhk";
const feeConfig = { ...config, platformFeeBps: 50, platformFeeAccount: FEE_ACCOUNT };

test("the platform commission is configured from the environment and inactive without a valid account", () => {
  assert.equal(liveConfig({}).platformFeeBps, 0);
  assert.equal(liveConfig({ PLATFORM_FEE_ACCOUNT: "nope" }).platformFeeAccount, null);
  const active = liveConfig({ PLATFORM_FEE_ACCOUNT: FEE_ACCOUNT });
  assert.deepEqual([active.platformFeeBps, active.platformFeeAccount], [50, FEE_ACCOUNT]);
  assert.equal(liveConfig({ PLATFORM_FEE_ACCOUNT: FEE_ACCOUNT, PLATFORM_FEE_BPS: "25" }).platformFeeBps, 25);
  assert.equal(liveConfig({ PLATFORM_FEE_ACCOUNT: FEE_ACCOUNT, PLATFORM_FEE_BPS: "500" }).platformFeeBps, 0, "above 1 %: refused");
  assert.equal(liveConfig({ PLATFORM_FEE_ACCOUNT: FEE_ACCOUNT, PLATFORM_FEE_BPS: "0" }).platformFeeBps, 0);
});

test("a sell carries the 0.5 % commission (paid in SOL) and reports it; buys pay none; Jupiter refusing it falls back to no commission", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/quote")) {
      const withFee = String(url).includes("platformFeeBps=50");
      return { ok: true, json: async () => ({ inAmount: "500000000", outAmount: "9000", otherAmountThreshold: "8500", priceImpactPct: "0.01", routePlan: [], ...(withFee ? { platformFee: { amount: "2500000", feeBps: 50 } } : {}) }) };
    }
    return { ok: true, json: async () => ({ swapTransaction: "dHg=", lastValidBlockHeight: 1 }) };
  };
  const sell = { side: "sell", mint: MINT, userPublicKey: USER, amountRaw: "123456789", slippageBps: 1500, prioritySol: 0 };
  assert.equal((await prepareSwap(buy, { config: feeConfig, fetchImpl })).summary.platformFee, null, "the fee is in the output token: buys pay none");
  calls.length = 0;
  const prepared = await prepareSwap(sell, { config: feeConfig, fetchImpl });
  assert.deepEqual(prepared.summary.platformFee, { bps: 50, lamports: 2_500_000 });
  assert.equal(calls[1].body.feeAccount, FEE_ACCOUNT);
  assert.equal((await prepareSwap(sell, { config, fetchImpl })).summary.platformFee, null, "no account configured: no commission");

  const refusing = async (url, options = {}) => {
    if (String(url).endsWith("/swap") && JSON.parse(options.body).feeAccount) return { ok: false, json: async () => ({ error: "fee account mint mismatch" }) };
    return fetchImpl(url, options);
  };
  const fallback = await prepareSwap(sell, { config: feeConfig, fetchImpl: refusing });
  assert.equal(fallback.summary.platformFee, null);
  assert.equal(fallback.transaction, "dHg=");
});

test("the fee account must be an existing wrapped-SOL token account", async () => {
  const respond = value => async () => ({ ok: true, json: async () => ({ result: { value } }) });
  const wsol = { data: { parsed: { info: { mint: SOL_MINT } } } };
  assert.equal(await checkFeeAccount({ config: feeConfig, fetchImpl: respond(wsol) }), null);
  assert.match(await checkFeeAccount({ config: feeConfig, fetchImpl: respond(null) }), /introuvable/);
  assert.match(await checkFeeAccount({ config: feeConfig, fetchImpl: respond({ data: { parsed: { info: { mint: MINT } } } }) }), /wSOL/);
  assert.equal(await checkFeeAccount({ config, fetchImpl: respond(null) }), null, "no account configured: nothing to check");
  assert.equal(await checkFeeAccount({ config: feeConfig, fetchImpl: async () => { throw new Error("offline"); } }), null, "RPC failure does not disable the fee");
});
