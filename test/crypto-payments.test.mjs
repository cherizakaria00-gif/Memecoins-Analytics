import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";
import { hasAccess } from "../src/billing.mjs";
import { ASSETS, CryptoPaymentError, availableMethods, createCryptoPayments, paymentAddresses, qrPayload, quoteAmount, validateTxHash } from "../src/crypto-payments.mjs";

const NOW = 1_800_000_000_000;
const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_ADDRESS = "0x1234567890abcdef1234567890ABCDEF12345678";

function setup(addresses = { solana: SOL_ADDRESS, ethereum: EVM_ADDRESS, polygon: EVM_ADDRESS, bsc: EVM_ADDRESS }) {
  const store = openStore(":memory:");
  store.createUser({ id: "u1", email: "buyer@x.co", passwordHash: "x", now: NOW });
  store.createUser({ id: "u2", email: "other@x.co", passwordHash: "x", now: NOW });
  let clock = NOW;
  const service = createCryptoPayments({ store, addresses, getSolUsd: async () => 125, now: () => clock });
  return { store, service, advance: ms => { clock += ms; }, user: store.userById("u1") };
}

test("addresses come from the environment and EVM chains can share one", () => {
  assert.deepEqual(paymentAddresses({ PAY_ADDRESS_SOLANA: SOL_ADDRESS, PAY_ADDRESS_EVM: EVM_ADDRESS }), { solana: SOL_ADDRESS, ethereum: EVM_ADDRESS, polygon: EVM_ADDRESS, bsc: EVM_ADDRESS });
  assert.deepEqual(paymentAddresses({ PAY_ADDRESS_SOLANA: "nope", PAY_ADDRESS_EVM: "0x12" }), { solana: null, ethereum: null, polygon: null, bsc: null });
  const only = availableMethods({ solana: SOL_ADDRESS, ethereum: null, polygon: EVM_ADDRESS, bsc: null }).map(method => `${method.asset}:${method.network}`);
  assert.deepEqual(only, ["SOL:solana", "USDT:solana", "USDT:polygon", "USDC:solana", "USDC:polygon"]);
});

test("amounts: $20 in stablecoins with the right decimals, converted at the SOL rate otherwise", () => {
  assert.deepEqual(quoteAmount({ asset: "USDT", network: "ethereum" }), { amount: "20.00", raw: "20000000", usdCents: 2000 });
  assert.equal(quoteAmount({ asset: "USDC", network: "bsc" }).raw, "20000000000000000000");
  assert.deepEqual(quoteAmount({ asset: "SOL", network: "solana", solUsd: 125 }), { amount: "0.1600", raw: "160000000", usdCents: 2000 });
  assert.equal(quoteAmount({ asset: "SOL", network: "solana", solUsd: 130 }).amount, "0.1539");
  assert.throws(() => quoteAmount({ asset: "SOL", network: "solana", solUsd: 0 }), error => error.status === 503);
  assert.throws(() => quoteAmount({ asset: "SOL", network: "polygon", solUsd: 100 }), CryptoPaymentError);
  assert.equal(ASSETS.USDT.polygon.decimals, 6);
});

test("QR payloads follow Solana Pay and EIP-681", () => {
  const sol = qrPayload({ asset: "SOL", network: "solana", address: SOL_ADDRESS, amount: "0.1600", raw: "160000000", reference: "PULSE-AB12" });
  assert.match(sol, new RegExp(`^solana:${SOL_ADDRESS}\\?`));
  assert.match(sol, /amount=0\.1600/);
  assert.match(sol, /memo=PULSE-AB12/);
  assert.doesNotMatch(sol, /spl-token/);
  assert.match(qrPayload({ asset: "USDC", network: "solana", address: SOL_ADDRESS, amount: "20.00", raw: "20000000", reference: "R" }), /spl-token=EPjFWdd5/);
  assert.equal(qrPayload({ asset: "USDT", network: "ethereum", address: EVM_ADDRESS, amount: "20.00", raw: "20000000", reference: "R" }), `ethereum:0xdAC17F958D2ee523a2206206994597C13D831ec7/transfer?address=${EVM_ADDRESS}&uint256=20000000`);
  assert.match(qrPayload({ asset: "USDT", network: "polygon", address: EVM_ADDRESS, amount: "20.00", raw: "20000000", reference: "R" }), /@137\/transfer/);
  assert.match(qrPayload({ asset: "USDC", network: "bsc", address: EVM_ADDRESS, amount: "20.00", raw: "20000000000000000000", reference: "R" }), /@56\/transfer.*uint256=20000000000000000000$/);
});

test("transaction hashes are validated per chain", () => {
  assert.equal(validateTxHash("ethereum", `0x${"A".repeat(64)}`), `0x${"a".repeat(64)}`);
  assert.equal(validateTxHash("polygon", "0x123"), null);
  assert.equal(validateTxHash("solana", "5".repeat(88)), "5".repeat(88));
  assert.equal(validateTxHash("solana", `0x${"a".repeat(64)}`), null);
  assert.equal(validateTxHash("nowhere", "x"), null);
});

test("a request is created once per method, limited per day and refused to Stripe subscribers", async () => {
  const { store, service, user } = setup();
  const first = await service.createRequest(user, { asset: "USDT", network: "polygon" });
  assert.equal(first.amount, "20.00");
  assert.equal(first.address, EVM_ADDRESS);
  assert.match(first.reference, /^PULSE-[0-9A-F]{8}$/);
  assert.equal((await service.createRequest(user, { asset: "USDT", network: "polygon" })).id, first.id, "the open request is reused");
  await assert.rejects(service.createRequest(user, { asset: "USDT", network: "solana" }).then(() => service.createRequest(user, { asset: "BTC", network: "solana" })), CryptoPaymentError);
  store.saveSubscription({ userId: "u2", status: "active", currentPeriodEnd: NOW + 1e9, now: NOW, provider: "stripe" });
  await assert.rejects(service.createRequest(store.userById("u2"), { asset: "USDC", network: "solana" }), error => error.status === 409);
  const unconfigured = setup({ solana: null, ethereum: null, polygon: null, bsc: null });
  await assert.rejects(unconfigured.service.createRequest(unconfigured.user, { asset: "USDT", network: "polygon" }), CryptoPaymentError);
});

test("submitting a transaction: ownership, format and duplicates", async () => {
  const { service, user, store } = setup();
  const { id } = await service.createRequest(user, { asset: "USDT", network: "ethereum" });
  assert.throws(() => service.submit(store.userById("u2"), id, `0x${"a".repeat(64)}`), error => error.status === 404);
  assert.throws(() => service.submit(user, id, "0xnope"), /invalide/);
  const submitted = service.submit(user, id, `0x${"B".repeat(64)}`);
  assert.equal(submitted.status, "submitted");
  assert.match(submitted.explorer, /^https:\/\/etherscan\.io\/tx\/0xb/);
  const other = await service.createRequest(store.userById("u2"), { asset: "USDT", network: "ethereum" });
  assert.throws(() => service.submit(store.userById("u2"), other.id, `0x${"b".repeat(64)}`), error => error.status === 409);
});

test("approving grants 30 days, extends a valid period, books revenue and then expires", async () => {
  const { service, user, store, advance } = setup();
  const { id } = await service.createRequest(user, { asset: "USDC", network: "polygon" });
  service.submit(user, id, `0x${"c".repeat(64)}`);
  const approved = service.approve(store.cryptoRequest(id), { adminEmail: "boss@x.co" });
  assert.equal(approved.status, "approved");
  const sub = store.subscription("u1");
  assert.equal(sub.provider, "crypto");
  assert.equal(sub.current_period_end, NOW + 30 * 86_400_000);
  assert.equal(hasAccess({ user, subscription: sub, now: NOW + 29 * 86_400_000 }), true);
  assert.equal(hasAccess({ user, subscription: sub, now: NOW + 31 * 86_400_000 }), false, "no webhook ends it: the date does");
  assert.equal(store.payments().length, 1);
  assert.equal(store.payments()[0].customer_id, "crypto:u1");
  assert.throws(() => service.approve(store.cryptoRequest(id), { adminEmail: "boss@x.co" }), error => error.status === 409);

  advance(10 * 86_400_000);
  const renewal = await service.createRequest(user, { asset: "USDC", network: "polygon" });
  service.approve(store.cryptoRequest(renewal.id), { days: 30, adminEmail: "boss@x.co" });
  assert.equal(store.subscription("u1").current_period_end, NOW + 60 * 86_400_000, "extends from the end of the current period");
  store.close();
});

test("rejecting leaves the account unchanged and the admin list shows pending first", async () => {
  const { service, user, store } = setup();
  const first = await service.createRequest(user, { asset: "USDT", network: "bsc" });
  const second = await service.createRequest(user, { asset: "USDC", network: "bsc" });
  service.submit(user, second.id, `0x${"d".repeat(64)}`);
  const list = service.adminList();
  assert.deepEqual(list.map(item => item.status), ["submitted", "open"]);
  assert.equal(list[0].email, "buyer@x.co");
  assert.equal(service.reject(store.cryptoRequest(first.id), { note: "montant incorrect", adminEmail: "boss@x.co" }).status, "rejected");
  assert.equal(store.subscription("u1"), null);
  assert.equal(store.pendingCryptoCount(), 1);
  store.close();
});

test("the SOL request uses the current rate and expires faster than stablecoins", async () => {
  const { service, user } = setup();
  const sol = await service.createRequest(user, { asset: "SOL", network: "solana" });
  const stable = await service.createRequest(user, { asset: "USDT", network: "solana" });
  assert.equal(sol.amount, "0.1600");
  assert.equal(sol.expiresAt - NOW, 30 * 60_000);
  assert.equal(stable.expiresAt - NOW, 60 * 60_000);
  assert.equal(stable.contract, ASSETS.USDT.solana.mint);
});
