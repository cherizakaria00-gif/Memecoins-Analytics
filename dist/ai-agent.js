/** AI Agent page: learning progress, model quality, the best entries right now and what the model learned. */
import { lang, locale, t } from "./i18n.js";
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const money = value => (value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `$${(value / 1e3).toFixed(1)}K` : `$${Math.round(value || 0)}`);
const pct = value => (value == null ? "—" : `${(value * 100).toLocaleString(locale, { maximumFractionDigits: 0 })} %`);
const ago = ms => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return t("à l'instant");
  const text = minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return lang === "fr" ? `il y a ${text}` : `${text} ago`;
};
const age = minutes => (minutes < 90 ? `${Math.round(minutes)} min` : minutes < 2880 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes / 1440)} j`);
let timer = null;
let band = "all";
try { band = localStorage.getItem("pulse-ai-band") || "all"; } catch { /* storage unavailable */ }
let bands = [];

const BAND_LIMITS = { all: [0, 0], micro: [0, 100_000], small: [100_000, 500_000], mid: [500_000, 2_000_000], large: [2_000_000, 10_000_000], huge: [10_000_000, 0] };

function renderBands() {
  const chips = [{ id: "all", label: "Toutes", win: 0, loss: 0 }, ...bands];
  $("#ai-bands").innerHTML = chips.map(item => {
    const known = item.win + item.loss;
    const sub = item.id === "all" ? "" : `<small>${known ? `${item.win}/${known} ${t("gagnants")}${known < 20 ? ` · ${t("peu de données")}` : ""}` : t("aucun résultat")}</small>`;
    return `<button type="button" class="ai-band ${item.id === band ? "active" : ""}" data-band="${item.id}"><span>${esc(t(item.label))}</span>${sub}</button>`;
  }).join("");
}

function renderStatus(status) {
  bands = status.bands ?? bands;
  renderBands();
  const { samples, model, definition, ready } = status;
  const labeled = samples.win + samples.loss;
  const cards = [
    ["Coins observés", String(samples.open + labeled + samples.lost), `${samples.open} ${t("en cours de suivi")}`, ""],
    ["Résultats connus", String(labeled), `${samples.win} ${t("gagnants")} · ${samples.loss} ${t("perdants")}`, ""],
    ["Taux de victoire de base", labeled ? pct(samples.win / labeled) : "—", `+${definition.winPct} % ${t("avant")} −${definition.stopPct} % ${t("en")} ${definition.horizonMin / 60} h`, ""],
    ["Qualité du modèle (AUC)", model?.auc != null ? model.auc.toFixed(2) : "—", model ? `${t("testé sur")} ${model.holdoutN} ${t("coins jamais vus")}` : t("pas encore entraîné"), model?.auc >= 0.6 ? "positive" : ""],
    ["Gain par rapport au hasard", model?.lift != null ? `×${model.lift.toFixed(1)}` : "—", model?.topRate != null ? `${pct(model.topRate)} ${t("de victoires dans son top 20 %")}` : "", model?.lift >= 1.3 ? "positive" : ""]
  ];
  $("#ai-kpis").innerHTML = cards.map(([label, value, sub, tone]) => `<article class="kpi"><span>${esc(t(label))}</span><strong class="${tone}">${esc(value)}</strong><small>${esc(sub)}</small></article>`).join("");
  $("#ai-status").textContent = ready ? `· ${t("modèle validé")} ${model?.trainedAt ? ago(model.trainedAt) : ""}` : `· ${t("en apprentissage")}`;
  $("#ai-status").className = ready ? "positive" : "";
  const progress = $("#ai-progress");
  progress.hidden = ready;
  if (!ready) {
    const share = Math.min(labeled / definition.minLabeled, 1);
    $("#ai-progress-bar").style.width = `${Math.round(share * 100)}%`;
    $("#ai-progress-text").textContent = `${labeled} / ${definition.minLabeled} ${t("résultats connus nécessaires pour entraîner le premier modèle")} (${t("au moins")} ${definition.minPerClass} ${t("gagnants et")} ${definition.minPerClass} ${t("perdants")})`;
  }
  const note = $("#ai-note");
  note.hidden = false;
  if (!ready && model) note.textContent = t("Le modèle existe mais n'a pas encore prouvé qu'il fait mieux que le hasard sur des coins qu'il n'a jamais vus : il n'est pas utilisé. Il continue d'apprendre.");
  else if (!ready) note.textContent = t("Pulse doit tourner et regarder le marché pendant plusieurs heures avant d'avoir assez de résultats. Laisse l'application ouverte (ou le serveur allumé) : tout est enregistré sur ton serveur.");
  else note.hidden = true;
  const weights = status.importance ?? [];
  const top = Math.max(...weights.map(item => Math.abs(item.weight)), 0.001);
  $("#ai-weights").innerHTML = weights.length ? weights.map(item => `<div class="ai-weight"><span>${esc(t(item.label))}</span><div class="ai-bar"><i class="${item.weight >= 0 ? "pos" : "neg"}" style="width:${Math.round(Math.abs(item.weight) / top * 100)}%"></i></div><b class="${item.weight >= 0 ? "positive" : "negative"}">${item.weight >= 0 ? "+" : "−"}${Math.abs(item.weight).toFixed(2)}</b></div>`).join("") : `<p class="signals-help">${esc(t("Rien à montrer tant qu'aucun modèle n'a été entraîné."))}</p>`;
}

function renderPicks(payload) {
  const rows = payload.picks ?? [];
  $("#ai-picks-status").textContent = payload.ready ? `${rows.length} ${t("coins notés")}` : "";
  const empty = $("#ai-picks-empty");
  empty.hidden = rows.length > 0;
  empty.textContent = payload.ready ? (band === "all" ? t("Aucun coin noté pour le moment.") : t("Aucun coin de cette zone de market cap pour le moment.")) : t("Aucune entrée proposée tant que le modèle n'est pas validé : l'agent préfère ne rien dire plutôt que deviner.");
  $("#ai-picks").innerHTML = rows.map(row => {
    const avatar = row.imageUrl ? `<span class="mini-avatar"><img src="${esc(row.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>` : `<span class="mini-avatar">${esc((row.initials ?? row.symbol ?? "?").slice(0, 2).toUpperCase())}</span>`;
    const why = [...(row.pros ?? []).map(label => `<span class="ai-chip pro">${esc(t(label))}</span>`), ...(row.cons ?? []).map(label => `<span class="ai-chip con">${esc(t(label))}</span>`)].join("");
    return `<tr class="ai-pick" data-open-token="${esc(row.id)}" tabindex="0">
      <td><div class="token-cell">${avatar}<span><strong>${esc(row.name ?? row.symbol)}</strong><small class="since-note">$${esc(row.symbol)}${row.unlisted ? ` · ${esc(t("pas encore sur DexScreener"))}` : ""}</small></span></div></td>
      <td><strong class="${row.p >= 0.5 ? "positive" : ""}">${pct(row.p)}</strong></td><td>${why}</td><td>${money(row.marketCap)}</td><td>${money(row.liquidity)}</td><td>${age(row.ageMinutes ?? 0)}</td></tr>`;
  }).join("");
}

async function load() {
  try {
    const [status, picks] = await Promise.all([fetch("/api/ai/status", { headers: { accept: "application/json" } }), fetch(`/api/ai/picks?minMcap=${BAND_LIMITS[band]?.[0] ?? 0}&maxMcap=${BAND_LIMITS[band]?.[1] ?? 0}`, { headers: { accept: "application/json" } })]);
    if (status.ok) renderStatus(await status.json());
    if (picks.ok) renderPicks(await picks.json());
  } catch { $("#ai-status").textContent = `· ${t("indisponible")}`; }
}

$("#ai-bands").addEventListener("click", event => {
  const chip = event.target.closest("[data-band]");
  if (!chip) return;
  band = chip.dataset.band;
  try { localStorage.setItem("pulse-ai-band", band); } catch { /* storage unavailable */ }
  renderBands();
  load();
});
$("#ai-picks").addEventListener("click", event => { const row = event.target.closest("[data-open-token]"); if (row) document.dispatchEvent(new CustomEvent("pulse:open-token", { detail: { mint: row.dataset.openToken } })); });

export function startAiAgentView() {
  load();
  clearInterval(timer);
  timer = setInterval(() => { if ($("#aiagent-view").hidden) { clearInterval(timer); return; } load(); }, 20_000);
}
