import { AuthError, SESSION_COOKIE, clearedSessionCookie, createLimiter, parseCookies, sessionCookie } from "./auth.mjs";
import { PLAN, PLANS } from "./billing.mjs";
import { sanitizeState } from "./user-state.mjs";
import { buildAdminOverview } from "./admin-stats.mjs";

const MAX_JSON_BYTES = 700_000;

export async function readBody(request, limit = MAX_JSON_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Corps de requête trop volumineux."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request) {
  try { return JSON.parse((await readBody(request)) || "{}"); } catch (error) {
    throw error.status ? error : Object.assign(new Error("JSON invalide."), { status: 400 });
  }
}

/** Same-origin check for state-changing requests (cookies are SameSite=Lax, this closes the remaining gaps). */
export function isSameOrigin(request) {
  const site = request.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

/**
 * Accounts, subscription and state-sync routes plus the paywall for the rest of the API.
 * `send(response, status, payload, headers)` is the server's JSON responder.
 */
export function createSaas({ auth, billing, store, crypto = null, platformFee = { bps: 0, account: null, getSolUsd: async () => 0 }, send, secureCookies = false, now = () => Date.now() }) {
  const loginByIp = createLimiter({ limit: 30, windowMs: 15 * 60_000 });
  const loginByAccount = createLimiter({ limit: 8, windowMs: 15 * 60_000 });
  const signupByIp = createLimiter({ limit: 10, windowMs: 3_600_000 });
  const clientIp = request => request.socket.remoteAddress ?? "unknown";
  const publicUser = user => ({ id: user.id, email: user.email, createdAt: user.created_at });
  const isAdmin = user => Boolean(user && billing.adminEmails.includes(user.email));
  const me = user => ({ user: publicUser(user), access: { ...billing.access(user), admin: isAdmin(user), ...(isAdmin(user) ? { pendingCrypto: store.pendingCryptoCount() } : {}) } });
  const cryptoLimiter = createLimiter({ limit: 40, windowMs: 3_600_000 });

  /** Commission collected on LIVE swaps (confirmed orders only), in SOL with a dollar estimate at the current SOL price. */
  async function feeSummary() {
    const startOfMonth = new Date(now()); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
    const all = store.feeTotals(0);
    const month = store.feeTotals(startOfMonth.getTime());
    let solUsd = 0;
    try { solUsd = await platformFee.getSolUsd(); } catch { /* the SOL amounts are still shown */ }
    const sol = lamports => lamports / 1e9;
    return {
      bps: platformFee.bps, configured: platformFee.bps > 0, account: platformFee.account, problem: platformFee.problem ?? null,
      solUsd, totalSol: sol(all.lamports), totalCount: all.count, monthSol: sol(month.lamports), monthCount: month.count,
      recent: store.recentFees(20).map(fee => ({ id: fee.id, email: fee.email, side: fee.side, mint: fee.mint, sol: sol(fee.fee_lamports), signature: fee.signature, at: fee.settled_at }))
    };
  }

  function fail(response, error) {
    const status = error instanceof AuthError || error.status ? error.status : 500;
    if (status >= 500) console.error("SaaS route failed", error);
    send(response, status, { error: status >= 500 && !error.status ? "Erreur interne." : error.message });
  }

  return {
    isAdmin,
    /** Loads request.user from the session cookie. */
    identify(request) {
      request.user = auth.authenticate(request.headers.cookie);
      return request.user;
    },

    /** Paywall for every other API route: 401 when signed out, 402 without an active subscription. */
    gate(request) {
      if (!request.user) return { status: 401, body: { error: "Connexion requise.", code: "login_required" } };
      if (!billing.access(request.user).active) return { status: 402, body: { error: "Abonnement requis.", code: "subscription_required" } };
      return null;
    },

    /** Returns true when the request was one of the account / billing / state routes. */
    async handle(request, response, url) {
      const { pathname } = url;
      if (!pathname.startsWith("/api/")) return false;
      this.identify(request);
      const method = request.method;
      const isWebhook = pathname === "/api/billing/webhook";
      if (method !== "GET" && !isWebhook && !isSameOrigin(request)) { send(response, 403, { error: "Origine non autorisée." }); return true; }

      try {
        if (pathname === "/api/config" && method === "GET") {
          send(response, 200, { plan: { ...PLAN, trialDays: billing.trialDays ?? 0 }, plans: PLANS, billingConfigured: billing.configured, devBilling: billing.devMode, liveFeeBps: platformFee.bps, cryptoMethods: crypto?.methods() ?? [] });
          return true;
        }
        if (pathname === "/api/me" && method === "GET") {
          if (!request.user) send(response, 401, { error: "Connexion requise.", code: "login_required" });
          else send(response, 200, me(request.user));
          return true;
        }
        if (pathname === "/api/auth/signup" && method === "POST") {
          if (signupByIp.hit(clientIp(request))) { send(response, 429, { error: "Trop de créations de compte. Réessaie plus tard." }); return true; }
          const body = await readJson(request);
          const { user, token } = await auth.signup({ email: body.email, password: body.password, acceptedTerms: body.acceptedTerms, userAgent: request.headers["user-agent"] });
          request.user = user;
          send(response, 201, me(user), { "set-cookie": sessionCookie(token, { secure: secureCookies }) });
          return true;
        }
        if (pathname === "/api/auth/login" && method === "POST") {
          const body = await readJson(request);
          if (loginByIp.hit(clientIp(request)) || loginByAccount.hit(`${clientIp(request)}:${String(body.email ?? "").toLowerCase()}`)) {
            send(response, 429, { error: "Trop de tentatives. Réessaie dans quelques minutes." });
            return true;
          }
          const { user, token } = await auth.login({ email: body.email, password: body.password, userAgent: request.headers["user-agent"] });
          request.user = user;
          send(response, 200, me(user), { "set-cookie": sessionCookie(token, { secure: secureCookies }) });
          return true;
        }
        if (pathname === "/api/auth/logout" && method === "POST") {
          auth.logout(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
          send(response, 200, { ok: true }, { "set-cookie": clearedSessionCookie({ secure: secureCookies }) });
          return true;
        }
        if (isWebhook && method === "POST") {
          const result = billing.handleWebhook(await readBody(request, 300_000), request.headers["stripe-signature"]);
          send(response, 200, { received: true, result });
          return true;
        }
        if (pathname.startsWith("/api/billing/")) {
          if (!request.user) { send(response, 401, { error: "Connexion requise.", code: "login_required" }); return true; }
          if (pathname === "/api/billing/checkout" && method === "POST") {
            if (billing.access(request.user).active && !billing.access(request.user).comped) { send(response, 409, { error: "Tu as déjà un abonnement actif." }); return true; }
            const interval = request.headers["content-length"] > 0 ? (await readJson(request)).interval : "month";
            send(response, 200, { url: await billing.createCheckout(request.user, interval === "year" ? "year" : "month") });
            return true;
          }
          if (pathname === "/api/billing/portal" && method === "POST") { send(response, 200, { url: await billing.createPortal(request.user) }); return true; }
          if (pathname === "/api/billing/sync" && method === "POST") {
            await billing.syncCheckoutSession(request.user, (await readJson(request)).sessionId);
            send(response, 200, me(request.user));
            return true;
          }
          if (pathname === "/api/billing/dev-activate" && method === "POST") { billing.devActivate(request.user); send(response, 200, me(request.user)); return true; }
        }
        if (pathname.startsWith("/api/crypto/")) {
          if (!crypto) { send(response, 404, { error: "Paiement crypto indisponible." }); return true; }
          if (!request.user) { send(response, 401, { error: "Connexion requise.", code: "login_required" }); return true; }
          if (method !== "GET" && cryptoLimiter.hit(request.user.id)) { send(response, 429, { error: "Trop de requêtes. Réessaie plus tard." }); return true; }
          if (pathname === "/api/crypto/request" && method === "POST") {
            const body = await readJson(request);
            send(response, 200, await crypto.createRequest(request.user, { asset: String(body.asset ?? ""), network: String(body.network ?? ""), interval: body.interval === "year" ? "year" : "month" }));
            return true;
          }
          if (pathname === "/api/crypto/mine" && method === "GET") { send(response, 200, { requests: crypto.mine(request.user) }); return true; }
          const qr = pathname.match(/^\/api\/crypto\/([\w-]{8,64})\/qr\.svg$/);
          if (qr && method === "GET") {
            const view = crypto.view(crypto.request(request.user, qr[1]));
            response.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "private, no-store" });
            response.end(await crypto.qr(view.qrPayload));
            return true;
          }
          const submit = pathname.match(/^\/api\/crypto\/([\w-]{8,64})\/submit$/);
          if (submit && method === "POST") { send(response, 200, crypto.submit(request.user, submit[1], (await readJson(request)).txHash)); return true; }
        }
        if (pathname.startsWith("/api/admin/")) {
          if (!isAdmin(request.user)) { send(response, request.user ? 403 : 401, { error: request.user ? "Réservé à l'administrateur." : "Connexion requise." }); return true; }
          if (pathname === "/api/admin/overview" && method === "GET") {
            send(response, 200, { ...buildAdminOverview({ rows: store.adminUsers(), payments: store.payments(), adminEmails: billing.adminEmails, now: now() }), fees: await feeSummary() });
            return true;
          }
          if (crypto && pathname === "/api/admin/crypto" && method === "GET") { send(response, 200, { requests: crypto.adminList(), pending: store.pendingCryptoCount() }); return true; }
          const decision = crypto && pathname.match(/^\/api\/admin\/crypto\/([\w-]{8,64})\/(approve|reject)$/);
          if (decision && method === "POST") {
            const body = await readJson(request);
            const target = store.cryptoRequest(decision[1]);
            if (!target) { send(response, 404, { error: "Demande introuvable." }); return true; }
            const note = typeof body.note === "string" ? body.note.slice(0, 300) : null;
            const result = decision[2] === "approve" ? crypto.approve(target, { days: body.days, note, adminEmail: request.user.email }) : crypto.reject(target, { note, adminEmail: request.user.email });
            send(response, 200, { request: result, pending: store.pendingCryptoCount() });
            return true;
          }
          if (pathname === "/api/admin/sync-payments" && method === "POST") {
            const added = await billing.syncPayments();
            send(response, 200, { added });
            return true;
          }
        }
        if (pathname === "/api/state" && (method === "GET" || method === "PUT" || method === "POST")) {
          if (!request.user) { send(response, 401, { error: "Connexion requise.", code: "login_required" }); return true; }
          if (method === "GET") {
            const saved = store.state(request.user.id);
            send(response, 200, saved ? { keys: JSON.parse(saved.data), updatedAt: saved.updated_at } : { keys: {}, updatedAt: null });
          } else {
            let keys;
            try { keys = sanitizeState(await readJson(request)); } catch (error) { throw Object.assign(new Error(error.message), { status: error instanceof RangeError ? 413 : 400 }); }
            store.saveState(request.user.id, JSON.stringify(keys), now());
            send(response, 200, { ok: true, updatedAt: now() });
          }
          return true;
        }
      } catch (error) {
        fail(response, error);
        return true;
      }
      if (pathname.startsWith("/api/auth/") || pathname.startsWith("/api/billing/") || pathname.startsWith("/api/admin/") || pathname.startsWith("/api/crypto/") || pathname === "/api/state") { send(response, 404, { error: "Introuvable." }); return true; }
      return false;
    }
  };
}
