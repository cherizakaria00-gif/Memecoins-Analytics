import test from "node:test";
import assert from "node:assert/strict";
import { buildAdminOverview, summarizeUserState } from "../src/admin-stats.mjs";
import { applyStripeEvent, recordInvoice } from "../src/billing.mjs";
import { openStore } from "../src/db.mjs";

const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NOW = Date.UTC(2026, 9, 20, 12);
const state = keys => JSON.stringify(Object.fromEntries(Object.entries(keys).map(([key, value]) => [key, JSON.stringify(value)])));

test("summarizes the synced portfolio and the last connected wallet", () => {
  const summary = summarizeUserState(state({
    "pulse-wallet": { balance: 8000, positions: [{ amount: 1500 }], history: [{ pnl: 50 }, { pnl: -20 }] },
    "pulse-equity": [{ t: 1, v: 9800 }, { t: 2, v: 10450 }],
    "pulse-last-wallet": { address: ADDRESS, name: "Phantom", at: 123 }
  }));
  assert.equal(summary.lastWallet.address, ADDRESS);
  assert.equal(summary.totalValue, 10450);
  assert.equal(summary.pnl, 450);
  assert.equal(summary.pnlPct, 4.5);
  assert.equal(summary.realized, 30);
  assert.deepEqual([summary.trades, summary.openPositions], [2, 1]);
});

test("falls back to cash plus open positions and survives garbage", () => {
  const summary = summarizeUserState(state({ "pulse-wallet": { balance: 9000, positions: [{ amount: 500 }], history: [] } }));
  assert.equal(summary.totalValue, 9500);
  assert.equal(summary.pnl, -500);
  const empty = summarizeUserState("not json");
  assert.equal(empty.lastWallet, null);
  assert.equal(empty.pnl, null);
  assert.equal(summarizeUserState(state({ "pulse-last-wallet": { address: "<script>" } })).lastWallet, null);
});

test("builds revenue totals and subscriber rows", () => {
  const rows = [
    { id: "a", email: "a@x.co", created_at: NOW - 3 * 86_400_000, last_login_at: NOW - 1000, sub_status: "active", current_period_end: NOW + 5 * 86_400_000, cancel_at_period_end: 0, stripe_customer_id: "cus_a", state_data: state({ "pulse-equity": [{ t: 1, v: 11000 }] }), state_updated_at: NOW - 5000 },
    { id: "b", email: "b@x.co", created_at: NOW - 40 * 86_400_000, last_login_at: null, sub_status: "canceled", current_period_end: NOW - 86_400_000, cancel_at_period_end: 0, stripe_customer_id: "cus_b", state_data: null, state_updated_at: null },
    { id: "c", email: "c@x.co", created_at: NOW - 86_400_000, last_login_at: null, sub_status: null, current_period_end: null, cancel_at_period_end: 0, stripe_customer_id: null, state_data: null, state_updated_at: null },
    { id: "d", email: "owner@x.co", created_at: NOW - 90 * 86_400_000, last_login_at: null, sub_status: null, current_period_end: null, cancel_at_period_end: 0, stripe_customer_id: null, state_data: null, state_updated_at: null }
  ];
  const payments = [
    { customer_id: "cus_a", amount_cents: 2000, paid_at: Date.UTC(2026, 9, 5) },
    { customer_id: "cus_a", amount_cents: 2000, paid_at: Date.UTC(2026, 8, 5) },
    { customer_id: "cus_b", amount_cents: 2000, paid_at: Date.UTC(2026, 6, 5) }
  ];
  const overview = buildAdminOverview({ rows, payments, adminEmails: ["owner@x.co"], now: NOW });
  const { totals } = overview;
  assert.equal(totals.users, 4);
  assert.equal(totals.active, 2);
  assert.equal(totals.paying, 1);
  assert.equal(totals.comped, 1);
  assert.equal(totals.canceled, 1);
  assert.equal(totals.mrrCents, 2000);
  assert.equal(totals.collectedCents, 6000);
  assert.equal(totals.collectedMonthCents, 2000);
  assert.equal(totals.signups7d, 2);
  assert.equal(totals.signups30d, 2);
  const byEmail = Object.fromEntries(overview.subscribers.map(subscriber => [subscriber.email, subscriber]));
  assert.equal(byEmail["a@x.co"].paidCents, 4000);
  assert.equal(byEmail["a@x.co"].pnl, 1000);
  assert.equal(byEmail["b@x.co"].active, false);
  assert.equal(byEmail["owner@x.co"].plan, "comped");
});

test("paid invoices are recorded once, from webhooks and backfills alike", () => {
  const store = openStore(":memory:");
  const invoice = { id: "in_1", customer: "cus_1", amount_paid: 2000, currency: "usd", status_transitions: { paid_at: 1_790_000_000 } };
  assert.equal(recordInvoice(store, invoice), true);
  assert.equal(recordInvoice(store, invoice), false);
  assert.equal(recordInvoice(store, { id: "in_2", amount_paid: 0 }), false);
  assert.equal(applyStripeEvent(store, { id: "evt_a", type: "invoice.paid", data: { object: { id: "in_3", customer: "cus_1", amount_paid: 2000, created: 1_790_100_000 } } }, NOW), "payment-recorded");
  assert.equal(store.payments().length, 2);
  assert.equal(store.payments()[0].paid_at, 1_790_100_000_000);
  store.close();
});
