/** Wallet analyzer view: paste a Solana address, get realized / unrealized profit, win rate, entry timing and a per-token table. */
import { locale, t } from "./i18n.js";
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const state = { busy: false, last: null };

const sol = (value, digits = 2) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits })} SOL`;
const usd = (value, solUsd) => (solUsd > 0 && Math.abs(value * solUsd) >= 1 ? ` ≈ ${value >= 0 ? "+" : "−"}$${Math.abs(value * solUsd).toLocaleString(locale, { maximumFractionDigits: 0 })}` : "");
const pct = value => (value == null ? "—" : `${Math.round(value * 100)} %`);
const minutes = value => {
  if (value == null) return "—";
  if (value < 1) return "< 1 min";
  if (value < 90) return `${Math.round(value)} min`;
  if (value < 2880) return `${(value / 60).toLocaleString(locale, { maximumFractionDigits: 1 })} h`;
  return `${Math.round(value / 1440)} j`;
};
const short = address => `${address.slice(0, 4)}…${address.slice(-4)}`;
const tone = value => (value > 0.0005 ? "positive" : value < -0.0005 ? "negative" : "");

const NOTES = {
  coverage: ["warn", "Historique incomplet : seules certaines transactions ont pu être lues (limite du RPC public). Les chiffres sont partiels. Configure SOLANA_RPC_URL (ex. une URL Helius gratuite) pour tout analyser."],
  "small-sample": ["warn", "Échantillon trop petit (moins de 8 tokens tradés) : ces chiffres ne prouvent rien."],
  "free-tokens": ["bad", "Une grande part du gain vient de tokens reçus gratuitement (équipe, airdrop, wallet lié). Ce n'est pas du trading : ne copie pas ce wallet."],
  "mostly-unrealized": ["warn", "Le gain est surtout non réalisé : il disparaîtra si le wallet vend gros dans une liquidité faible."],
  "early-entries": ["good", "Entrées très précoces (médiane moins de 5 min après le lancement). Soit un bon sniper, soit un wallet qui connaît le projet : vérifie."],
  "few-big-wins": ["warn", "Peu de trades gagnants (< 40 %) mais un gain total positif : quelques gros coups portent les résultats, avec beaucoup de pertes."],
  dust: ["warn", "L'historique récent est rempli d'airdrops et de tokens poubelle reçus sans achat (ignorés ici). Les vrais trades de ce wallet sont probablement plus anciens : il faut un RPC dédié pour les atteindre."],
  "older-history": ["warn", "Certaines ventes concernent des tokens achetés avant la période analysée : leur coût est inconnu et exclu des gains réalisés."]
};

function render(result) {
  state.last = result;
  const { stats, coverage, solUsd } = result;
  const cards = [
    ["Gain total", sol(stats.totalSol), `${sol(stats.realizedSol)} ${t("réalisé")} · ${sol(stats.unrealizedSol)} ${t("non réalisé")}${usd(stats.totalSol, solUsd)}`, tone(stats.totalSol)],
    ["Taux de réussite", pct(stats.winRate), `${stats.wins} ${t("gagnants sur")} ${stats.closed} ${t("tokens vendus")}`, ""],
    ["Entrée médiane", minutes(stats.medianEntryMinutes), "après le lancement du token", ""],
    ["Durée de détention", minutes(stats.medianHoldMinutes), "médiane, achat → dernière vente", ""],
    ["Part de gain gratuit", pct(stats.freeProfitShare), "tokens reçus sans achat", stats.freeProfitShare >= 0.3 ? "negative" : ""]
  ];
  $("#wa-kpis").innerHTML = cards.map(([label, value, sub, cls]) => `<article class="kpi"><span>${esc(t(label))}</span><strong class="${cls}">${esc(value)}</strong><small>${esc(sub)}</small></article>`).join("");
  const from = coverage.from ? new Date(coverage.from).toLocaleDateString(locale) : "—";
  const to = coverage.to ? new Date(coverage.to).toLocaleDateString(locale) : "—";
  $("#wa-coverage").textContent = `${coverage.analysed} / ${coverage.requested} ${t("transactions lues")} · ${from} → ${to}${coverage.skipped ? ` · ${coverage.skipped} ${t("ignorées (multi-tokens)")}` : ""}${coverage.dustTokens ? ` · ${coverage.dustTokens} ${t("tokens poubelle ignorés")}` : ""}`;
  const unknown = stats.unknownCostProceedsSol;
  $("#wa-unknown").hidden = !(unknown > 0.05);
  $("#wa-unknown").textContent = unknown > 0.05 ? `${t("Ventes dont le coût d'achat est inconnu (achetées avant la période analysée ou reçues)")} : ${sol(unknown)}${usd(unknown, solUsd)}. ${t("Elles ne sont pas comptées dans le gain ci-dessus : le vrai gain peut être bien plus grand ou bien plus petit.")}` : "";
  $("#wa-notes").innerHTML = result.notes.filter(note => NOTES[note]).map(note => `<p class="wa-note ${NOTES[note][0]}">${esc(t(NOTES[note][1]))}</p>`).join("");
  $("#wa-body").innerHTML = result.tokens.map(token => {
    const label = token.symbol ? `$${esc(token.symbol)}` : esc(short(token.mint));
    const status = token.free ? `<span class="plan-pill bad">${esc(t("Reçu gratuit"))}</span>` : token.open ? `<span class="plan-pill ok">${esc(t("Ouvert"))}</span>` : `<span class="plan-pill neutral">${esc(t("Clôturé"))}</span>`;
    return `<tr>
      <td><a class="wallet-link" href="#" data-open-token="${esc(token.mint)}" title="${esc(t("Ouvrir ce token dans Pulse"))}">${label}</a><small class="since-note">${esc(token.name ?? short(token.mint))} · <a class="wallet-link" href="https://solscan.io/token/${esc(token.mint)}" target="_blank" rel="noopener noreferrer">Solscan ↗</a></small></td>
      <td>${status}${token.partial ? `<small class="since-note">${esc(t("achat avant la période"))}</small>` : ""}</td>
      <td>${token.spentSol > 0 ? esc(sol(-token.spentSol).replace(/^−/, "")) : "—"}</td>
      <td>${token.soldSol > 0 ? esc(sol(token.soldSol).replace(/^\+/, "")) : "—"}</td>
      <td class="${tone(token.realizedSol)}">${token.soldSol > 0 ? esc(sol(token.realizedSol)) : "—"}</td>
      <td class="${tone(token.unrealizedSol)}">${token.open ? esc(sol(token.unrealizedSol)) : "—"}${token.open && !token.priceKnown ? `<small class="since-note">${esc(t("prix inconnu"))}</small>` : ""}</td>
      <td>${esc(minutes(token.entryMinutes))}</td><td>${esc(minutes(token.holdMinutes))}</td></tr>`;
  }).join("");
  $("#wa-empty").hidden = result.tokens.length > 0;
  $("#wa-result").hidden = false;
}

async function analyze(address) {
  if (state.busy) return;
  const status = $("#wa-status");
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) { status.textContent = t("Adresse Ethereum (0x…) : Pulse analyse uniquement les wallets Solana."); return; }
  if (!ADDRESS.test(address)) { status.textContent = t("Adresse Solana invalide."); return; }
  state.busy = true;
  $("#wa-submit").disabled = true;
  status.textContent = t("Analyse en cours… (jusqu'à 30 s)");
  try {
    const response = await fetch(`/api/wallet-analysis?address=${encodeURIComponent(address)}`, { headers: { accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Échec");
    render(payload);
    status.textContent = `${t("Analyse de")} ${short(address)} · ${new Date(payload.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    $("#wa-result").hidden = true;
    status.textContent = t(error.message);
  }
  state.busy = false;
  $("#wa-submit").disabled = false;
}

$("#wa-body").addEventListener("click", event => {
  const link = event.target.closest("[data-open-token]");
  if (!link) return;
  event.preventDefault();
  document.dispatchEvent(new CustomEvent("pulse:open-token", { detail: { mint: link.dataset.openToken } }));
});
$("#wa-form").addEventListener("submit", event => { event.preventDefault(); analyze($("#wa-input").value.trim()); });
export function openWalletAnalysis(address) { $("#wa-input").value = address; analyze(address); }

/* ---- Wallets to follow: pump.fun leaderboard with copy / analyze / follow ---- */
const leaders = { period: "weekly", loaded: new Set() };
const followedWallets = () => { try { return new Set((JSON.parse(localStorage.getItem("pulse-follows") || "{}").list ?? []).map(item => item.wallet)); } catch { return new Set(); } };
const money = value => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString(locale, { maximumFractionDigits: 0 })}`;

function renderLeaders(entries) {
  const followed = followedWallets();
  $("#wa-leaders").innerHTML = entries.map(entry => {
    const on = followed.has(entry.wallet);
    const avatar = entry.profileImage ? `<span class="standing-avatar"><img src="${esc(entry.profileImage)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : `<span class="standing-avatar">${esc(entry.username.slice(0, 2).toUpperCase())}</span>`;
    return `<div class="leader-row">
      <span class="standing-rank">${entry.rank}</span>${avatar}
      <span class="standing-name"><strong>${esc(entry.username)}</strong><small title="${esc(entry.wallet)}">${esc(entry.shortWallet)}${entry.topSymbols.length ? ` · ${esc(entry.topSymbols.map(symbol => `$${symbol}`).join(" "))}` : ""}</small></span>
      <span class="standing-pnl"><strong class="${entry.pnlUsd >= 0 ? "positive" : "negative"}">${esc(money(entry.pnlUsd))}</strong><small class="since-note">${entry.positions} ${esc(t("positions"))}</small></span>
      <span class="leader-actions">
        <button class="text-button" type="button" data-copy="${esc(entry.wallet)}">${esc(t("Copier"))}</button>
        <button class="text-button" type="button" data-analyze="${esc(entry.wallet)}">${esc(t("Analyser"))}</button>
        <span class="follow-btn ${on ? "on" : ""}" role="button" tabindex="0" data-follow="${esc(entry.wallet)}" data-name="${esc(entry.username)}" data-image="${esc(entry.profileImage ?? "")}">${on ? t("Suivi ✓") : t("+ Suivre")}</span>
      </span></div>`;
  }).join("");
}

async function loadLeaders() {
  const status = $("#wa-leaders-status");
  status.textContent = t("chargement…");
  try {
    const response = await fetch(`/api/standings?period=${leaders.period}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const board = (await response.json()).board;
    renderLeaders((board?.entries ?? []).filter(entry => entry.wallet).slice(0, 25));
    status.textContent = `${t("mis à jour")} ${new Date().toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
  } catch { status.textContent = t("indisponible"); }
}

$("#wa-period").addEventListener("click", event => {
  const button = event.target.closest("[data-period]");
  if (!button) return;
  leaders.period = button.dataset.period;
  document.querySelectorAll("#wa-period [data-period]").forEach(item => item.classList.toggle("active", item === button));
  loadLeaders();
});
$("#wa-leaders").addEventListener("click", async event => {
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); copy.textContent = t("Copié ✓"); }
    catch { copy.textContent = copy.dataset.copy; }
    setTimeout(() => { copy.textContent = t("Copier"); }, 1800);
    return;
  }
  const run = event.target.closest("[data-analyze]");
  if (run) { window.scrollTo({ top: 0, behavior: "smooth" }); openWalletAnalysis(run.dataset.analyze); }
});
loadLeaders();
