import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { openStore } from "../src/db.mjs";
import { PLAN, applyStripeEvent, createBilling, describeAccess, hasAccess, toForm, verifyStripeSignature } from "../src/billing.mjs";

const NOW = 1_800_000_000_000;
const SECRET = "whsec_test";
const sign = (body, timestamp = Math.floor(NOW / 1000)) => `t=${timestamp},v1=${createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex")}`;

function setup() {
  const store = openStore(":memory:");
  store.createUser({ id: "u1", email: "a@b.co", passwordHash: "x", now: NOW });
  return store;
}

test("the plan costs $20 per month", () => {
  assert.deepEqual([PLAN.priceCents, PLAN.currency, PLAN.interval], [2000, "usd", "month"]);
});

test("encodes nested bodies for Stripe", () => {
  const form = toForm({ mode: "subscription", line_items: [{ quantity: 1, price_data: { currency: "usd", recurring: { interval: "month" } } }], skip: null }).join("&");
  assert.match(form, /mode=subscription/);
  assert.match(form, /line_items%5B0%5D%5Bprice_data%5D%5Brecurring%5D%5Binterval%5D=month/);
  assert.doesNotMatch(form, /skip/);
});

test("verifies webhook signatures, rejecting forgeries and old timestamps", () => {
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(body, sign(body), SECRET, { now: NOW }), true);
  assert.equal(verifyStripeSignature(body + " ", sign(body), SECRET, { now: NOW }), false);
  assert.equal(verifyStripeSignature(body, sign(body), "other", { now: NOW }), false);
  assert.equal(verifyStripeSignature(body, sign(body, Math.floor(NOW / 1000) - 3600), SECRET, { now: NOW }), false);
  assert.equal(verifyStripeSignature(body, "", SECRET, { now: NOW }), false);
  assert.equal(verifyStripeSignature(body, sign(body), "", { now: NOW }), false);
});

test("access rules: active, trialing, short past-due grace, admins, nothing else", () => {
  const user = { email: "a@b.co" };
  const sub = status => ({ status, current_period_end: NOW - 1000 });
  assert.equal(hasAccess({ user, subscription: sub("active"), now: NOW }), true);
  assert.equal(hasAccess({ user, subscription: sub("trialing"), now: NOW }), true);
  assert.equal(hasAccess({ user, subscription: sub("past_due"), now: NOW }), true);
  assert.equal(hasAccess({ user, subscription: { status: "past_due", current_period_end: NOW - 5 * 86_400_000 }, now: NOW }), false);
  for (const status of ["canceled", "incomplete", "unpaid", "none"]) assert.equal(hasAccess({ user, subscription: sub(status), now: NOW }), false, status);
  assert.equal(hasAccess({ user, subscription: null, now: NOW }), false);
  assert.equal(hasAccess({ user, subscription: null, adminEmails: ["a@b.co"], now: NOW }), true);
  assert.equal(describeAccess({ user, subscription: null, adminEmails: ["a@b.co"], now: NOW }).comped, true);
});

test("webhook events activate, update and cancel a subscription, once each", () => {
  const store = setup();
  const checkout = { id: "evt_1", type: "checkout.session.completed", data: { object: { client_reference_id: "u1", customer: "cus_1", subscription: "sub_1", payment_status: "paid" } } };
  assert.equal(applyStripeEvent(store, checkout, NOW), "checkout-completed");
  assert.equal(store.subscription("u1").status, "active");
  assert.equal(applyStripeEvent(store, checkout, NOW), "ignored", "replayed event");

  const update = { id: "evt_2", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "active", current_period_end: 1_803_000_000, cancel_at_period_end: true } } };
  assert.equal(applyStripeEvent(store, update, NOW), "subscription-updated");
  const sub = store.subscription("u1");
  assert.equal(sub.current_period_end, 1_803_000_000_000);
  assert.equal(sub.cancel_at_period_end, 1);
  assert.equal(sub.stripe_customer_id, "cus_1");

  assert.equal(applyStripeEvent(store, { id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", status: "canceled" } } }, NOW), "subscription-deleted");
  assert.equal(store.subscription("u1").status, "canceled");
  assert.equal(applyStripeEvent(store, { id: "evt_4", type: "checkout.session.completed", data: { object: { client_reference_id: "ghost" } } }, NOW), "unknown-user");
  assert.equal(applyStripeEvent(store, { id: "evt_5", type: "charge.refunded", data: { object: {} } }, NOW), "ignored");
  store.close();
});

test("creates a $20 monthly checkout session tied to the user and an optional trial", async () => {
  const store = setup();
  let request;
  const fetchImpl = async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ url: "https://checkout.stripe.test/s" }) }; };
  const billing = createBilling({ store, secretKey: "sk_test", appUrl: "https://pulse.test", trialDays: 7, fetchImpl, now: () => NOW });
  assert.equal(await billing.createCheckout(store.userById("u1")), "https://checkout.stripe.test/s");
  const body = decodeURIComponent(request.options.body);
  assert.match(request.url, /checkout\/sessions$/);
  assert.match(body, /mode=subscription/);
  assert.match(body, /unit_amount\]=2000/);
  assert.match(body, /interval\]=month/);
  assert.match(body, /client_reference_id=u1/);
  assert.match(body, /trial_period_days\]=7/);
  assert.match(body, /customer_email=a@b.co/);
  assert.equal(request.options.headers.authorization, "Bearer sk_test");
  store.close();
});

test("syncing a checkout session grants access only to its owner", async () => {
  const store = setup();
  store.createUser({ id: "u2", email: "c@d.co", passwordHash: "x", now: NOW });
  const session = { client_reference_id: "u1", customer: "cus_9", payment_status: "paid", subscription: { id: "sub_9", status: "active", current_period_end: 1_803_000_000 } };
  const billing = createBilling({ store, secretKey: "sk_test", appUrl: "https://pulse.test", fetchImpl: async () => ({ ok: true, json: async () => session }), now: () => NOW });
  await billing.syncCheckoutSession(store.userById("u1"), "cs_test_123");
  assert.equal(store.subscription("u1").status, "active");
  await assert.rejects(billing.syncCheckoutSession(store.userById("u2"), "cs_test_123"), error => error.status === 403);
  await assert.rejects(billing.syncCheckoutSession(store.userById("u1"), "../evil"), error => error.status === 400);
  store.close();
});

test("the webhook handler rejects bad signatures and the dev shortcut is off by default", () => {
  const store = setup();
  const billing = createBilling({ store, secretKey: "sk_test", webhookSecret: SECRET, appUrl: "https://pulse.test", now: () => NOW });
  const body = JSON.stringify({ id: "evt_9", type: "checkout.session.completed", data: { object: { client_reference_id: "u1", customer: "cus_1", payment_status: "paid" } } });
  assert.throws(() => billing.handleWebhook(body, "t=1,v1=00"), error => error.status === 400);
  assert.equal(billing.handleWebhook(body, sign(body)), "checkout-completed");
  assert.throws(() => billing.devActivate(store.userById("u1")), error => error.status === 404);
  const dev = createBilling({ store, appUrl: "http://localhost", devMode: true, now: () => NOW });
  dev.devActivate(store.userById("u1"));
  assert.equal(store.subscription("u1").status, "active");
  store.close();
});

test("without a Stripe key checkout reports the payment is not configured", async () => {
  const store = setup();
  const billing = createBilling({ store, appUrl: "http://localhost", now: () => NOW });
  await assert.rejects(billing.createCheckout(store.userById("u1")), error => error.status === 503);
  store.close();
});
