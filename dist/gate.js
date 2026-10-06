/**
 * Entry point: checks the account and the subscription, restores the user's synced settings into localStorage,
 * and only then loads the application (app.js). Anonymous and unsubscribed visitors see the landing page / paywall.
 */
import { lang, locale, setLang, t } from "./i18n.js";
const SYNC_INTERVAL_MS = 15_000;
const $ = selector => document.querySelector(selector);
document.querySelectorAll("[data-lang-label]").forEach(node => { node.textContent = lang === "fr" ? "English" : "Français"; });
document.querySelectorAll("[data-lang-switch]").forEach(button => button.addEventListener("click", () => setLang(lang === "fr" ? "en" : "fr")));
const setAccess = state => { document.body.dataset.access = state; };

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, { method, headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" }, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  let data = null;
  try { data = await response.json(); } catch { /* empty body */ }
  if (!response.ok) throw Object.assign(new Error(data?.error ?? `Erreur ${response.status}`), { status: response.status, code: data?.code });
  return data;
}

const pulseKeys = () => Object.keys(localStorage).filter(key => key.startsWith("pulse-") && key !== "pulse-uid");
function clearPulseKeys() { for (const key of pulseKeys()) localStorage.removeItem(key); }

function showGate(view) {
  $("#gate-loading").hidden = true;
  $("#gate-page").hidden = false;
  $("#gate-landing").hidden = view !== "auth";
  $("#gate-auth").hidden = true;
  $("#gate-paywall").hidden = view !== "paywall";
}

function openAuth(mode) {
  setAuthMode(mode);
  $("#gate-auth").hidden = false;
  $("#auth-email").focus();
}
function closeAuth() { $("#gate-auth").hidden = true; }
document.querySelectorAll("[data-open-auth]").forEach(button => button.addEventListener("click", () => openAuth(button.dataset.openAuth)));
document.querySelectorAll("[data-close-auth]").forEach(button => button.addEventListener("click", closeAuth));
document.addEventListener("keydown", event => { if (event.key === "Escape" && !$("#gate-auth").hidden) closeAuth(); });

function showError(id, message) {
  const node = $(id);
  node.hidden = !message;
  node.textContent = message ?? "";
}

/* ---- Billing interval (monthly 20 $ / yearly 200 $) ---- */
const PRICES = { month: { price: "20 $", unit: "/ mois", note: "Sans engagement, annulable à tout moment.", button: "S'abonner · 20 $ / mois" }, year: { price: "200 $", unit: "/ an", note: "Soit 16,67 $ / mois : 2 mois offerts.", button: "S'abonner · 200 $ / an" } };
let interval = "month";
function setInterval_(next) {
  interval = next;
  document.querySelectorAll("[data-interval]").forEach(button => button.classList.toggle("active", button.dataset.interval === next));
  document.querySelectorAll("[data-price]").forEach(node => { node.textContent = PRICES[next].price; });
  document.querySelectorAll("[data-price-unit]").forEach(node => { node.textContent = PRICES[next].unit; });
  document.querySelectorAll("[data-price-note]").forEach(node => { node.textContent = PRICES[next].note; });
  $("#paywall-subscribe").textContent = PRICES[next].button;
  if (crypto.request && crypto.request.interval !== next && crypto.request.status === "open") $("#crypto-back").click();
}
document.querySelectorAll("[data-interval]").forEach(button => button.addEventListener("click", () => setInterval_(button.dataset.interval)));

/* ---- Landing: the example bot card can be switched on and off ---- */
$("#mock-switch").addEventListener("click", event => {
  const button = event.currentTarget;
  const on = button.getAttribute("aria-checked") !== "true";
  button.setAttribute("aria-checked", String(on));
  $("#mock-switch-label").textContent = on ? "Actif" : "Désactivé";
  $("#bot-mock").classList.toggle("is-off", !on);
});

/* ---- Landing: animated example feed of simulated trades (generated for the demo, wins and losses) ---- */
const FEED_SYMBOLS = ["ZAPPY", "MOONCAT", "PIXEL", "NOVA", "FROGGY", "TURBO", "KAIJU", "GLITCH", "ORBIT", "DOGEX", "WAFFLE", "COMET"];
const pick = list => list[Math.floor(Math.random() * list.length)];
const pad = value => String(value).padStart(2, "0");
const feedMoney = value => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toFixed(2)}`;

function makeTrade() {
  const amount = pick([250, 250, 500, 500, 1000]);
  const roll = Math.random();
  let pct; let reason = "";
  if (roll < 0.1) { pct = 25 + Math.random() * 40; reason = "take-profit"; }
  else if (roll < 0.62) pct = 1 + Math.random() * 10;
  else if (roll < 0.82) { pct = -(8 + Math.random() * 17); reason = "stop-loss"; }
  else pct = -(1 + Math.random() * 6);
  const pnl = amount * pct / 100;
  const now = new Date();
  return { symbol: pick(FEED_SYMBOLS), at: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`, amount, exit: amount + pnl, reason, pnl, pct };
}

function feedRow(trade) {
  const row = document.createElement("div");
  row.className = "result-row";
  const cells = [["b", `$${trade.symbol}`], ["span", trade.at], ["span", `$${trade.amount.toFixed(2)} → $${trade.exit.toFixed(2)}${trade.reason ? ` · ${trade.reason}` : ""}`], ["em", `${feedMoney(trade.pnl)} (${trade.pct >= 0 ? "+" : "−"}${Math.abs(trade.pct).toFixed(1)}%)`]];
  for (const [tag, text] of cells) { const node = document.createElement(tag); node.textContent = text; row.append(node); }
  if (trade.pnl < 0) row.classList.add("loss");
  return row;
}

const feed = $("#results-feed");
if (feed) {
  let visible = true;
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; }).observe(feed);
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  setInterval(() => {
    if (!visible || document.hidden) return;
    const row = feedRow(makeTrade());
    if (!still) row.classList.add("enter");
    feed.prepend(row);
    while (feed.children.length > 7) feed.lastElementChild.remove();
  }, 2800);
}

/* ---- Legal modal ---- */
const legal = $("#legal-modal");
document.querySelectorAll("[data-open-legal]").forEach(button => button.addEventListener("click", () => { legal.hidden = false; }));
document.querySelectorAll("[data-close-legal]").forEach(button => button.addEventListener("click", () => { legal.hidden = true; }));
$("#account-legal").addEventListener("click", () => { legal.hidden = false; $("#account-menu").hidden = true; });

/* ---- Login / signup ---- */
let authMode = "login";
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll("[data-auth-tab]").forEach(button => button.classList.toggle("active", button.dataset.authTab === mode));
  $("#auth-submit").textContent = mode === "login" ? "Se connecter" : "Créer mon compte";
  $("#auth-terms").hidden = mode === "login";
  $("#auth-hint").hidden = mode === "login";
  $("#auth-password").autocomplete = mode === "login" ? "current-password" : "new-password";
  showError("#auth-error", null);
}
document.querySelectorAll("[data-auth-tab]").forEach(button => button.addEventListener("click", () => setAuthMode(button.dataset.authTab)));

$("#auth-form").addEventListener("submit", async event => {
  event.preventDefault();
  const submit = $("#auth-submit");
  submit.disabled = true;
  showError("#auth-error", null);
  try {
    await api(authMode === "login" ? "/api/auth/login" : "/api/auth/signup", {
      method: "POST",
      body: { email: $("#auth-email").value, password: $("#auth-password").value, ...(authMode === "signup" ? { acceptedTerms: $("#auth-accept").checked } : {}) }
    });
    window.location.replace("/");
  } catch (error) {
    showError("#auth-error", error.message);
    submit.disabled = false;
  }
});

async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* the cookie is cleared server-side anyway */ }
  clearPulseKeys();
  localStorage.removeItem("pulse-uid");
  window.location.replace("/");
}
$("#account-logout").addEventListener("click", logout);
$("#paywall-logout").addEventListener("click", logout);

/* ---- Paywall ---- */
async function startCheckout(button, errorId) {
  button.disabled = true;
  showError(errorId, null);
  try {
    window.location.assign((await api("/api/billing/checkout", { method: "POST", body: { interval } })).url);
  } catch (error) {
    showError(errorId, error.message);
    button.disabled = false;
  }
}
$("#paywall-subscribe").addEventListener("click", event => startCheckout(event.currentTarget, "#paywall-error"));
/* ---- Crypto payment (manual approval by the administrator) ---- */
const ASSET_NAMES = { SOL: "SOL", USDT: "USDT", USDC: "USDC" };
const crypto = { methods: [], asset: null, network: null, request: null, timer: null, poll: null };
const cryptoNetworkLabels = { solana: "Solana", ethereum: "Ethereum (ERC-20)", polygon: "Polygon", bsc: "BNB Chain (BEP-20)" };

function setPayTab(tab) {
  document.querySelectorAll("[data-pay-tab]").forEach(button => button.classList.toggle("active", button.dataset.payTab === tab));
  $("#pay-card").hidden = tab !== "card";
  $("#pay-crypto").hidden = tab !== "crypto";
  showError("#paywall-error", null);
  if (tab === "crypto") resumeCrypto();
}
document.querySelectorAll("[data-pay-tab]").forEach(button => button.addEventListener("click", () => setPayTab(button.dataset.payTab)));

function renderCryptoPick() {
  const assets = [...new Set(crypto.methods.map(method => method.asset))];
  const networks = crypto.methods.filter(method => method.asset === crypto.asset);
  if (crypto.network && !networks.some(method => method.network === crypto.network)) crypto.network = null;
  $("#crypto-assets").innerHTML = assets.map(asset => `<button type="button" class="${asset === crypto.asset ? "active" : ""}" data-asset="${asset}">${ASSET_NAMES[asset] ?? asset}</button>`).join("");
  $("#crypto-networks").innerHTML = crypto.asset ? networks.map(method => `<button type="button" class="${method.network === crypto.network ? "active" : ""}" data-network="${method.network}">${method.networkLabel}</button>`).join("") : '<span class="pay-hint">Choisis d\'abord un actif.</span>';
  $("#crypto-start").disabled = !(crypto.asset && crypto.network);
  $("#crypto-unavailable").hidden = crypto.methods.length > 0;
}
$("#crypto-assets").addEventListener("click", event => { const button = event.target.closest("[data-asset]"); if (button) { crypto.asset = button.dataset.asset; renderCryptoPick(); } });
$("#crypto-networks").addEventListener("click", event => { const button = event.target.closest("[data-network]"); if (button) { crypto.network = button.dataset.network; renderCryptoPick(); } });

const WARNINGS = {
  SOL: network => `Envoie exactement ce montant en SOL sur le réseau ${network}. Un autre actif ou réseau ne pourra pas être récupéré.`,
  stable: (asset, network) => `Envoie exactement ce montant en ${asset} sur le réseau ${network}. Un autre réseau ou un autre actif ne pourra pas être récupéré.`
};

function renderInvoice(request) {
  crypto.request = request;
  if (interval !== request.interval) setInterval_(request.interval);
  $("#crypto-pick").hidden = true;
  $("#crypto-invoice").hidden = false;
  $("#crypto-qr").src = `/api/crypto/${request.id}/qr.svg`;
  $("#crypto-amount").textContent = `${request.amount} ${request.asset}`;
  $("#crypto-amount").dataset.raw = request.amount;
  $("#crypto-network").textContent = request.networkLabel;
  $("#crypto-address").textContent = request.address;
  $("#crypto-reference").textContent = request.reference;
  $("#crypto-warning").textContent = request.asset === "SOL" ? WARNINGS.SOL(request.networkLabel) : WARNINGS.stable(request.asset, request.networkLabel);
  const status = $("#crypto-status");
  const submitted = request.status === "submitted";
  $("#crypto-submit-box").hidden = request.status !== "open";
  status.hidden = request.status === "open";
  status.className = `invoice-status ${request.status}`;
  if (submitted) status.innerHTML = `⏳ Paiement reçu pour vérification. L'administrateur l'examine et active ton accès (${request.interval === "year" ? "365" : "30"} jours) dès validation. Cette page se met à jour automatiquement.${request.explorer ? ` <a href="${request.explorer}" target="_blank" rel="noopener noreferrer">Voir la transaction</a>` : ""}`;
  else if (request.status === "rejected") status.textContent = `Paiement refusé${request.note ? ` : ${request.note}` : "."} Tu peux faire une nouvelle demande ou contacter le support.`;
  else if (request.status === "approved") status.textContent = "✅ Paiement validé. Ouverture de Pulse…";
  clearInterval(crypto.timer);
  const tick = () => {
    const left = request.expiresAt - Date.now();
    $("#crypto-expiry").textContent = request.status !== "open" ? "—" : left > 0 ? `${Math.floor(left / 60_000)} min ${String(Math.floor(left / 1000) % 60).padStart(2, "0")} s` : "expiré";
  };
  tick();
  crypto.timer = setInterval(tick, 1000);
  clearInterval(crypto.poll);
  if (submitted) crypto.poll = setInterval(pollAccess, 12_000);
}

async function pollAccess() {
  try {
    const me = await api("/api/me");
    if (me.access.active) { window.location.replace("/"); return; }
    const latest = (await api("/api/crypto/mine")).requests[0];
    if (latest && crypto.request && latest.id === crypto.request.id && latest.status !== crypto.request.status) renderInvoice(latest);
  } catch { /* retried */ }
}

async function resumeCrypto() {
  if (crypto.request) return;
  try {
    const latest = (await api("/api/crypto/mine")).requests[0];
    if (latest && (latest.status === "submitted" || (latest.status === "open" && latest.expiresAt > Date.now()))) renderInvoice(latest);
  } catch { /* the picker stays available */ }
}

$("#crypto-start").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  showError("#paywall-error", null);
  try { renderInvoice(await api("/api/crypto/request", { method: "POST", body: { asset: crypto.asset, network: crypto.network, interval } })); }
  catch (error) { showError("#paywall-error", error.message); }
  button.disabled = !(crypto.asset && crypto.network);
});
$("#crypto-back").addEventListener("click", () => {
  clearInterval(crypto.timer); clearInterval(crypto.poll);
  crypto.request = null;
  $("#crypto-invoice").hidden = true;
  $("#crypto-pick").hidden = false;
  showError("#paywall-error", null);
});
$("#crypto-submit").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  showError("#paywall-error", null);
  try { renderInvoice(await api(`/api/crypto/${crypto.request.id}/submit`, { method: "POST", body: { txHash: $("#crypto-hash").value } })); }
  catch (error) { showError("#paywall-error", error.message); }
  button.disabled = false;
});
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const source = $(`#${button.dataset.copy}`);
  const text = source.dataset.raw ?? source.textContent;
  try { await navigator.clipboard.writeText(text); button.textContent = "Copié ✓"; } catch { button.textContent = "Sélectionne et copie"; }
  setTimeout(() => { button.textContent = "Copier"; }, 1500);
});

$("#paywall-dev").addEventListener("click", async () => {
  try { await api("/api/billing/dev-activate", { method: "POST" }); window.location.replace("/"); } catch (error) { showError("#paywall-error", error.message); }
});

/* ---- Account menu ---- */
const dateText = ms => new Date(ms).toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });

function renderAccount(me) {
  const { user, access } = me;
  $("#account-initial").textContent = user.email[0].toUpperCase();
  $("#account-email").textContent = user.email;
  const plan = $("#account-plan");
  plan.textContent = access.comped ? "Accès offert" : access.status === "trialing" ? "Essai gratuit" : access.status === "past_due" ? "Paiement en retard" : "Pulse Pro · 20 $/mois";
  plan.className = `plan-pill ${access.status === "past_due" ? "warn" : "ok"}`;
  $("#account-note").textContent = access.comped ? "Ce compte a un accès gratuit."
    : access.cancelsAtPeriodEnd && access.renewsAt ? `Annulé : accès jusqu'au ${dateText(access.renewsAt)}.`
      : access.renewsAt ? `Prochain renouvellement le ${dateText(access.renewsAt)}.` : "";
  $("#account-manage").hidden = !access.hasCustomer;
  $("#admin-tab").hidden = !access.admin;
  const badge = $("#admin-badge");
  if (badge) { badge.hidden = !access.pendingCrypto; badge.textContent = String(access.pendingCrypto ?? ""); }
}
$("#account-button").addEventListener("click", () => { const menu = $("#account-menu"); menu.hidden = !menu.hidden; });
document.addEventListener("click", event => { if (!event.target.closest(".account-control")) $("#account-menu").hidden = true; });
$("#account-manage").addEventListener("click", async event => {
  event.currentTarget.disabled = true;
  try { window.location.assign((await api("/api/billing/portal", { method: "POST" })).url); } catch (error) { alert(t(error.message)); event.currentTarget.disabled = false; }
});

/* ---- Settings sync (localStorage <-> account) ---- */
let lastSynced = "";
const snapshot = () => JSON.stringify(Object.fromEntries(pulseKeys().sort().map(key => [key, localStorage.getItem(key)])));

async function pushState(useBeacon = false) {
  const current = snapshot();
  if (current === lastSynced) return;
  const body = JSON.stringify({ keys: JSON.parse(current) });
  if (useBeacon && navigator.sendBeacon) { navigator.sendBeacon("/api/state", new Blob([body], { type: "application/json" })); lastSynced = current; return; }
  try { await api("/api/state", { method: "PUT", body: { keys: JSON.parse(current) } }); lastSynced = current; } catch { /* retried at the next tick */ }
}

async function restoreState(me) {
  const previous = localStorage.getItem("pulse-uid");
  if (previous && previous !== me.user.id) clearPulseKeys();
  const hadLocalData = pulseKeys().length > 0;
  localStorage.setItem("pulse-uid", me.user.id);
  const saved = await api("/api/state");
  const entries = Object.entries(saved.keys ?? {});
  if (entries.length) {
    clearPulseKeys();
    for (const [key, value] of entries) localStorage.setItem(key, value);
    lastSynced = snapshot();
  } else if (hadLocalData) lastSynced = ""; // first sign-in on a browser that already had data: adopt it
}

async function enter(me) {
  await restoreState(me);
  renderAccount(me);
  setAccess("ok");
  $("#gate").hidden = true;
  await import("./app.js");
  setInterval(() => pushState(), SYNC_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") pushState(true); });
  window.addEventListener("pagehide", () => pushState(true));
  pushState();
}

async function boot() {
  const params = new URLSearchParams(window.location.search);
  let config = null;
  try { config = await api("/api/config"); } catch { /* shown without trial info */ }
  if (config?.plan?.trialDays > 0) $("#gate-trial").textContent = `${config.plan.trialDays} jours d'essai gratuit.`;
  $("#paywall-dev").hidden = !config?.devBilling;
  crypto.methods = config?.cryptoMethods ?? [];
  renderCryptoPick();

  let me = null;
  try { me = await api("/api/me"); } catch (error) { if (error.status !== 401) { setAccess("anon"); showGate("auth"); openAuth("login"); showError("#auth-error", "Serveur indisponible. Réessaie dans un instant."); return; } }

  if (me && params.get("checkout") === "success" && params.get("session_id")) {
    try { me = await api("/api/billing/sync", { method: "POST", body: { sessionId: params.get("session_id") } }); } catch { /* the webhook will catch up */ }
    window.history.replaceState(null, "", "/");
  } else if (params.has("checkout")) window.history.replaceState(null, "", "/");

  if (!me) { setAccess("anon"); showGate("auth"); setAuthMode("login"); if (window.location.hash === "#connexion") openAuth("login"); return; }
  if (!me.access.active) {
    setAccess("nosub");
    $("#paywall-email").textContent = me.user.email;
    showGate("paywall");
    setPayTab("card");
    if (params.get("checkout") === "cancel") showError("#paywall-error", "Paiement annulé : tu peux réessayer quand tu veux.");
    return;
  }
  await enter(me);
}

boot().catch(error => { console.error("Pulse failed to start", error); setAccess("anon"); showGate("auth"); showError("#auth-error", "Impossible de démarrer l'application."); });
