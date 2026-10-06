import { createHmac, timingSafeEqual } from "node:crypto";

export const PLAN = { name: "Pulse Pro", priceCents: 2000, currency: "usd", interval: "month" };
const STRIPE_API = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_S = 300;
const PAST_DUE_GRACE_MS = 3 * 24 * 3_600_000;

/** Encodes nested objects the way Stripe expects form bodies (a[b][0][c]=…). */
export function toForm(object, prefix = "") {
  const pairs = [];
  for (const [key, value] of Object.entries(object)) {
    if (value == null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item, index) => pairs.push(...(typeof item === "object" ? toForm(item, `${name}[${index}]`) : [`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(item)}`])));
    else if (typeof value === "object") pairs.push(...toForm(value, name));
    else pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  return pairs;
}

/** Checks a Stripe-Signature header (t=timestamp,v1=hmac) against the raw request body. */
export function verifyStripeSignature(rawBody, header, secret, { now = Date.now(), toleranceSeconds = WEBHOOK_TOLERANCE_S } = {}) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map(part => part.trim().split("=")).filter(pair => pair.length === 2));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest();
  const received = String(header).split(",").map(part => part.trim()).filter(part => part.startsWith("v1=")).map(part => part.slice(3));
  return received.some(candidate => {
    const buffer = Buffer.from(candidate, "hex");
    return buffer.length === expected.length && timingSafeEqual(buffer, expected);
  });
}

/** Whether the user may use the platform: comped admins, active or trialing subscriptions, a short past-due grace. */
export function hasAccess({ user, subscription, adminEmails = [], now = Date.now() }) {
  if (user && adminEmails.includes(user.email)) return true;
  if (!subscription) return false;
  // Crypto subscriptions have no webhook to end them: they stop when the paid period ends.
  if (subscription.provider === "crypto") return subscription.status === "active" && Boolean(subscription.current_period_end) && now < subscription.current_period_end;
  if (subscription.status === "active" || subscription.status === "trialing") return true;
  if (subscription.status === "past_due" && subscription.current_period_end) return now < subscription.current_period_end + PAST_DUE_GRACE_MS;
  return false;
}

export function describeAccess({ user, subscription, adminEmails = [], now = Date.now() }) {
  const comped = Boolean(user && adminEmails.includes(user.email));
  return {
    active: hasAccess({ user, subscription, adminEmails, now }),
    comped,
    status: subscription?.status ?? "none",
    renewsAt: subscription?.current_period_end ?? null,
    cancelsAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
    hasCustomer: Boolean(subscription?.stripe_customer_id),
    provider: subscription?.provider ?? (subscription?.stripe_customer_id ? "stripe" : null)
  };
}

const toMs = seconds => (Number.isFinite(Number(seconds)) ? Number(seconds) * 1000 : null);

/** Applies one verified Stripe event to the store. Returns a short description of what happened (for logs and tests). */
export function applyStripeEvent(store, event, now = Date.now()) {
  if (!event?.id || !store.markEventProcessed(event.id, now)) return "ignored";
  const object = event.data?.object ?? {};

  if (event.type === "checkout.session.completed") {
    const userId = object.client_reference_id;
    if (!userId || !store.userById(userId)) return "unknown-user";
    store.saveSubscription({ userId, customerId: object.customer ?? null, subscriptionId: object.subscription ?? null, status: object.payment_status === "paid" || object.status === "complete" ? "active" : "incomplete", now });
    return "checkout-completed";
  }
  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const userId = object.metadata?.user_id || store.userIdByCustomer(object.customer);
    if (!userId || !store.userById(userId)) return "unknown-user";
    store.saveSubscription({
      userId, customerId: object.customer ?? null, subscriptionId: object.id ?? null,
      status: event.type === "customer.subscription.deleted" ? "canceled" : String(object.status ?? "incomplete"),
      currentPeriodEnd: toMs(object.current_period_end ?? object.items?.data?.[0]?.current_period_end),
      cancelAtPeriodEnd: Boolean(object.cancel_at_period_end), now
    });
    return `subscription-${event.type.split(".").pop()}`;
  }
  if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded") {
    return recordInvoice(store, object) ? "payment-recorded" : "ignored";
  }
  return "ignored";
}

/** Stores a paid invoice (once). Returns true when it was new. */
export function recordInvoice(store, invoice) {
  const amountCents = Number(invoice?.amount_paid);
  if (!invoice?.id || !Number.isFinite(amountCents) || amountCents <= 0) return false;
  const paidAt = toMs(invoice.status_transitions?.paid_at ?? invoice.created) ?? Date.now();
  return store.savePayment({ id: invoice.id, customerId: invoice.customer ?? null, amountCents, currency: invoice.currency ?? "usd", paidAt });
}

/** Stripe Checkout / Billing Portal client. `fetchImpl` is injectable for tests. */
export function createBilling({ store, secretKey, webhookSecret, appUrl, trialDays = 0, adminEmails = [], devMode = false, fetchImpl = fetch, now = () => Date.now() }) {
  async function stripe(path, { method = "POST", body } = {}) {
    if (!secretKey) throw Object.assign(new Error("Le paiement n'est pas configuré sur ce serveur."), { status: 503 });
    const response = await fetchImpl(`${STRIPE_API}${path}`, {
      method,
      headers: { authorization: `Bearer ${secretKey}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: body ? toForm(body).join("&") : undefined,
      signal: AbortSignal.timeout(15_000)
    });
    const payload = await response.json();
    if (!response.ok) throw Object.assign(new Error(payload?.error?.message ?? `Stripe HTTP ${response.status}`), { status: 502 });
    return payload;
  }

  return {
    configured: Boolean(secretKey),
    trialDays,
    devMode,
    adminEmails,
    access: user => describeAccess({ user, subscription: store.subscription(user.id), adminEmails, now: now() }),

    async createCheckout(user) {
      const existing = store.subscription(user.id);
      const session = await stripe("/checkout/sessions", {
        body: {
          mode: "subscription",
          ...(existing?.stripe_customer_id ? { customer: existing.stripe_customer_id } : { customer_email: user.email }),
          client_reference_id: user.id,
          line_items: [{ quantity: 1, price_data: { currency: PLAN.currency, unit_amount: PLAN.priceCents, recurring: { interval: PLAN.interval }, product_data: { name: PLAN.name, description: "Accès complet à la plateforme Pulse (abonnement mensuel)" } } }],
          subscription_data: { metadata: { user_id: user.id }, ...(trialDays > 0 ? { trial_period_days: trialDays } : {}) },
          allow_promotion_codes: "true",
          success_url: `${appUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appUrl}/?checkout=cancel`
        }
      });
      return session.url;
    },

    async createPortal(user) {
      const customer = store.subscription(user.id)?.stripe_customer_id;
      if (!customer) throw Object.assign(new Error("Aucun abonnement à gérer pour ce compte."), { status: 404 });
      return (await stripe("/billing_portal/sessions", { body: { customer, return_url: `${appUrl}/` } })).url;
    },

    /** After returning from Checkout: reads the session from Stripe so access starts without waiting for the webhook. */
    async syncCheckoutSession(user, sessionId) {
      if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId ?? "")) throw Object.assign(new Error("Session de paiement invalide."), { status: 400 });
      const session = await stripe(`/checkout/sessions/${sessionId}?expand[]=subscription`, { method: "GET" });
      if (session.client_reference_id !== user.id) throw Object.assign(new Error("Cette session de paiement n'appartient pas à ce compte."), { status: 403 });
      const subscription = typeof session.subscription === "object" ? session.subscription : null;
      store.saveSubscription({
        userId: user.id, customerId: session.customer ?? null, subscriptionId: subscription?.id ?? session.subscription ?? null,
        status: subscription?.status ?? (session.payment_status === "paid" ? "active" : "incomplete"),
        currentPeriodEnd: toMs(subscription?.current_period_end ?? subscription?.items?.data?.[0]?.current_period_end), cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end), now: now()
      });
    },

    handleWebhook(rawBody, signature) {
      if (!verifyStripeSignature(rawBody, signature, webhookSecret, { now: now() })) throw Object.assign(new Error("Signature invalide."), { status: 400 });
      return applyStripeEvent(store, JSON.parse(rawBody), now());
    },

    /** Imports every paid invoice from Stripe (for payments made before the webhook was set up). Returns how many were new. */
    async syncPayments(maxPages = 20) {
      let added = 0;
      let cursor = null;
      for (let page = 0; page < maxPages; page += 1) {
        const query = `/invoices?status=paid&limit=100${cursor ? `&starting_after=${cursor}` : ""}`;
        const result = await stripe(query, { method: "GET" });
        for (const invoice of result.data ?? []) if (recordInvoice(store, invoice)) added += 1;
        if (!result.has_more || !result.data?.length) break;
        cursor = result.data[result.data.length - 1].id;
      }
      return added;
    },

    /** Local testing only: grants 30 days without Stripe. Disabled unless DEV_BILLING=1. */
    devActivate(user) {
      if (!devMode) throw Object.assign(new Error("Indisponible."), { status: 404 });
      store.saveSubscription({ userId: user.id, status: "active", currentPeriodEnd: now() + 30 * 24 * 3_600_000, now: now() });
    }
  };
}
