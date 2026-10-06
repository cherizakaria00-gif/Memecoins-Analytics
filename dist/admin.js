/** Admin dashboard: subscribers, plans, collected revenue, last wallet and paper-trading results. Loaded on demand. */
import { locale, t } from "./i18n.js";
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const money = (cents, decimals = 0) => `${(cents / 100).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} $`;
const usd = value => `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString(locale, { maximumFractionDigits: 0 })} $`;
const date = ms => (ms ? new Date(ms).toLocaleDateString(locale, { day: "2-digit", month: "short", year: "numeric" }) : "—");
const dateTime = ms => (ms ? new Date(ms).toLocaleString(locale, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`;

const PLAN_LABEL = { active: ["Actif", "ok"], trialing: ["Essai", "ok"], past_due: ["Retard de paiement", "warn"], canceled: ["Annulé", "bad"], incomplete: ["Incomplet", "warn"], none: ["Aucun plan", "neutral"], comped: ["Offert", "blue"] };
const state = { crypto: [], data: null, filter: "all", query: "", timer: null };

const FILTERS = {
  all: () => true,
  active: subscriber => subscriber.active,
  paying: subscriber => !subscriber.comped && subscriber.plan === "active",
  inactive: subscriber => !subscriber.active,
  canceled: subscriber => subscriber.plan === "canceled",
  comped: subscriber => subscriber.comped
};

function renderKpis(totals) {
  const cards = [
    ["Abonnés actifs", String(totals.active), `${totals.paying} payants · ${totals.comped} offerts · ${totals.trialing} en essai`, ""],
    ["Revenu mensuel (MRR)", money(totals.mrrCents), `${totals.paying} payants (annuel ÷ 12)`, "positive"],
    ["Total encaissé", money(totals.collectedCents, 2), `${totals.paymentsCount} paiement${totals.paymentsCount > 1 ? "s" : ""} · dont crypto ${money(totals.collectedCryptoCents ?? 0, 2)}`, "positive"],
    ["Encaissé ce mois", money(totals.collectedMonthCents, 2), `30 derniers jours : ${money(totals.collected30dCents, 2)}`, ""],
    ["Inscrits", String(totals.users), `${totals.signups7d} cette semaine · ${totals.signups30d} ce mois`, ""],
    ["Annulés / en retard", `${totals.canceled} / ${totals.pastDue}`, "abonnements perdus ou à risque", totals.canceled ? "negative" : ""]
  ];
  $("#admin-kpis").innerHTML = cards.map(([label, value, sub, tone]) => `<article class="kpi"><span>${label}</span><strong class="${tone}">${esc(value)}</strong><small>${esc(sub)}</small></article>`).join("");
}

function visible() {
  const query = state.query.trim().toLowerCase();
  return state.data.subscribers.filter(FILTERS[state.filter]).filter(subscriber => !query || subscriber.email.includes(query) || subscriber.lastWallet?.address.toLowerCase().includes(query));
}

function renderRows() {
  const rows = visible();
  $("#admin-empty").hidden = rows.length > 0;
  $("#admin-body").innerHTML = rows.map(subscriber => {
    const [label, tone] = PLAN_LABEL[subscriber.plan] ?? PLAN_LABEL.none;
    const wallet = subscriber.lastWallet
      ? `<a class="wallet-link" href="https://solscan.io/account/${esc(subscriber.lastWallet.address)}" target="_blank" rel="noopener noreferrer" title="${esc(subscriber.lastWallet.address)}">${esc(short(subscriber.lastWallet.address))}</a><small class="since-note">${esc(subscriber.lastWallet.name ?? "")}${subscriber.lastWallet.at ? ` · ${esc(date(subscriber.lastWallet.at))}` : ""}</small>`
      : '<span class="muted">aucun</span>';
    const pnl = subscriber.pnl == null ? '<span class="muted">—</span>'
      : `<span class="cell-main ${subscriber.pnl >= 0 ? "positive" : "negative"}">${usd(subscriber.pnl)}</span><small class="since-note ${subscriber.pnl >= 0 ? "positive" : "negative"}">${subscriber.pnlPct >= 0 ? "+" : "−"}${Math.abs(subscriber.pnlPct).toLocaleString(locale, { maximumFractionDigits: 1 })} %</small>`;
    const renew = subscriber.renewsAt ? `${esc(date(subscriber.renewsAt))}${subscriber.cancelsAtPeriodEnd ? '<small class="since-note negative">annulation programmée</small>' : ""}` : "—";
    return `<tr>
      <td><strong class="cell-main">${esc(subscriber.email)}</strong><small class="since-note">dernière connexion ${esc(dateTime(subscriber.lastLoginAt))}</small></td>
      <td>${esc(date(subscriber.createdAt))}</td>
      <td><span class="plan-pill ${tone}">${esc(label)}</span></td>
      <td>${renew}</td>
      <td>${wallet}</td>
      <td>${subscriber.totalValue == null ? '<span class="muted">—</span>' : esc(usd(subscriber.totalValue).replace(/^[+−]/, "").trim())}</td>
      <td>${pnl}</td>
      <td>${subscriber.trades}<small class="since-note">${subscriber.openPositions} ouverte${subscriber.openPositions > 1 ? "s" : ""}</small></td>
      <td>${subscriber.paidCents ? esc(money(subscriber.paidCents, 2)) : '<span class="muted">0 $</span>'}</td>
      <td>${esc(dateTime(subscriber.lastSyncAt))}</td></tr>`;
  }).join("");
}

const CRYPTO_STATUS = { open: ["En attente de paiement", "neutral"], submitted: ["À vérifier", "warn"], approved: ["Validé", "ok"], rejected: ["Refusé", "bad"] };

function renderCrypto() {
  const rows = state.crypto;
  const pending = rows.filter(row => row.status === "submitted").length;
  $("#crypto-admin-empty").hidden = rows.length > 0;
  const pill = $("#crypto-pending-pill");
  pill.hidden = !pending;
  pill.textContent = `${pending} à vérifier`;
  setBadge(pending);
  $("#crypto-admin-body").innerHTML = rows.map(row => {
    const [label, tone] = CRYPTO_STATUS[row.status] ?? CRYPTO_STATUS.open;
    const actionable = row.status === "submitted" || row.status === "open";
    return `<tr>
      <td><strong class="cell-main">${esc(row.email)}</strong><small class="since-note">réf. ${esc(row.reference)}</small></td>
      <td>${esc(row.asset)}<small class="since-note">${esc(row.networkLabel)} · ${row.interval === "year" ? "annuel" : "mensuel"}</small></td>
      <td>${esc(row.amount)} ${esc(row.asset)}<small class="since-note">${esc(money(row.amountUsd * 100, 2))}</small></td>
      <td>${row.explorer ? `<a class="wallet-link" href="${esc(row.explorer)}" target="_blank" rel="noopener noreferrer" title="${esc(row.txHash)}">${esc(row.txHash.slice(0, 8))}…${esc(row.txHash.slice(-6))}</a>` : '<span class="muted">pas encore soumise</span>'}</td>
      <td>${esc(dateTime(row.submittedAt ?? row.createdAt))}</td>
      <td><span class="plan-pill ${tone}">${esc(label)}</span>${row.note ? `<small class="since-note">${esc(row.note)}</small>` : ""}</td>
      <td>${actionable ? `<div class="crypto-actions"><input type="number" min="1" max="366" value="${row.interval === "year" ? 365 : 30}" aria-label="Jours d'accès" data-days="${esc(row.id)}" /><button class="text-button approve" data-crypto="approve" data-id="${esc(row.id)}">Valider</button><button class="text-button reject" data-crypto="reject" data-id="${esc(row.id)}">Refuser</button></div>` : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
}

function setBadge(count) {
  const badge = $("#admin-badge");
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = String(count);
}

async function loadCrypto() {
  try {
    const response = await fetch("/api/admin/crypto", { headers: { accept: "application/json" }, credentials: "same-origin" });
    if (!response.ok) return;
    state.crypto = (await response.json()).requests;
    renderCrypto();
  } catch { /* the subscribers table still works */ }
}

async function decide(button) {
  const id = button.dataset.id;
  const approve = button.dataset.crypto === "approve";
  const note = approve ? null : window.prompt(t("Motif du refus (visible par l'abonné) :"), "") ?? null;
  if (!approve && note === null) return;
  if (approve && !window.confirm(t("Confirmer que tu as bien reçu ce paiement ? L'accès sera activé."))) return;
  button.disabled = true;
  const days = Number(document.querySelector(`[data-days="${CSS.escape(id)}"]`)?.value) || 30;
  try {
    const response = await fetch(`/api/admin/crypto/${encodeURIComponent(id)}/${approve ? "approve" : "reject"}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ days, note }) });
    if (!response.ok) window.alert(t((await response.json().catch(() => ({}))).error ?? "Échec"));
  } catch { window.alert(t("Échec de la requête.")); }
  await Promise.all([loadCrypto(), loadAdmin()]);
}

function render() {
  renderKpis(state.data.totals);
  renderRows();
  $("#admin-status").textContent = `mis à jour ${new Date(state.data.generatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

export async function loadAdmin() {
  try {
    const response = await fetch("/api/admin/overview", { headers: { accept: "application/json" }, credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    render();
    loadCrypto();
  } catch (error) {
    $("#admin-status").textContent = error.message.includes("403") ? "accès refusé" : "indisponible";
  }
}

let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  $("#admin-filter").addEventListener("click", event => {
    const button = event.target.closest("[data-afilter]");
    if (!button || !state.data) return;
    state.filter = button.dataset.afilter;
    document.querySelectorAll("#admin-filter [data-afilter]").forEach(item => item.classList.toggle("active", item === button));
    renderRows();
  });
  $("#crypto-admin-body").addEventListener("click", event => { const button = event.target.closest("[data-crypto]"); if (button) decide(button); });
  $("#admin-search").addEventListener("input", event => { state.query = event.target.value; if (state.data) renderRows(); });
  $("#admin-sync").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Synchronisation…";
    try {
      const response = await fetch("/api/admin/sync-payments", { method: "POST", credentials: "same-origin" });
      const result = await response.json();
      button.textContent = response.ok ? `${result.added} nouveau${result.added > 1 ? "x" : ""} paiement${result.added > 1 ? "s" : ""} importé${result.added > 1 ? "s" : ""}` : (result.error ?? "Échec");
      await loadAdmin();
    } catch { button.textContent = "Échec de la synchronisation"; }
    setTimeout(() => { button.disabled = false; button.textContent = "Synchroniser les paiements Stripe"; }, 3500);
  });
  $("#admin-export").addEventListener("click", () => {
    if (!state.data) return;
    const head = "email,inscription,plan,renouvellement,dernier_wallet,valeur_simulee,gain_perte_usd,gain_perte_pct,trades,paye_usd,derniere_activite";
    const lines = visible().map(subscriber => [subscriber.email, date(subscriber.createdAt), subscriber.plan, subscriber.renewsAt ? date(subscriber.renewsAt) : "", subscriber.lastWallet?.address ?? "", subscriber.totalValue?.toFixed(2) ?? "", subscriber.pnl?.toFixed(2) ?? "", subscriber.pnlPct?.toFixed(2) ?? "", subscriber.trades, (subscriber.paidCents / 100).toFixed(2), dateTime(subscriber.lastSyncAt)]
      .map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(","));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([[head, ...lines].join("\n")], { type: "text/csv" }));
    link.download = "pulse-abonnes.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  });
  state.timer = setInterval(() => { if (!$("#admin-view").hidden) loadAdmin(); }, 30_000);
}
wire();
