import { PLAN, PLANS } from "./billing.mjs";

export const START_BALANCE = 10_000;
const DAY_MS = 86_400_000;

const finite = value => (Number.isFinite(Number(value)) ? Number(value) : null);
const parse = text => { try { return JSON.parse(text); } catch { return null; } };

/**
 * What the admin sees of a user's synced browser state: the last wallet they connected (public address only)
 * and the results of their paper-trading portfolio. Everything is read defensively: it is user-controlled data.
 */
export function summarizeUserState(dataJson) {
  const keys = parse(dataJson) ?? {};
  const wallet = parse(keys["pulse-wallet"]) ?? {};
  const equity = parse(keys["pulse-equity"]);
  const last = parse(keys["pulse-last-wallet"]);
  const history = Array.isArray(wallet.history) ? wallet.history : [];
  const positions = Array.isArray(wallet.positions) ? wallet.positions : [];
  const balance = finite(wallet.balance);
  const openCost = positions.reduce((total, position) => total + (finite(position?.amount) ?? 0), 0);
  const lastEquity = Array.isArray(equity) && equity.length ? finite(equity[equity.length - 1]?.v) : null;
  const totalValue = lastEquity ?? (balance == null ? null : balance + openCost);
  const address = typeof last?.address === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(last.address) ? last.address : null;
  return {
    lastWallet: address ? { address, name: typeof last.name === "string" ? last.name.slice(0, 40) : null, at: finite(last.at) } : null,
    balance, totalValue,
    pnl: totalValue == null ? null : totalValue - START_BALANCE,
    pnlPct: totalValue == null ? null : (totalValue - START_BALANCE) / START_BALANCE * 100,
    realized: history.reduce((total, trade) => total + (finite(trade?.pnl) ?? 0), 0),
    trades: history.length,
    openPositions: positions.length
  };
}

export function planLabel({ status, comped }) {
  if (comped) return "comped";
  return ["active", "trialing", "past_due", "canceled", "incomplete"].includes(status) ? status : "none";
}

/** Totals and per-subscriber rows for the admin dashboard. `payments` are paid invoices (gross, in cents). */
export function buildAdminOverview({ rows, payments, adminEmails = [], now = Date.now() }) {
  const paidByCustomer = new Map();
  const lastPaymentByCustomer = new Map();
  for (const payment of payments) if (!lastPaymentByCustomer.has(payment.customer_id) || payment.paid_at > lastPaymentByCustomer.get(payment.customer_id).paid_at) lastPaymentByCustomer.set(payment.customer_id, payment);
  const monthlyValue = row => {
    const last = lastPaymentByCustomer.get(row.stripe_customer_id ?? `crypto:${row.id}`) ?? lastPaymentByCustomer.get(`crypto:${row.id}`);
    return last && last.amount_cents >= PLANS.year.priceCents ? PLANS.year.priceCents / 12 : PLAN.priceCents;
  };
  for (const payment of payments) paidByCustomer.set(payment.customer_id, (paidByCustomer.get(payment.customer_id) ?? 0) + payment.amount_cents);

  const subscribers = rows.map(row => {
    const comped = adminEmails.includes(row.email);
    const crypto = row.provider === "crypto";
    const status = crypto && row.sub_status === "active" && !(row.current_period_end > now) ? "canceled" : row.sub_status ?? "none";
    const active = comped || status === "active" || status === "trialing" || (status === "past_due" && row.current_period_end && now < row.current_period_end + 3 * DAY_MS);
    const state = summarizeUserState(row.state_data);
    return {
      id: row.id, email: row.email, createdAt: row.created_at, lastLoginAt: row.last_login_at, lastSyncAt: row.state_updated_at ?? null,
      monthlyCents: monthlyValue(row), plan: planLabel({ status, comped }), active, comped, renewsAt: row.current_period_end ?? null, cancelsAtPeriodEnd: Boolean(row.cancel_at_period_end),
      provider: row.provider ?? (row.stripe_customer_id ? "stripe" : null),
      paidCents: (row.stripe_customer_id ? paidByCustomer.get(row.stripe_customer_id) ?? 0 : 0) + (paidByCustomer.get(`crypto:${row.id}`) ?? 0), ...state
    };
  });

  const paying = subscribers.filter(subscriber => !subscriber.comped && subscriber.plan === "active");
  const sum = list => list.reduce((total, payment) => total + payment.amount_cents, 0);
  const startOfMonth = new Date(now); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  return {
    generatedAt: now,
    totals: {
      users: subscribers.length,
      active: subscribers.filter(subscriber => subscriber.active).length,
      paying: paying.length,
      comped: subscribers.filter(subscriber => subscriber.comped).length,
      trialing: subscribers.filter(subscriber => subscriber.plan === "trialing").length,
      pastDue: subscribers.filter(subscriber => subscriber.plan === "past_due").length,
      canceled: subscribers.filter(subscriber => subscriber.plan === "canceled").length,
      signups7d: subscribers.filter(subscriber => now - subscriber.createdAt < 7 * DAY_MS).length,
      signups30d: subscribers.filter(subscriber => now - subscriber.createdAt < 30 * DAY_MS).length,
      mrrCents: Math.round(paying.reduce((total, subscriber) => total + subscriber.monthlyCents, 0)),
      collectedCents: sum(payments),
      collectedMonthCents: sum(payments.filter(payment => payment.paid_at >= startOfMonth.getTime())),
      collected30dCents: sum(payments.filter(payment => now - payment.paid_at < 30 * DAY_MS)),
      collectedCryptoCents: sum(payments.filter(payment => String(payment.customer_id).startsWith("crypto:"))),
      paymentsCount: payments.length
    },
    subscribers
  };
}
