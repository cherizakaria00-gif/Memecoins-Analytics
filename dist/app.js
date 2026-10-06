import { locale, t } from "./i18n.js";
import { createCoinChart } from "./coin-chart.js";
import { createEquityChart } from "./equity-chart.js";
import { profitTransition, addEquityPoint, allocation, barScale, donutSvg, formatDuration, limitProgress, maxDrawdown, pnlByDay, pnlByToken, tradeStats } from "./dashboard.js";
import { base58Encode, base64ToBytes, costBasis, describeOrder, lamportsToSol, limitBreach, orderPrioritySol, positionValue as livePositionValue, rawFraction, rawToUi, upsertOrder } from "./live.js";
import { DEFAULT_BOT, botPnlToday, botStats, normalizeBot, normalizePending, pickEntries } from "./autobot.js";
import { buildTradePlan, exitAdvice, planPercents } from "./trade-plan.js";
import { detectWallets, iconForName, removeWallet, shortAddress, toAddress, totalSol, upsertWallet } from "./wallets.js";
import { normalizeLimitOrders, settleLimitOrders, FEE_PRESETS, START_BALANCE, buildTradeMarkers, costsFor, presetById, presetForCapital, checkTriggers, normalizeWallet, sellFraction, openPosition, positionValue, pushHistory, quoteBuy, summarizeHistory, validateBuy } from "./paper-trading.js";

let tokens = [
  { id: "pbot", name: "PEPEBOT", symbol: "PBOT", initials: "PB", age: "18 min", liquidity: 184200, volume: 96200, change: 32.4, risk: "Faible", score: 86, price: 0.004218, accent: "#b8f55d", holders: "1 842", lock: "100 %", top10: "18,2 %", mint: true, freeze: true },
  { id: "wifx", name: "WIF X", symbol: "WIFX", initials: "WX", age: "34 min", liquidity: 128600, volume: 71400, change: 18.7, risk: "Faible", score: 78, price: 0.000841, accent: "#5fe0d0", holders: "926", lock: "92 %", top10: "22,5 %", mint: true, freeze: true },
  { id: "mogz", name: "MOG ZERO", symbol: "MOGZ", initials: "MZ", age: "1 h 12", liquidity: 94200, volume: 108900, change: 64.2, risk: "Moyen", score: 72, price: 0.000065, accent: "#ffc65c", holders: "2 104", lock: "80 %", top10: "31,8 %", mint: true, freeze: false },
  { id: "bonk2", name: "BONK TWO", symbol: "BNK2", initials: "B2", age: "2 h 08", liquidity: 62300, volume: 49700, change: -8.6, risk: "Moyen", score: 61, price: 0.000013, accent: "#ff9b62", holders: "712", lock: "76 %", top10: "38,4 %", mint: true, freeze: false },
  { id: "rugr", name: "RUG RUNNER", symbol: "RUGR", initials: "RR", age: "7 min", liquidity: 21800, volume: 83200, change: 122.5, risk: "Élevé", score: 34, price: 0.000002, accent: "#ff6b62", holders: "318", lock: "0 %", top10: "71,3 %", mint: false, freeze: false },
  { id: "degen", name: "DEGEN AI", symbol: "DGEN", initials: "DA", age: "3 h 41", liquidity: 210400, volume: 135800, change: 11.2, risk: "Faible", score: 81, price: 0.002704, accent: "#8bb7ff", holders: "3 421", lock: "100 %", top10: "16,9 %", mint: true, freeze: true },
  { id: "moon", name: "MOON TAPE", symbol: "TAPE", initials: "MT", age: "48 min", liquidity: 45700, volume: 38800, change: -21.4, risk: "Élevé", score: 42, price: 0.000091, accent: "#ff6b62", holders: "489", lock: "24 %", top10: "58,1 %", mint: false, freeze: true }
];

const formatMoney = (value, decimals = 0) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: decimals }).format(value);
const formatCompact = value => new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value) + " $";
const formatPrice = value => value.toLocaleString(locale, { minimumFractionDigits: value < .001 ? 6 : 4, maximumFractionDigits: 6 }) + " $";
const signed = value => `${value >= 0 ? "+" : ""}${value.toLocaleString(locale, { maximumFractionDigits: 1 })} %`;
const formatInteger = value => Number.isFinite(value) ? value.toLocaleString(locale) : "—";
const formatMarketMoney = value => Number.isFinite(value) && value > 0 ? formatCompact(value) : "—";
const formatMarketChange = value => Number.isFinite(value) ? signed(value) : "—";
const parseMetric = value => Number(String(value).replace(",", ".").replace(/[^\d.-]/g, ""));
const LIVE_REFRESH_MS = 20_000;

function loadFeeMode() {
  try { const mode = localStorage.getItem("pulse-fee-mode"); return mode === "auto" || FEE_PRESETS.some(preset => preset.id === mode) ? mode : "auto"; } catch { return "auto"; }
}

function loadQualityFilter() {
  try { return localStorage.getItem("pulse-quality-filter") !== "0"; } catch { return true; }
}

function loadCustom() {
  try { return JSON.parse(localStorage.getItem("pulse-custom") || "[]").filter(id => typeof id === "string").slice(0, 40); } catch { return []; }
}
function saveCustom() {
  try { localStorage.setItem("pulse-custom", JSON.stringify([...state.custom])); } catch { /* storage unavailable */ }
}

function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem("pulse-watchlist") || "[]"); } catch { return []; }
}
function saveWatchlist() {
  try { localStorage.setItem("pulse-watchlist", JSON.stringify([...state.watchlist])); } catch { /* storage unavailable */ }
}

function loadWallet() {
  try { return normalizeWallet(JSON.parse(localStorage.getItem("pulse-wallet") || "null")); } catch { return normalizeWallet(null); }
}
const savedWallet = loadWallet();
const state = {
  selected: tokens[0].id,
  filter: "all",
  query: "",
  ageWindow: 24,
  minimumVolume: 0,
  timeframe: "change6h",
  marketMode: "trending",
  sort: { key: "score", direction: "desc" },
  balance: savedWallet.balance,
  positions: savedWallet.positions,
  history: savedWallet.history,
  wallets: [],
  activeWalletId: null,
  market: { live: false, updatedAt: null, nextRefreshAt: null, loading: false },
  priceHistory: new Map(),
  watchlist: new Set(loadWatchlist()),
  held: new Map(),
  holderStats: new Map(),
  adhoc: new Map(),
  custom: new Set(loadCustom()),
  qualityFilter: loadQualityFilter(),
  mode: (() => { try { return localStorage.getItem("pulse-mode") === "live" ? "live" : "test"; } catch { return "test"; } })(),
  feeMode: loadFeeMode()
};

const table = document.querySelector("#token-table");
const emptyState = document.querySelector("#empty-state");
const toast = document.querySelector("#toast");
const PLAN_BADGE = { buy: ["Bon point d'entrée", "up"], wait: ["Attendre un repli", "warn"], breakout: ["Cassure à surveiller", "info"], avoid: ["Pas d'entrée", "down"], unknown: ["Indisponible", "neutral"] };
const planCache = new Map();
const standardWallets = new Set();
const standardAdapters = new WeakMap();
const observedProviders = new WeakSet();

function registerStandardWallets(...wallets) {
  for (const wallet of wallets) {
    if (wallet?.features?.["standard:connect"] && wallet?.chains?.some?.(chain => String(chain).startsWith("solana:"))) {
      standardWallets.add(wallet);
    }
  }
  renderWallet();
  if (!document.querySelector("#wallet-modal").hidden) renderWalletChoices();
  return () => wallets.forEach(wallet => standardWallets.delete(wallet));
}

window.addEventListener("wallet-standard:register-wallet", event => {
  if (typeof event.detail === "function") event.detail({ register: registerStandardWallets });
});
window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", {
  detail: Object.freeze({ register: registerStandardWallets })
}));

function riskClass(risk) { return risk === "Faible" ? "low" : risk === "Moyen" ? "medium" : risk === "Élevé" ? "high" : "unknown"; }
function scoreClass(score) { return score >= 70 ? "good" : score >= 50 ? "warn" : "bad"; }
function currentToken() { return tokens.find(token => token.id === state.selected) ?? state.adhoc.get(state.selected) ?? tokens[0]; }
function saveWallet() {
  try { localStorage.setItem("pulse-wallet", JSON.stringify({ balance: state.balance, positions: state.positions, history: state.history })); } catch { /* storage unavailable */ }
}

const TREND_VOLUME_KEY = { change5m: "volume5m", change: "volume", change6h: "volume6h", change24h: "volume24h" };

function visibleTokens() {
  return tokens.filter(token => {
    const matchesFilter = state.filter === "all" || (state.filter === "qualified" && (token.signal ? token.signal.tradable : token.score >= 70)) || (state.filter === "risky" && token.risk === "Élevé") || (state.filter === "early" && Boolean(token.early?.early)) || (state.filter === "pump" && Boolean(token.pump)) || (state.filter === "watch" && state.watchlist.has(token.id));
    const pinned = state.custom.has(token.id);
    const matchesAge = pinned || state.ageWindow === "all" || Number(token.ageMinutes) <= Number(state.ageWindow) * 60;
    const matchesVolume = pinned || Number(token.volume24h) >= state.minimumVolume;
    const matchesMode = true;
    const haystack = `${token.name} ${token.symbol}`.toLowerCase();
    const matchesQuality = !state.qualityFilter || pinned || token.quality?.passes !== false;
    return matchesQuality && matchesFilter && matchesAge && matchesVolume && matchesMode && haystack.includes(state.query.toLowerCase());
  }).sort((first, second) => {
    const firstValue = first[state.sort.key];
    const secondValue = second[state.sort.key];
    const result = typeof firstValue === "string"
      ? firstValue.localeCompare(String(secondValue ?? ""), "fr")
      : (Number(firstValue) || 0) - (Number(secondValue) || 0);
    return state.sort.direction === "asc" ? result : -result;
  });
}

function renderMarketTotals() {
  const totalVolume = tokens.reduce((sum, token) => sum + (Number(token.volume24h) || 0), 0);
  const totalTransactions = tokens.reduce((sum, token) => sum + (Number(token.transactions) || 0), 0);
  document.querySelector("#total-volume-24h").textContent = formatMarketMoney(totalVolume);
  document.querySelector("#total-transactions-24h").textContent = formatInteger(totalTransactions);
}

function applyMarketMode(mode = state.marketMode) {
  state.marketMode = mode;
  if (mode === "top") state.sort = { key: "marketCap", direction: "desc" };
  else if (mode === "oldest") state.sort = { key: "ageMinutes", direction: "desc" };
  else if (mode === "new") state.sort = { key: "ageMinutes", direction: "asc" };
  else if (mode === "trending") state.sort = { key: TREND_VOLUME_KEY[state.timeframe], direction: "desc" };
  else state.sort = { key: state.timeframe, direction: "desc" };
  document.querySelectorAll("[data-market-mode]").forEach(button => button.classList.toggle("active", button.dataset.marketMode === mode));
  document.querySelectorAll("[data-sort]").forEach(button => {
    const active = button.dataset.sort === state.sort.key;
    button.classList.toggle("active", active);
    if (active) button.dataset.direction = state.sort.direction;
    else delete button.dataset.direction;
  });
  renderTable();
}

function formatTokenAge(token) {
  const minutes = Math.floor(Number(token.ageMinutes) + (token.seenAt ? (Date.now() - token.seenAt) / 60_000 : 0));
  if (!Number.isFinite(minutes)) return token.age ?? "—";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  const days = Math.floor(minutes / 1440);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => HTML_ESCAPES[char]);

function avatarContent(token) {
  return token.imageUrl
    ? `<img src="${esc(token.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span class="avatar-initials">${esc(token.initials)}</span>`
    : esc(token.initials);
}

document.addEventListener("error", event => {
  const avatar = event.target instanceof HTMLImageElement ? event.target.closest(".mini-avatar, .token-avatar") : null;
  if (!avatar) return;
  event.target.remove();
  avatar.classList.add("no-image");
}, true);

function formatAthMarketCap(token) {
  return Number.isFinite(token.athMarketCap) && token.athMarketCap > 0 ? formatCompact(token.athMarketCap) : "—";
}

function athBar(token) {
  if (!(token.athMarketCap > 0) || !(token.marketCap > 0)) return '<span class="ath-bar empty"></span>';
  const ratio = Math.min(token.marketCap / token.athMarketCap, 1);
  const tone = ratio >= 0.9 ? "hot" : ratio >= 0.4 ? "ok" : "low";
  return `<span class="ath-bar ${tone}"><i style="width:${Math.max(6, Math.round(ratio * 100))}%"></i></span>`;
}

function sparklineSvg(token) {
  const prices = Array.isArray(token.priceHistory) && token.priceHistory.length >= 2 ? token.priceHistory : null;
  if (!prices) return '<span class="graph-empty">—</span>';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spread = max - min || 1;
  const points = prices.map((price, index) => `${(index / (prices.length - 1)) * 100},${34 - ((price - min) / spread) * 30}`);
  const up = prices[prices.length - 1] >= prices[0];
  const tone = up ? "up" : "down";
  return `<svg class="spark ${tone}" viewBox="0 0 100 38" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,38 ${points.join(" ")} 100,38"></polygon><polyline points="${points.join(" ")}"></polyline></svg>`;
}

function changePill(value, movement) {
  if (!Number.isFinite(value)) return '<span class="pill neutral">—</span>';
  const tone = value > 0 ? "up" : value < 0 ? "down" : "neutral";
  const arrow = value > 0 ? "↑" : value < 0 ? "↓" : "";
  return `<span class="pill ${tone} ${movement ?? ""}">${arrow} ${Math.abs(value).toLocaleString(locale, { maximumFractionDigits: 1 })}%</span>`;
}

function renderTable() {
  const visible = visibleTokens();
  const hidden = tokens.filter(token => token.quality && !token.quality.passes).length;
  const counter = document.querySelector("#quality-count");
  if (counter) counter.textContent = state.qualityFilter && hidden ? `(${hidden} masqués)` : "";
  table.innerHTML = visible.map((token, index) => {
    const mcapTone = token.movement?.marketCap === "tick-up" ? "up" : token.movement?.marketCap === "tick-down" ? "down" : "";
    const starred = state.watchlist.has(token.id);
    const customTag = state.custom.has(token.id) ? `<em class="tag custom">perso</em><button class="remove-custom" type="button" data-remove-custom="${esc(token.id)}" aria-label="Retirer de ma liste" title="Retirer de ma liste">×</button>` : "";
    const qualifiedTag = isQualified(token) ? `<em class="tag qualified-tag">qualifié</em>` : "";
    const earlyTag = token.early?.early ? `<em class="tag early-tag" title="${esc(token.early.stage)}">⚡ démarrage</em>` : "";
    const badge = token.pump ? `<em class="tag">${token.pump.graduated ? "gradué" : "pump"}</em>` : "";
    return `
    <tr class="token-row ${token.id === state.selected ? "selected" : ""} ${isQualified(token) ? "qualified" : ""}" data-id="${esc(token.id)}" tabindex="0" aria-label="Voir ${esc(token.name)}">
      <td><div class="token-cell"><span class="token-rank">${index + 1}</span><span class="mini-avatar" style="--accent:${esc(token.accent)}">${avatarContent(token)}</span><div><strong>${esc(token.name)}</strong><span>$${esc(token.symbol)} ${earlyTag}${qualifiedTag}${badge}${customTag}</span></div></div></td>
      <td class="graph-cell" data-cell="graph">${sparklineSvg(token)}</td>
      <td class="market-cap ${mcapTone}" data-cell="mcap">${formatMarketMoney(token.marketCap)}</td>
      <td class="ath-cell" data-cell="ath">${athBar(token)}<span>${formatAthMarketCap(token)}</span></td>
      <td class="token-age" data-cell="age">${formatTokenAge(token)}</td>
      <td data-cell="txns">${formatInteger(token.transactions)}</td>
      <td data-cell="vol">${formatMarketMoney(token.volume24h)}</td>
      <td>${formatInteger(token.traders)}</td>
      <td data-cell="c1h">${changePill(token.change, token.movement?.change)}</td>
      <td data-cell="c6h">${changePill(token.change6h, token.movement?.change6h)}</td>
      <td data-cell="c24h">${changePill(token.change24h, token.movement?.change24h)}</td>
      <td><span class="score ${scoreClass(token.score)}" title="${esc(token.signal ? (token.signal.flags[0] ?? token.signal.reasons.slice(0, 3).join(" · ")) : "")}">${token.signal && token.signal.grade !== "avoid" ? `${token.signal.grade} ` : ""}${token.score}</span></td>
      <td class="star-cell"><button class="star-button ${starred ? "on" : ""}" type="button" data-star="${esc(token.id)}" aria-pressed="${starred}" aria-label="${starred ? "Retirer des favoris" : "Ajouter aux favoris"}">${starred ? "★" : "☆"}</button></td>
    </tr>`;
  }).join("");
  emptyState.hidden = visible.length > 0;
}

const QUALITY_STAGE_LABEL = { new: "Nouvelle paire", final: "Dernière ligne droite", migrated: "Migré" };

function badge(text, tone, title = "") {
  return `<span class="cbadge ${tone}" title="${esc(title)}">${esc(text)}</span>`;
}

/** Header of the coin window: badges and the key numbers of the token, like the top bar of a pump.fun coin page. */
function renderCoinHeader(token) {
  const holders = token.holderStats ?? state.security.get(token.id)?.holders ?? state.holderStats.get(token.id);
  const holdersText = holders?.totalHolders ? formatInteger(holders.totalHolders) : (token.holders == null ? "—" : String(token.holders));
  document.querySelector("#coin-stats").innerHTML = [
    ["Market cap", formatMarketMoney(token.marketCap)], ["Volume 24 h", formatMarketMoney(token.volume24h)], ["Liquidité", formatMarketMoney(token.liquidity)],
    ["Détenteurs", holdersText], ["ATH", formatAthMarketCap(token)], ["Âge", formatTokenAge(token)]
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");

  const badges = [];
  if (token.pump) badges.push(badge(token.pump.graduated ? "Pump.fun · migré" : "Pump.fun", "purple"));
  if (token.quality) badges.push(badge(token.quality.passes ? "Filtre Pulse ✓" : "Filtre Pulse ✗", token.quality.passes ? "good" : "bad", `Étape : ${QUALITY_STAGE_LABEL[token.quality.stage]}`));
  if (token.early?.early) badges.push(badge("⚡ Démarrage", "amber", token.early.stage));
  if (token.signal?.tradable) badges.push(badge(`Qualifié ${token.signal.grade}`, "good"));
  if (state.custom.has(token.id)) badges.push(badge("Ajouté par toi", "blue"));
  document.querySelector("#coin-badges").innerHTML = badges.join("");
}

/** Two lines that answer "should I look at this coin?" before any detail: the signal and the trade plan. */
function renderVerdict() {
  const token = currentToken();
  const card = document.querySelector("#verdict-card");
  if (!token || !card) return;
  const signal = token.signal;
  let signalLine;
  if (token.early?.early) signalLine = ["⚡", "amber", `Démarrage détecté`, `Début de mouvement (${token.early.stage}), score ${token.early.score}/100.`];
  else if (signal?.tradable) signalLine = ["✓", "good", `Qualifié · note ${signal.grade} (${signal.score}/100)`, signal.reasons.slice(0, 2).join(" · ")];
  else if (signal?.grade === "C") signalLine = ["◐", "amber", `À surveiller · note C (${signal.score}/100)`, "Presque qualifié : un critère manque encore."];
  else signalLine = ["✗", "bad", "À éviter", signal?.flags?.[0] ?? "Le signal est trop faible."];
  const plan = state.plan && !coinModal.hidden ? state.plan : null;
  const [planLabel, planTone] = plan ? (PLAN_BADGE[plan.state] ?? PLAN_BADGE.unknown) : ["Calcul en cours…", "neutral"];
  const planDetail = plan?.stop ? `Entrée ${planMoney(plan.entry.low)} – ${planMoney(plan.entry.high)} · SL −${Math.round(plan.stop.pct * 100)} % · TP1 +${Math.round(plan.targets[0].pct * 100)} %` : (plan?.notes?.[0] ?? "");
  card.innerHTML = `<div class="verdict-line ${signalLine[1]}"><span class="verdict-icon">${signalLine[0]}</span><div><strong>${esc(signalLine[2])}</strong><small>${esc(signalLine[3])}</small></div></div>
    <div class="verdict-line ${planTone}"><span class="verdict-icon">▸</span><div><strong>Plan : ${esc(plan?.label ?? planLabel)}</strong><small>${esc(planDetail)}</small></div></div>`;
}

function checkRow([ok, label, value]) {
  return `<div class="check-row"><span class="check-icon ${ok == null ? "unknown" : ok ? "" : "fail"}">${ok == null ? "?" : ok ? "✓" : "×"}</span><span>${esc(label)}</span><span>${esc(value)}</span></div>`;
}

function renderDetail() {
  const token = currentToken();
  document.querySelector("#detail-avatar").innerHTML = avatarContent(token);
  document.querySelector("#detail-avatar").style.setProperty("--accent", token.accent);
  document.querySelector("#detail-name").textContent = token.name;
  document.querySelector("#detail-symbol").textContent = `$${token.symbol}`;
  document.querySelector("#detail-score").textContent = token.score;
  document.querySelector("#detail-price").textContent = formatPrice(token.price);
  const change = document.querySelector("#detail-change");
  change.textContent = signed(token.change);
  change.className = token.change >= 0 ? "positive" : "negative";
  document.querySelector(".score-orbit").style.borderColor = token.score >= 70 ? "var(--acid)" : token.score >= 50 ? "var(--amber)" : "var(--danger)";
  renderCoinHeader(token);

  const security = state.security.get(token.id);
  const holderStats = token.holderStats ?? state.holderStats.get(token.id);
  const authority = (key, fallback) => (security?.authorities ? security.authorities[key] : fallback);
  const mintRevoked = authority("mintRevoked", token.mint);
  const freezeRevoked = authority("freezeRevoked", token.freeze);
  const securityRows = [
    [mintRevoked, "Autorité de mint", mintRevoked == null ? "NON VÉRIFIÉE" : mintRevoked ? "RÉVOQUÉE" : "ACTIVE"],
    [freezeRevoked, "Autorité de gel", freezeRevoked == null ? "NON VÉRIFIÉE" : freezeRevoked ? "RÉVOQUÉE" : "ACTIVE"],
    [token.lock == null ? null : parseMetric(token.lock) >= 75, "Liquidité verrouillée", token.lock ?? "NON VÉRIFIÉE"],
    [token.top10 == null ? null : parseMetric(token.top10) < 40, "Concentration top 10", token.top10 ?? "NON VÉRIFIÉE"],
    [token.holders == null ? null : parseMetric(token.holders) > 500, "Détenteurs", token.holders ?? "NON VÉRIFIÉS"]
  ];
  if (holderStats?.available !== false && holderStats?.reliable) {
    const insiders = holderStats.sniperPct + holderStats.bundlerPct + holderStats.devPct;
    securityRows[3] = [holderStats.top10Pct < 40, "Concentration top 10", `${holderStats.top10Pct.toLocaleString(locale, { maximumFractionDigits: 1 })} %`];
    securityRows[4] = [holderStats.totalHolders > 500, "Détenteurs", formatInteger(holderStats.totalHolders)];
    securityRows.push([insiders < 15, "Snipers / bundlers / dev", `${insiders.toLocaleString(locale, { maximumFractionDigits: 1 })} % (${holderStats.sniperCount} snipers, ${holderStats.bundlerCount} bundlers)`]);
  }

  const groups = [];
  if (token.signal) {
    groups.push({
      title: `Signal d'entrée · note ${token.signal.grade === "avoid" ? "à éviter" : token.signal.grade} (${token.signal.score}/100)`,
      rows: [...token.signal.flags.map(flag => [false, flag, "ÉVITER"]), ...token.signal.reasons.slice(0, 6).map(reason => [true, reason, ""])]
    });
  }
  if (token.quality) {
    const valueText = check => (check.value == null ? "inconnu" : check.unit === "min" ? `${Math.floor(check.value)} min` : check.unit === "sol" ? `${check.value.toLocaleString(locale, { maximumFractionDigits: 2 })} SOL` : formatMarketMoney(check.value));
    const minText = check => (check.unit === "sol" ? `${check.min} SOL` : check.unit === "min" ? `${check.min} min` : formatMarketMoney(check.min));
    groups.push({
      title: `Filtre Pulse · ${QUALITY_STAGE_LABEL[token.quality.stage]} · ${token.quality.passes ? "validé" : "sous les minimums"}`,
      rows: token.quality.checks.map(check => [check.ok, check.label, `${valueText(check)} / min ${minText(check)}`])
    });
  }
  groups.push({ title: "Sécurité du token", rows: securityRows });
  if (token.pump) {
    const ratio = token.athMarketCap > 0 && token.marketCap > 0 ? Math.min(token.marketCap / token.athMarketCap, 1) : null;
    groups.push({
      title: "Pump.fun",
      rows: [
        [token.pump.graduated, "Bonding curve", token.pump.graduated ? "GRADUÉE (migrée)" : "EN COURS"],
        [ratio == null ? null : ratio >= 0.35, "Distance de l'ATH", ratio == null ? "—" : `${Math.round(ratio * 100)} % de l'ATH`],
        [token.pump.replyCount > 0 ? true : null, "Réponses communauté", formatInteger(token.pump.replyCount)],
        [token.pump.hasSocials ? true : null, "Réseaux sociaux", token.pump.hasSocials ? "PRÉSENTS" : "AUCUN"]
      ]
    });
  }
  document.querySelector("#checks").innerHTML = groups.map(group => `<h4 class="check-group">${esc(group.title)}</h4>${group.rows.map(checkRow).join("")}`).join("");

  const problems = (token.signal?.flags.length ?? 0) + securityRows.filter(row => row[0] === false).length;
  const tabBadge = document.querySelector("#signal-tab-badge");
  tabBadge.hidden = problems === 0;
  tabBadge.textContent = `⚠ ${problems}`;
  renderVerdict();
  updateWalletUI();
}

/* Tabs of the coin window: the plan first, then security, signal and news. */
function setCoinTab(tab) {
  state.coinTab = tab;
  try { localStorage.setItem("pulse-coin-tab", tab); } catch { /* storage unavailable */ }
  document.querySelectorAll("#coin-tabs [data-ctab]").forEach(button => {
    button.classList.toggle("active", button.dataset.ctab === tab);
    button.setAttribute("aria-selected", String(button.dataset.ctab === tab));
  });
  document.querySelectorAll(".coin-pane").forEach(pane => { pane.hidden = pane.dataset.pane !== tab; });
}
state.coinTab = (() => { try { return localStorage.getItem("pulse-coin-tab") || "plan"; } catch { return "plan"; } })();

function tokenFor(position) { return tokens.find(item => item.id === position.tokenId) ?? state.held.get(position.tokenId); }

function portfolioValue() {
  return state.positions.reduce((total, position) => total + positionValue(position, tokenFor(position)), 0);
}

function updateWalletUI() {
  const value = portfolioValue();
  const cost = state.positions.reduce((total, position) => total + position.amount, 0);
  const pnl = value - cost;
  document.querySelector("#wallet-balance").textContent = formatMoney(state.balance + value);
  const pnlNode = document.querySelector("#wallet-pnl");
  pnlNode.textContent = `P&L ${pnl >= 0 ? "+" : ""}${formatMoney(pnl, 2)}`;
  pnlNode.className = pnl >= 0 ? "positive" : "negative";
  document.querySelector("#trade-balance").textContent = formatMoney(state.balance);
  recordEquity();
  if (!document.querySelector("#positions").hidden) patchDashboard();
  document.querySelector("#position-count").textContent = state.mode === "live" ? (state.live?.positions ?? 0) : state.positions.length;
  document.querySelector("#trade-button").disabled = state.balance < 10 || !(currentToken()?.price > 0);
  renderTradeQuote();
}

const FALLBACK_SOL_USD = 120;
const currentSolUsd = () => tokens.find(token => token.solPriceUsd > 0)?.solPriceUsd ?? FALLBACK_SOL_USD;

/** Preset used for an order of `amountUsd`: the one picked in the trade box, or the one matching the size in SOL (Auto). */
function activePreset(amountUsd) {
  return state.feeMode === "auto" ? presetForCapital(amountUsd / currentSolUsd()) : presetById(state.feeMode);
}

const solText = value => value.toLocaleString(locale, { maximumFractionDigits: 3 });

function renderPresetTable() {
  const rows = FEE_PRESETS.map(preset => `<tr><th><i style="background:${preset.accent}"></i>${esc(preset.label)}</th><td>${preset.capitalMinSol} – ${preset.capitalMaxSol}${preset.capitalOpenEnded ? "+" : ""}</td><td>${preset.priorityFeeSol}</td><td>${preset.tipSol}</td><td>${preset.slippageBuyPct} %</td><td>${preset.slippageSellPct} %</td><td>${preset.passiveSol}</td><td>${preset.deepPassSol}</td></tr>`).join("");
  document.querySelector("#preset-table").innerHTML = `<table><thead><tr><th>Preset</th><th>Capital (SOL)</th><th>Priority fee (SOL)</th><th>Tip (SOL)</th><th>Slippage achat</th><th>Slippage vente</th><th>Passive (SOL)</th><th>Deep Pass (SOL)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTradeQuote() {
  const node = document.querySelector("#trade-quote");
  const token = currentToken();
  const amount = Number(document.querySelector("#trade-amount").value);
  const preset = activePreset(Number.isFinite(amount) ? amount : 0);
  const solUsd = currentSolUsd();
  const costs = costsFor(preset, solUsd);
  document.querySelectorAll("#preset-tabs [data-preset]").forEach(button => button.classList.toggle("active", button.dataset.preset === state.feeMode));
  document.querySelector("#preset-hint").innerHTML = `${Number.isFinite(amount) && amount > 0 ? `≈ ${solText(amount / solUsd)} SOL → ` : ""}<strong style="color:${preset.accent}">${esc(preset.label)}</strong> : priority ${preset.priorityFeeSol} + tip ${preset.tipSol} SOL (≈ ${formatMoney(costs.networkCostUsd, 2)}), slippage max ${preset.slippageBuyPct} % achat / ${preset.slippageSellPct} % vente`;
  const quote = Number.isFinite(amount) && amount >= 10 ? quoteBuy(token, amount, costs) : null;
  const tooMuch = Boolean(quote && quote.impact * 100 > preset.slippageBuyPct);
  node.classList.toggle("warn", Boolean(quote && (quote.impact > 0.03 || tooMuch)));
  node.textContent = quote
    ? `${tooMuch ? `⛔ Slippage ${(quote.impact * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} % > ${preset.slippageBuyPct} % : achat refusé · ` : quote.impact > 0.03 ? "⚠ Liquidité faible · " : ""}Frais ${formatMoney(quote.fee, 2)} + réseau ${formatMoney(quote.network, 2)} · impact ${(quote.impact * 100).toLocaleString(locale, { maximumFractionDigits: 2 })} % · ≈ ${formatInteger(Math.round(quote.units))} $${token.symbol}`
    : "";
}

const REASON_LABEL = { "stop-loss": " · stop-loss", "take-profit": " · take-profit" };
const ALLOCATION_COLORS = ["#4ade80", "#60a5fa", "#fbbf24", "#c084fc", "#f87171", "#2dd4bf", "#fb923c", "#a3e635"];
let historyFilter = "all";
let equityChart = null;
let equityRange = 0;

function loadEquity() {
  try {
    const saved = JSON.parse(localStorage.getItem("pulse-equity") || "[]");
    return Array.isArray(saved) ? saved.filter(point => Number.isFinite(point?.t) && Number.isFinite(point?.v)).slice(-1500) : [];
  } catch { return []; }
}
state.equity = loadEquity();

function saveEquity() {
  try { localStorage.setItem("pulse-equity", JSON.stringify(state.equity)); } catch { /* storage unavailable */ }
}

const sumOf = values => values.reduce((total, value) => total + value, 0);

function dashboardModel() {
  const rows = state.positions.map(position => {
    const token = tokenFor(position);
    const value = positionValue(position, token);
    const pnl = value - position.amount;
    return { position, token, value, pnl, pct: pnl / position.amount * 100 };
  });
  const openValue = sumOf(rows.map(row => row.value));
  const total = state.balance + openValue;
  return { rows, openValue, total, unrealized: sumOf(rows.map(row => row.pnl)), stats: tradeStats(state.history), drawdown: maxDrawdown(state.equity), exposure: total > 0 ? openValue / total : 0, totalPct: total / START_BALANCE - 1 };
}

/** Samples the portfolio value for the equity curve (at most every 10 s unless forced). */
function recordEquity(force = false) {
  const total = state.balance + portfolioValue();
  const before = state.equity.length;
  const next = addEquityPoint(state.equity, { t: Date.now(), v: total }, { force });
  if (next === state.equity) return;
  state.equity = next;
  saveEquity();
  if (equityChart && state.equity.length >= before) equityChart.update(state.equity[state.equity.length - 1]);
}

const signedMoney = value => `${value >= 0 ? "+" : "−"}${formatMoney(Math.abs(value), 2)}`;
const tone = value => (value > 0 ? "positive" : value < 0 ? "negative" : "");

function kpiDefinitions(model) {
  const { stats } = model;
  return [
    ["total", "Valeur totale", formatMoney(model.total, 2), `${signed(model.totalPct * 100)} depuis le départ`, tone(model.totalPct)],
    ["unrealized", "P&L latent", signedMoney(model.unrealized), `${state.positions.length} position${state.positions.length > 1 ? "s" : ""} ouverte${state.positions.length > 1 ? "s" : ""}`, tone(model.unrealized)],
    ["realized", "P&L réalisé", signedMoney(stats.realized), `${stats.count} trade${stats.count > 1 ? "s" : ""} clôturé${stats.count > 1 ? "s" : ""}`, tone(stats.realized)],
    ["winrate", "Taux de réussite", stats.winRate == null ? "—" : `${Math.round(stats.winRate * 100)} %`, stats.count ? `${stats.wins} gagnants · ${stats.losses} perdants` : "aucun trade", ""],
    ["exposure", "Exposition", `${Math.round(model.exposure * 100)} %`, `cash ${formatMoney(state.balance, 0)}`, ""],
    ["drawdown", "Drawdown max", model.drawdown.pct > 0 ? `−${(model.drawdown.pct * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %` : "0 %", model.drawdown.abs > 0 ? `−${formatMoney(model.drawdown.abs, 0)} depuis un pic` : "aucune baisse", model.drawdown.pct > 0.1 ? "negative" : ""],
    ["factor", "Profit factor", stats.profitFactor == null ? "—" : stats.profitFactor === Infinity ? "∞" : stats.profitFactor.toFixed(2), stats.expectancy == null ? "gains ÷ pertes" : `espérance ${signedMoney(stats.expectancy)} / trade`, stats.profitFactor == null ? "" : stats.profitFactor >= 1 ? "positive" : "negative"]
  ];
}

function setText(element, text) {
  if (!element || element.textContent === text) return false;
  element.textContent = text;
  return true;
}

function renderKpis(model) {
  document.querySelector("#kpi-grid").innerHTML = kpiDefinitions(model).map(([key, label, value, sub, valueTone]) => `<article class="kpi" data-kpi="${key}"><span>${label}</span><strong class="${valueTone}" data-kv>${value}</strong><small data-ks>${sub}</small></article>`).join("");
}

function patchKpis(model) {
  for (const [key, , value, sub, valueTone] of kpiDefinitions(model)) {
    const card = document.querySelector(`[data-kpi="${key}"]`);
    if (!card) return renderKpis(model);
    const strong = card.querySelector("[data-kv]");
    const previous = strong.textContent;
    const numeric = text => parseFloat(text.replace(/[^\d.,-]/g, "").replace(",", "."));
    if (setText(strong, value)) flash(strong, key === "drawdown" ? "down" : (numeric(value) >= numeric(previous) ? "up" : "down"));
    strong.className = valueTone;
    setText(card.querySelector("[data-ks]"), sub);
  }
}

function renderAllocation(model) {
  const parts = allocation(state.balance, model.rows.map(row => ({ symbol: row.position.tokenSymbol, value: row.value, tokenId: row.position.tokenId })));
  document.querySelector("#allocation").innerHTML = `<div class="donut-wrap">${donutSvg(parts, ALLOCATION_COLORS)}<div class="donut-center"><strong>${formatMoney(model.total, 0)}</strong><span>total</span></div></div>
    <ul class="legend">${parts.map((part, index) => `<li><i style="background:${ALLOCATION_COLORS[index % ALLOCATION_COLORS.length]}"></i><span>${esc(part.label)}</span><b>${(part.pct * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %</b></li>`).join("")}</ul>`;
}

function renderBreakdowns(model) {
  const byToken = barScale(pnlByToken(state.history, model.rows.map(row => ({ tokenId: row.position.tokenId, symbol: row.position.tokenSymbol, pnl: row.pnl }))).slice(0, 8));
  document.querySelector("#pnl-by-token").innerHTML = byToken.length
    ? byToken.map(item => `<div class="bar-row"><span class="bar-label">$${esc(item.symbol)}</span><span class="bar-track"><i class="${item.total >= 0 ? "pos" : "neg"}" style="width:${Math.max(item.width * 100, 2)}%"></i></span><span class="bar-value ${tone(item.total)}">${signedMoney(item.total)}</span></div>`).join("")
    : '<div class="positions-empty">Aucun trade pour le moment.</div>';

  const days = pnlByDay(state.history, 14);
  const maxAbs = Math.max(...days.map(day => Math.abs(day.pnl)), 1);
  document.querySelector("#pnl-by-day").innerHTML = days.map(day => `<div class="day-col" title="${esc(day.day)} : ${signedMoney(day.pnl)}"><span class="day-bar ${day.pnl >= 0 ? "pos" : "neg"}" style="height:${Math.max(Math.abs(day.pnl) / maxAbs * 100, day.pnl === 0 ? 0 : 4)}%"></span><small>${esc(day.day.slice(8))}</small></div>`).join("");

  const { stats } = model;
  const rows = [
    ["Trades", formatInteger(stats.count)], ["Gain moyen", stats.avgWin == null ? "—" : signedMoney(stats.avgWin)], ["Perte moyenne", stats.avgLoss == null ? "—" : signedMoney(stats.avgLoss)],
    ["Meilleur trade", stats.best == null ? "—" : signedMoney(stats.best)], ["Pire trade", stats.worst == null ? "—" : signedMoney(stats.worst)], ["Durée moyenne", formatDuration(stats.avgHoldMs)]
  ];
  document.querySelector("#trade-stats").innerHTML = rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("");
}

function positionCard({ position, token, value, pnl, pct }) {
  const live = token ?? { name: position.tokenName ?? "Token indisponible", symbol: position.tokenSymbol ?? "N/A", initials: position.tokenInitials ?? "--", accent: "#8b9699" };
  const progress = limitProgress(pct, position.stopLossPct, position.takeProfitPct);
  const preset = position.presetId ? presetById(position.presetId) : null;
  return `<article class="position-card" data-pid="${esc(position.id)}">
    <header><span class="mini-avatar" style="--accent:${esc(live.accent)}">${avatarContent(live)}</span>
      <div class="pc-name"><strong>${esc(live.name)}</strong><small>$${esc(live.symbol)}${token ? "" : " · prix indisponible"} · <span data-pc="hold">${formatDuration(Date.now() - position.openedAt)}</span>${preset ? ` · ${esc(preset.label)}` : ""}</small></div>
      <span class="pc-pill ${pct >= 0 ? "up" : "down"}" data-pc="pill">${pct >= 0 ? "↑" : "↓"} ${Math.abs(pct).toLocaleString(locale, { maximumFractionDigits: 1 })} %</span></header>
    <div class="pc-main"><strong data-pc="value">${formatMoney(value, 2)}</strong><span class="${tone(pnl)}" data-pc="pnl">${signedMoney(pnl)}</span></div>
    <div class="pc-spark" data-pc="spark">${sparklineSvg({ priceHistory: [position.spotEntry, ...((token?.priceHistory ?? []).slice(-40)), token?.price ?? position.lastPrice] })}</div>
    <div class="pc-limits"><div class="limit-track ${progress.hasStop ? "" : "no-stop"}"><i style="left:${(progress.position * 100).toFixed(1)}%" data-pc="marker"></i></div>
      <div class="limit-labels"><span class="${progress.hasStop ? "" : "warn"}">${progress.hasStop ? `SL −${position.stopLossPct} %` : "⚠ pas de stop-loss"}</span><span>${progress.hasTarget ? `TP +${position.takeProfitPct} %` : "pas de take-profit"}</span></div></div>
    <dl class="pc-grid"><div><dt>Engagé</dt><dd>${formatMoney(position.amount, 2)}</dd></div><div><dt>Entrée</dt><dd>${formatPrice(position.entryPrice)}</dd></div><div><dt>Actuel</dt><dd data-pc="price">${token ? formatPrice(token.price) : "—"}</dd></div></dl>
    <footer class="position-actions">
      <label class="limit-edit ${position.stopLossPct ? "" : "missing"}" title="Stop-loss : clôture automatique si la perte nette atteint ce %">SL −<input type="number" min="1" max="99" step="1" inputmode="decimal" placeholder="aucun" value="${position.stopLossPct ?? ""}" data-limit="stopLossPct" data-position="${esc(position.id)}" />%</label>
      <label class="limit-edit" title="Take-profit : clôture automatique si le gain net atteint ce %">TP +<input type="number" min="1" step="1" inputmode="decimal" placeholder="aucun" value="${position.takeProfitPct ?? ""}" data-limit="takeProfitPct" data-position="${esc(position.id)}" />%</label>
      <button class="close-position" type="button" data-close="${esc(position.id)}" data-fraction="0.25">25 %</button>
      <button class="close-position" type="button" data-close="${esc(position.id)}" data-fraction="0.5">50 %</button>
      <button class="close-position" type="button" data-close="${esc(position.id)}" data-fraction="1">Clôturer</button>
    </footer></article>`;
}

/** Full render: structure changes (open/close/limits) and first display. */
function renderPositions() {
  renderHistory();
  renderChartTrades();
  const model = dashboardModel();
  const list = document.querySelector("#positions-list");
  list.innerHTML = state.positions.length
    ? model.rows.map(positionCard).join("")
    : '<div class="positions-empty empty-card">Aucune position ouverte. Ouvre un coin depuis le Scanner pour lancer une simulation.</div>';
  document.querySelector("#positions-meta").textContent = state.positions.length ? `${state.positions.length} ouverte${state.positions.length > 1 ? "s" : ""} · valeur ${formatMoney(model.openValue, 2)}` : "";
  renderKpis(model);
  renderAllocation(model);
  renderBreakdowns(model);
  updateWalletUI();
  recordEquity(true);
}

/** Cheap live update: numbers, pills, markers and sparklines change in place, with a flash on movement. */
function patchDashboard() {
  const model = dashboardModel();
  const cards = document.querySelectorAll("#positions-list .position-card");
  if (cards.length !== state.positions.length) { renderPositions(); return; }
  for (const row of model.rows) {
    const card = document.querySelector(`#positions-list .position-card[data-pid="${CSS.escape(row.position.id)}"]`);
    if (!card) { renderPositions(); return; }
    const at = name => card.querySelector(`[data-pc="${name}"]`);
    const valueNode = at("value");
    const previous = parseFloat(valueNode.textContent.replace(/[^\d.,-]/g, "").replace(/\s/g, "").replace(",", "."));
    if (setText(valueNode, formatMoney(row.value, 2))) flash(valueNode, row.value >= previous ? "up" : "down");
    const pnlNode = at("pnl");
    setText(pnlNode, signedMoney(row.pnl));
    pnlNode.className = tone(row.pnl);
    const pill = at("pill");
    setText(pill, `${row.pct >= 0 ? "↑" : "↓"} ${Math.abs(row.pct).toLocaleString(locale, { maximumFractionDigits: 1 })} %`);
    pill.className = `pc-pill ${row.pct >= 0 ? "up" : "down"}`;
    at("marker").style.left = `${(limitProgress(row.pct, row.position.stopLossPct, row.position.takeProfitPct).position * 100).toFixed(1)}%`;
    setText(at("price"), row.token ? formatPrice(row.token.price) : "—");
    setText(at("hold"), formatDuration(Date.now() - row.position.openedAt));
    if (row.token) at("spark").innerHTML = sparklineSvg({ priceHistory: [row.position.spotEntry, ...(row.token.priceHistory ?? []).slice(-40), row.token.price] });
  }
  patchKpis(model);
  renderAllocation(model);
  document.querySelector("#positions-meta").textContent = state.positions.length ? `${state.positions.length} ouverte${state.positions.length > 1 ? "s" : ""} · valeur ${formatMoney(model.openValue, 2)}` : "";
}

function ensureEquityChart() {
  if (!equityChart) equityChart = createEquityChart(document.querySelector("#equity-chart"), START_BALANCE);
  renderEquity();
}

function renderEquity() {
  if (!equityChart) return;
  const since = equityRange ? Date.now() - equityRange : 0;
  const points = state.equity.filter(point => point.t >= since);
  document.querySelector("#equity-status").hidden = points.length >= 3;
  equityChart.setData(points.length ? points : [{ t: Date.now(), v: START_BALANCE }]);
}

function updateHistoryCount() {
  const badge = document.querySelector("#history-count");
  if (badge) badge.textContent = state.history.length;
}

function renderHistory() {
  updateHistoryCount();
  const trades = state.history.filter(trade => historyFilter === "all" || (historyFilter === "win" ? trade.pnl > 0 : trade.pnl < 0));
  document.querySelector("#history-list").innerHTML = trades.length
    ? trades.slice(0, 40).map(trade => `<div class="history-row"><strong>$${esc(trade.tokenSymbol)}</strong><span>${new Date(trade.closedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span><span>${formatMoney(trade.amount, 2)} → ${formatMoney(trade.proceeds, 2)}${REASON_LABEL[trade.reason] ?? ""}</span><strong class="${trade.pnl >= 0 ? "positive" : "negative"}">${trade.pnl >= 0 ? "+" : ""}${formatMoney(trade.pnl, 2)} (${signed(trade.pnlPct)})</strong></div>`).join("")
    : '<div class="positions-empty">Aucun trade clôturé pour ce filtre.</div>';
}

document.querySelector("#equity-range").addEventListener("click", event => {
  const button = event.target.closest("[data-range]");
  if (!button) return;
  equityRange = Number(button.dataset.range);
  document.querySelectorAll("#equity-range [data-range]").forEach(item => item.classList.toggle("active", item === button));
  renderEquity();
});
document.querySelector("#history-filter").addEventListener("click", event => {
  const button = event.target.closest("[data-hfilter]");
  if (!button) return;
  historyFilter = button.dataset.hfilter;
  document.querySelectorAll("#history-filter [data-hfilter]").forEach(item => item.classList.toggle("active", item === button));
  renderHistory();
});
document.querySelector("#export-history").addEventListener("click", () => {
  if (!state.history.length) { showToast("Aucun trade à exporter."); return; }
  const head = "date,token,engage_usd,recu_usd,pnl_usd,pnl_pct,raison";
  const lines = state.history.map(trade => [new Date(trade.closedAt).toISOString(), trade.tokenSymbol, trade.amount.toFixed(2), trade.proceeds.toFixed(2), trade.pnl.toFixed(2), trade.pnlPct.toFixed(2), trade.reason ?? "manual"].map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(","));
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([[head, ...lines].join("\n")], { type: "text/csv" }));
  link.download = "pulse-trades.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function standardWalletAdapter(standardWallet) {
  let adapter = standardAdapters.get(standardWallet);
  if (adapter) return adapter;

  const listeners = new Map();
  const events = standardWallet.features?.["standard:events"];
  adapter = {
    async connect(options) {
      const output = await standardWallet.features["standard:connect"].connect(options?.onlyIfTrusted ? { silent: true } : undefined);
      const account = output?.accounts?.[0] ?? standardWallet.accounts?.[0];
      return { publicKey: account?.address };
    },
    async disconnect() {
      await standardWallet.features?.["standard:disconnect"]?.disconnect?.();
    },
    on(eventName, handler) {
      if (!events?.on || listeners.has(eventName)) return;
      const off = events.on("change", ({ accounts }) => {
        const account = accounts?.[0];
        if (!account && eventName === "disconnect") handler();
        if (account && eventName === "accountChanged") handler(account.address);
      });
      listeners.set(eventName, off);
    }
  };
  standardAdapters.set(standardWallet, adapter);
  return adapter;
}

const blockedExtensionScripts = new Set();
document.addEventListener("securitypolicyviolation", event => {
  if (/^(chrome|moz|safari-web)-extension:/.test(event.blockedURI)) blockedExtensionScripts.add(event.blockedURI);
});

function walletDiagnostic() {
  const names = ["phantom", "solflare", "backpack", "coinbaseSolana", "okxwallet", "trustwallet", "exodus", "glow", "braveSolana", "solana"].filter(name => window[name]);
  const lines = [`Détecté dans cette page : ${names.length || standardWallets.size ? [...names.map(name => `window.${name}`), ...(standardWallets.size ? [`Wallet Standard : ${[...standardWallets].map(wallet => wallet.name).join(", ")}`] : [])].join(" · ") : "aucun wallet"}.`];
  if (blockedExtensionScripts.size) lines.push("Le navigateur a bloqué un script d’extension (sécurité de la page).");
  return lines.join(" ");
}

async function fetchWalletBalance(address) {
  const response = await fetch(`/api/wallet/${encodeURIComponent(address)}/balance`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Balance HTTP ${response.status}`);
  const payload = await response.json();
  if (!Number.isFinite(payload?.sol)) throw new Error("Invalid balance payload");
  return payload.sol;
}


function activeWallet() { return state.wallets.find(wallet => wallet.id === state.activeWalletId) ?? state.wallets[0] ?? null; }
const observedWalletProviders = new WeakSet();

function rememberWallets() {
  try { localStorage.setItem("pulse-wallets", JSON.stringify({ ids: state.wallets.map(wallet => wallet.id), active: state.activeWalletId })); } catch { /* storage unavailable */ }
}

function walletLogo(wallet) {
  if (wallet.icon) return `<span class="provider-logo has-icon"><img src="${esc(wallet.icon)}" alt="" width="40" height="40"></span>`;
  return `<span class="provider-logo" style="background:${esc(wallet.color ?? "#4b5563")}">${esc(String(wallet.name).slice(0, 1).toUpperCase())}</span>`;
}

function formatSol(value) {
  return value == null ? "— SOL" : `${value.toLocaleString(locale, { maximumFractionDigits: 4 })} SOL`;
}

function renderWallet() {
  const active = activeWallet();
  const count = state.wallets.length;
  document.querySelector("#wallet-button").classList.toggle("connected", count > 0);
  document.querySelector("#wallet-button-label").textContent = !active ? "Connecter wallet" : `${shortAddress(active.address)}${count > 1 ? ` +${count - 1}` : ""}`;
  document.querySelector("#wallet-count").textContent = count;
  document.querySelector("#wallet-total").textContent = formatSol(state.wallets.some(wallet => wallet.balance != null) ? totalSol(state.wallets) : null);
  document.querySelector("#wallet-rows").innerHTML = state.wallets.map(wallet => `<div class="wallet-row ${wallet.id === active?.id ? "active" : ""}" data-wallet-row="${esc(wallet.id)}">
    ${walletLogo(wallet)}
    <button class="wallet-row-main" type="button" data-wallet-select="${esc(wallet.id)}" title="Définir comme wallet actif"><strong>${esc(wallet.name)}${wallet.id === active?.id ? " · actif" : ""}${wallet.remote ? (wallet.verified ? " · vérifié ✓" : " · non vérifié") : ""}</strong><small>${esc(shortAddress(wallet.address))} · ${esc(formatSol(wallet.balance))}</small></button>
    <button class="wallet-row-action" type="button" data-wallet-copy="${esc(wallet.id)}" title="Copier l’adresse">Copier</button>
    <button class="wallet-row-action danger" type="button" data-wallet-disconnect="${esc(wallet.id)}" title="Déconnecter" aria-label="Déconnecter ${esc(wallet.name)}">×</button>
  </div>`).join("");
  if (!count) document.querySelector("#wallet-menu").hidden = true;
  window.dispatchEvent(new Event("pulse-wallets-changed"));
  if (!document.querySelector("#wallet-modal").hidden) renderWalletChoices();
}

async function refreshWalletBalance(wallet) {
  try {
    wallet.balance = await fetchWalletBalance(wallet.address);
  } catch (error) {
    console.warn("Unable to load wallet balance", error);
  }
  renderWallet();
}

function dropWallet(id) {
  state.wallets = removeWallet(state.wallets, id);
  if (state.activeWalletId === id) state.activeWalletId = state.wallets[0]?.id ?? null;
  rememberWallets();
  renderWallet();
}

async function addWallet(entry, publicKey) {
  const address = toAddress(publicKey);
  if (!address) throw new Error("Adresse publique invalide");
  const wallet = { id: entry.id, name: entry.name, color: entry.color, icon: entry.icon ?? null, provider: entry.provider, standardWallet: entry.standardWallet ?? null, address, balance: null, verified: Boolean(entry.verified), remote: Boolean(entry.remote) };
  state.wallets = upsertWallet(state.wallets, wallet);
  state.activeWalletId = wallet.id;
  const provider = entry.provider;
  if (provider && typeof provider === "object" && !observedWalletProviders.has(provider)) {
    observedWalletProviders.add(provider);
    provider.on?.("disconnect", () => dropWallet(entry.id));
    provider.on?.("accountChanged", nextPublicKey => {
      if (nextPublicKey) addWallet(entry, nextPublicKey).catch(error => console.error("Account switch failed", error));
      else dropWallet(entry.id);
    });
  }
  rememberWallets();
  try { localStorage.setItem("pulse-last-wallet", JSON.stringify({ address, name: entry.name, at: Date.now() })); } catch { /* storage unavailable */ }
  renderWallet();
  await refreshWalletBalance(wallet);
}

/** Closes the wallet dialog and plays a short confetti / fireworks burst to confirm the connection. */
function celebrateConnection() {
  document.querySelector("#wallet-modal").hidden = true;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = Object.assign(document.createElement("canvas"), { width: innerWidth, height: innerHeight });
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:300";
  document.body.append(canvas);
  const context = canvas.getContext("2d");
  const colors = ["#b8f55d", "#4ade80", "#fbbf24", "#60a5fa", "#f472b6", "#a78bfa", "#ffffff"];
  const parts = [];
  const burst = (x, y, count) => { for (let i = 0; i < count; i += 1) { const angle = Math.random() * Math.PI * 2; const speed = 2 + Math.random() * 7; parts.push({ x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 2, size: 3 + Math.random() * 4, color: colors[i % colors.length], life: 70 + Math.random() * 40, age: 0 }); } };
  for (let i = 0; i < 90; i += 1) parts.push({ x: Math.random() * innerWidth, y: -20 - Math.random() * 200, vx: (Math.random() - .5) * 3, vy: 2 + Math.random() * 4, size: 5 + Math.random() * 5, color: colors[i % colors.length], life: 160, age: 0, confetti: true });
  [[.25, .35, 0], [.75, .3, 250], [.5, .45, 500], [.35, .25, 800], [.65, .4, 1050]].forEach(([fx, fy, delay]) => setTimeout(() => burst(innerWidth * fx, innerHeight * fy, 70), delay));
  const started = performance.now();
  (function frame(now) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const part of parts) {
      part.age += 1; part.x += part.vx; part.y += part.vy; part.vy += part.confetti ? .04 : .12; part.vx *= .99;
      context.globalAlpha = Math.max(0, 1 - part.age / part.life);
      context.fillStyle = part.color;
      context.fillRect(part.x, part.y, part.size, part.confetti ? part.size * .5 : part.size);
    }
    if (now - started < 3200) requestAnimationFrame(frame); else canvas.remove();
  })(started);
}

async function connectWallet(entry, { silent = false } = {}) {
  try {
    const response = await entry.provider.connect(silent ? { onlyIfTrusted: true } : undefined);
    await addWallet(entry, response?.publicKey ?? entry.provider.publicKey);
    if (!silent) { showToast(`${entry.name} connecté en lecture seule.`); celebrateConnection(); }
  } catch (error) {
    if (silent) return;
    if (error?.code !== 4001) console.error("Wallet connection failed", error);
    showToast(error?.code === 4001 ? "Connexion annulée dans le wallet." : `Impossible de connecter ${entry.name}.`);
  }
}

async function disconnectWallet(id) {
  const wallet = state.wallets.find(item => item.id === id);
  if (!wallet) return;
  try { await wallet.provider?.disconnect?.(); } catch (error) { console.warn("Wallet disconnect failed", error); }
  dropWallet(id);
  showToast(`${wallet.name} déconnecté.`);
}

function renderWalletChoices() {
  const { detected, notInstalled } = detectWallets(window, standardWallets, standardWalletAdapter);
  const connected = new Set(state.wallets.map(wallet => wallet.id));
  document.querySelector("#wallet-help").hidden = detected.length > 0;
  document.querySelector("#wallet-diagnostic").textContent = detected.length ? "" : walletDiagnostic();
  state.detectedWallets = detected;
  document.querySelector("#wallet-list").innerHTML = detected.map((wallet, index) => `<button class="provider-choice ${connected.has(wallet.id) ? "is-connected" : ""}" type="button" data-wallet-connect="${index}">
      ${walletLogo(wallet)}<span><strong>${esc(wallet.name)}</strong><small>${connected.has(wallet.id) ? "Connecté · clique pour reconnecter" : "Wallet détecté"}</small></span><b>${connected.has(wallet.id) ? "✓" : "Connecter"}</b></button>`).join("")
    + notInstalled.map(wallet => `<a class="provider-choice not-installed" href="${esc(wallet.install)}" target="_blank" rel="noopener noreferrer">
      ${walletLogo(wallet)}<span><strong>${esc(wallet.name)}</strong><small>Non détecté</small></span><b>Installer ↗</b></a>`).join("");
}

const walletConnect = { client: null, module: null, projectId: null, uri: null, starting: false };

function setWcStatus(message, tone = "") {
  const node = document.querySelector("#wc-status");
  node.textContent = message;
  node.className = `wc-status ${tone}`;
}

async function loadQrAvailability() {
  let options = null;
  try {
    options = await (await fetch("/api/wallet/options", { headers: { accept: "application/json" } })).json();
  } catch { /* offline: show the setup help */ }
  walletConnect.projectId = options?.walletConnectProjectId ?? null;
  const phantomQr = !walletConnect.projectId && Boolean(options?.phantomMobileQr);
  document.querySelector("#wc-ready").hidden = !walletConnect.projectId;
  document.querySelector("#wc-setup").hidden = Boolean(walletConnect.projectId);
  document.querySelector("#qr-ready").hidden = !phantomQr;
  document.querySelector("#qr-unavailable").hidden = Boolean(walletConnect.projectId) || phantomQr;
  if (phantomQr) document.querySelector("#phantom-qr").src = `/api/wallet/phantom-qr.svg?t=${Date.now()}`;
  if (walletConnect.projectId && !walletConnect.starting && !walletConnect.uri) startWalletConnectQr();
}

async function ensureWalletConnect() {
  if (walletConnect.client) return walletConnect.client;
  walletConnect.module ??= await import("./vendor/walletconnect.js");
  walletConnect.client = await walletConnect.module.createWalletConnect({
    projectId: walletConnect.projectId,
    appUrl: window.location.origin,
    onUri: uri => {
      walletConnect.uri = uri;
      walletConnect.module.qrSvgAsync(uri).then(svg => {
        document.querySelector("#wc-qr").innerHTML = svg;
        setWcStatus("En attente du scan…");
      });
    },
    onDisconnect: () => dropWallet("walletconnect")
  });
  try { localStorage.setItem("pulse-wc-project", walletConnect.projectId); } catch { /* storage unavailable */ }
  return walletConnect.client;
}

function remoteWalletEntry(client, info, verified) {
  return {
    id: "walletconnect", name: info.peerName, color: "#3b99fc", icon: iconForName(info.peerName), verified, remote: true,
    provider: { connect: async () => ({ publicKey: info.address }), publicKey: info.address, disconnect: () => client.disconnect(), on() {} }
  };
}

/** Scan-to-connect: show a WalletConnect QR, wait for the wallet's approval, then ask for a proof-of-ownership signature. */
async function startWalletConnectQr() {
  if (walletConnect.starting || !walletConnect.projectId) return;
  walletConnect.starting = true;
  walletConnect.uri = null;
  document.querySelector("#wc-qr").innerHTML = '<span class="qr-placeholder" aria-hidden="true"></span>';
  setWcStatus("Génération du QR code…");
  try {
    const client = await ensureWalletConnect();
    const watchdog = setTimeout(() => {
      if (!walletConnect.uri) setWcStatus("Impossible de joindre WalletConnect. Vérifie le Project ID du fichier .env et ta connexion, puis clique « Nouveau QR ».", "warn");
    }, 12_000);
    const info = await client.connect().finally(() => clearTimeout(watchdog));
    if (!toAddress(info.address)) throw new Error("Adresse invalide");
    setWcStatus(`Autorise dans ${info.peerName} : signe le message de vérification…`, "pending");
    let verified = false;
    try { verified = await client.authorize(info.address); } catch { verified = false; }
    await addWallet(remoteWalletEntry(client, info, verified), info.address);
    try { localStorage.setItem("pulse-wc-verified", verified ? "1" : "0"); } catch { /* storage unavailable */ }
    setWcStatus(verified ? `${info.peerName} connecté et vérifié ✓` : `${info.peerName} connecté (signature non confirmée).`, verified ? "ok" : "warn");
    celebrateConnection();
    showToast(verified ? `${info.peerName} connecté et vérifié (lecture seule).` : `${info.peerName} connecté, mais la signature de vérification n'a pas été confirmée.`);
  } catch (error) {
    console.warn("WalletConnect failed", error);
    setWcStatus(`Connexion refusée, expirée ou impossible${error?.message ? ` (${String(error.message).slice(0, 80)})` : ""}. Génère un nouveau QR.`, "warn");
  } finally {
    walletConnect.starting = false;
    walletConnect.uri = null;
  }
}

/** Re-attaches a WalletConnect session kept by the library in localStorage, without showing the QR again. */
async function restoreWalletConnect() {
  let projectId = null;
  try { projectId = localStorage.getItem("pulse-wc-project"); } catch { /* ignore */ }
  const hasSession = Object.keys(localStorage).some(key => key.startsWith("wc@2"));
  if (!projectId || !hasSession) return;
  walletConnect.projectId = projectId;
  try {
    const client = await ensureWalletConnect();
    const info = client.existing();
    if (info && toAddress(info.address)) await addWallet(remoteWalletEntry(client, info, localStorage.getItem("pulse-wc-verified") === "1"), info.address);
  } catch (error) { console.warn("WalletConnect restore failed", error); }
}
setTimeout(restoreWalletConnect, 1800);

document.querySelector("#wc-refresh").addEventListener("click", () => { walletConnect.uri = null; startWalletConnectQr(); });
document.querySelector("#wc-copy").addEventListener("click", async () => {
  if (!walletConnect.uri) { showToast("Le QR n'est pas encore prêt."); return; }
  try { await navigator.clipboard.writeText(walletConnect.uri); showToast("Lien de connexion copié."); } catch { showToast("Copie impossible dans ce navigateur."); }
});

document.querySelector("#wallet-button").addEventListener("click", async () => {
  if (!state.wallets.length) {
    renderWalletChoices();
    document.querySelector("#wallet-modal").hidden = false;
    setTimeout(renderWalletChoices, 1200);
    await loadQrAvailability();
    return;
  }
  const menu = document.querySelector("#wallet-menu");
  menu.hidden = !menu.hidden;
});
document.querySelector("#add-wallet").addEventListener("click", async () => {
  document.querySelector("#wallet-menu").hidden = true;
  renderWalletChoices();
  document.querySelector("#wallet-modal").hidden = false;
  await loadQrAvailability();
});
document.querySelector("#retry-wallet").addEventListener("click", () => {
  renderWalletChoices();
  showToast(state.detectedWallets?.length ? "Wallet détecté." : "Toujours aucun wallet détecté.");
});
document.querySelector("#wallet-list").addEventListener("click", event => {
  const button = event.target.closest("[data-wallet-connect]");
  const entry = button && state.detectedWallets?.[Number(button.dataset.walletConnect)];
  if (entry) connectWallet(entry);
});
document.querySelector("#wallet-rows").addEventListener("click", async event => {
  const select = event.target.closest("[data-wallet-select]");
  const copy = event.target.closest("[data-wallet-copy]");
  const disconnect = event.target.closest("[data-wallet-disconnect]");
  if (select) { state.activeWalletId = select.dataset.walletSelect; rememberWallets(); renderWallet(); return; }
  if (copy) {
    const wallet = state.wallets.find(item => item.id === copy.dataset.walletCopy);
    try { await navigator.clipboard.writeText(wallet.address); showToast("Adresse publique copiée."); } catch { showToast("Copie impossible dans ce navigateur."); }
    return;
  }
  if (disconnect) await disconnectWallet(disconnect.dataset.walletDisconnect);
});
document.querySelector("#disconnect-all").addEventListener("click", async () => {
  for (const wallet of [...state.wallets]) await disconnectWallet(wallet.id);
});
document.querySelectorAll("[data-close-wallet]").forEach(button => button.addEventListener("click", () => { document.querySelector("#wallet-modal").hidden = true; }));
document.querySelectorAll("[data-wallet-tab]").forEach(button => button.addEventListener("click", () => {
  const tab = button.dataset.walletTab;
  document.querySelectorAll("[data-wallet-tab]").forEach(item => { item.classList.toggle("active", item === button); item.setAttribute("aria-selected", String(item === button)); });
  document.querySelector("#wallet-extensions").hidden = tab !== "extensions";
  document.querySelector("#wallet-qr").hidden = tab !== "qr";
  if (tab === "qr") loadQrAvailability();
}));
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { document.querySelector("#wallet-modal").hidden = true; if (!coinModal.hidden) closeCoin(); }
});

/** Re-connects previously authorised wallets without a popup, once the extensions have injected themselves. */
function restoreWallets() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("pulse-wallets") || "null"); } catch { /* ignore */ }
  const ids = Array.isArray(saved?.ids) ? saved.ids : [];
  if (!ids.length) return;
  const { detected } = detectWallets(window, standardWallets, standardWalletAdapter);
  for (const entry of detected) {
    if (ids.includes(entry.id) && !state.wallets.some(wallet => wallet.id === entry.id)) connectWallet(entry, { silent: true }).then(() => { if (saved.active === entry.id) { state.activeWalletId = entry.id; renderWallet(); } });
  }
}
setTimeout(restoreWallets, 1200);
setTimeout(restoreWallets, 3500);
setInterval(() => { state.wallets.forEach(refreshWalletBalance); }, 60_000);

function selectToken(id) {
  state.selected = id;
  renderTable();
  renderDetail();
}

const CHART_REFRESH_MS = 20_000;
const coinModal = document.querySelector("#coin-modal");
const chartStatus = document.querySelector("#chart-status");
let coinChart = null;
let chartCandles = [];
let chartRefresh = null;
let chartRequest = 0;
state.chartTf = "5m";

function setChartStatus(message) {
  chartStatus.hidden = !message;
  chartStatus.textContent = message ?? "";
}

function renderChartTrades() {
  if (!coinChart || coinModal.hidden) return;
  const token = currentToken();
  const markers = buildTradeMarkers({
    tokenId: token.id, positions: state.positions, history: state.history,
    timeframe: state.chartTf, firstCandleTime: chartCandles[0]?.time
  });
  coinChart.setMarkers(markers);
  coinChart.setEntryLines(state.positions.filter(position => position.tokenId === token.id).map(position => ({ price: position.spotEntry, title: `Entrée $${Math.round(position.amount)}` })));
}

async function loadChart({ fit = true } = {}) {
  const token = currentToken();
  const request = ++chartRequest;
  document.querySelector("#chart-dex-link").href = token.dexUrl && /^https:\/\/dexscreener\.com\//.test(token.dexUrl) ? token.dexUrl : "#";
  if (!token.pairAddress) {
    chartCandles = [];
    coinChart.setCandles([]);
    setChartStatus("Graphique indisponible : données simulées.");
    return;
  }
  try {
    const response = await fetch(`/api/chart?pool=${encodeURIComponent(token.pairAddress)}&tf=${state.chartTf}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (request !== chartRequest) return;
    chartCandles = payload.candles ?? [];
    coinChart.setCandles(chartCandles, { fit });
    setChartStatus(chartCandles.length ? null : "Pas encore de bougies pour ce coin (pool trop récent).");
    renderChartTrades();
    renderPlan();
  } catch {
    if (request === chartRequest) setChartStatus("Graphique momentanément indisponible.");
  }
}

const X_LABELS = {
  positive: ["Signal positif", "up"],
  neutral: ["Neutre", "neutral"],
  negative: ["Signal négatif", "down"],
  alert: ["⚠ Alerte scam/rug", "down"]
};
let xRequest = 0;

function renderXLinks(token) {
  const links = [];
  if (token.twitterUrl) links.push(`<a href="${esc(token.twitterUrl)}" target="_blank" rel="noopener noreferrer">Compte X du coin ↗</a>`);
  links.push(`<a href="https://x.com/search?q=${encodeURIComponent(`$${token.symbol}`)}&f=live" target="_blank" rel="noopener noreferrer">Chercher $${esc(token.symbol)} ↗</a>`);
  if (token.address) links.push(`<a href="https://x.com/search?q=${encodeURIComponent(token.address)}&f=live" target="_blank" rel="noopener noreferrer">Chercher le contrat ↗</a>`);
  document.querySelector("#x-links").innerHTML = links.join("");
}

async function loadXSignal() {
  const token = currentToken();
  const request = ++xRequest;
  const body = document.querySelector("#x-body");
  const badge = document.querySelector("#x-badge");
  renderXLinks(token);
  badge.hidden = true;
  if (!/^[A-Za-z0-9]{1,15}$/.test(token.symbol ?? "")) { body.textContent = "Symbole non recherchable sur X."; return; }
  body.textContent = "Chargement des tweets…";
  try {
    const response = await fetch(`/api/x?symbol=${encodeURIComponent(token.symbol)}&address=${encodeURIComponent(token.address ?? "")}`, { headers: { accept: "application/json" } });
    const data = await response.json();
    if (request !== xRequest) return;
    if (data.code === "payment_required") {
      body.innerHTML = '<p class="x-note">Clé X reconnue, mais ton compte n’a pas de crédit ou de plan pour la recherche de tweets (erreur 402). Ajoute des crédits dans le Developer Portal X, puis recharge.</p>';
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!data.enabled) {
      body.innerHTML = '<p class="x-note">Analyse automatique désactivée. Ajoute <code>X_BEARER_TOKEN</code> dans <code>.env</code> (clé API X avec accès à la recherche) pour voir les tweets récents et un score de sentiment ici. En attendant, utilise les liens ci-dessus.</p>';
      return;
    }
    const [label, tone] = X_LABELS[data.label] ?? X_LABELS.neutral;
    badge.textContent = label;
    badge.className = `x-badge ${tone}`;
    badge.hidden = false;
    body.innerHTML = `<div class="x-stats"><span>Tweets récents <strong>${formatInteger(data.tweetCount)}</strong></span><span>Auteurs <strong>${formatInteger(data.authors)}</strong></span><span>Engagement <strong>${formatInteger(data.engagement)}</strong></span><span>Mentions scam <strong>${formatInteger(data.scamMentions)}</strong></span></div>`
      + (data.top.length
        ? data.top.map(tweet => `<a class="x-tweet" href="${esc(tweet.url)}" target="_blank" rel="noopener noreferrer"><strong>${tweet.author ? `@${esc(tweet.author)}` : "Tweet"}</strong><span>${esc(tweet.text)}</span><small>♥ ${formatInteger(tweet.likes)}</small></a>`).join("")
        : '<p class="x-note">Aucun tweet récent trouvé : peu de buzz pour ce coin.</p>')
      + '<p class="x-note">Lecture automatique par mots-clés : indicative, ne détecte ni l’ironie ni les campagnes payées.</p>';
  } catch {
    if (request === xRequest) body.textContent = "Données X momentanément indisponibles.";
  }
}

function openCoin(id) {
  selectToken(id);
  coinModal.hidden = false;
  document.body.classList.add("modal-open");
  coinChart ??= createCoinChart(document.querySelector("#coin-chart"));
  setChartStatus("Chargement du graphique…");
  loadChart();
  loadXSignal();
  loadSecurity(currentToken());
  clearInterval(chartRefresh);
  chartRefresh = setInterval(() => loadChart({ fit: false }), CHART_REFRESH_MS);
}

function closeCoin() {
  coinModal.hidden = true;
  document.body.classList.remove("modal-open");
  clearInterval(chartRefresh);
  chartRequest += 1;
}

document.querySelectorAll("[data-close-coin]").forEach(button => button.addEventListener("click", closeCoin));
document.querySelectorAll("[data-chart-tf]").forEach(button => button.addEventListener("click", () => {
  state.chartTf = button.dataset.chartTf;
  document.querySelectorAll("[data-chart-tf]").forEach(item => item.classList.toggle("active", item === button));
  setChartStatus("Chargement du graphique…");
  loadChart();
}));

table.addEventListener("click", event => {
  const remove = event.target.closest("[data-remove-custom]");
  if (remove) {
    state.custom.delete(remove.dataset.removeCustom);
    saveCustom();
    tokens = tokens.filter(token => token.id !== remove.dataset.removeCustom || !token.custom);
    renderTable();
    return;
  }
  const star = event.target.closest("[data-star]");
  if (star) {
    const id = star.dataset.star;
    if (state.watchlist.has(id)) state.watchlist.delete(id); else state.watchlist.add(id);
    saveWatchlist();
    renderTable();
    return;
  }
  const row = event.target.closest(".token-row");
  if (row) openCoin(row.dataset.id);
});
table.addEventListener("keydown", event => {
  const row = event.target.closest(".token-row");
  if (row && !event.target.closest("[data-star]") && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openCoin(row.dataset.id); }
});
document.querySelectorAll(".filter").forEach(button => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  document.querySelectorAll(".filter").forEach(item => item.classList.toggle("active", item === button));
  renderTable();
}));
document.querySelector("#age-window").addEventListener("change", event => {
  state.ageWindow = event.target.value === "all" ? "all" : Number(event.target.value);
  renderTable();
});
document.querySelector("#minimum-volume").addEventListener("change", event => {
  state.minimumVolume = Number(event.target.value);
  renderTable();
});
document.querySelectorAll("[data-timeframe]").forEach(button => button.addEventListener("click", () => {
  state.timeframe = button.dataset.timeframe;
  document.querySelectorAll("[data-timeframe]").forEach(item => item.classList.toggle("active", item === button));
  if (state.marketMode === "trending" || state.marketMode === "movers") applyMarketMode(state.marketMode);
  else renderTable();
}));
document.querySelectorAll("[data-market-mode]").forEach(button => button.addEventListener("click", () => applyMarketMode(button.dataset.marketMode)));
document.querySelectorAll("[data-sort]").forEach(button => button.addEventListener("click", () => {
  const key = button.dataset.sort;
  state.sort = {
    key,
    direction: state.sort.key === key && state.sort.direction === "desc" ? "asc" : "desc"
  };
  document.querySelectorAll("[data-sort]").forEach(item => {
    const active = item === button;
    item.classList.toggle("active", active);
    if (active) item.dataset.direction = state.sort.direction;
    else delete item.dataset.direction;
  });
  renderTable();
}));
document.querySelector("#search").addEventListener("input", event => { state.query = event.target.value; renderTable(); });
document.querySelector("#refresh").addEventListener("click", async event => {
  event.currentTarget.classList.add("spinning");
  const loaded = await loadTokens(true);
  setTimeout(() => event.currentTarget.classList.remove("spinning"), 700);
  if (loaded) {
    renderTable(); renderDetail(); renderPositions();
    showToast(state.market.live ? "Cours du marché actualisés." : "Source live indisponible : mode simulation.");
  } else {
    showToast("Actualisation impossible. Les dernières valeurs sont conservées.");
  }
});
document.querySelectorAll("[data-amount]").forEach(button => button.addEventListener("click", () => { document.querySelector("#trade-amount").value = button.dataset.amount; }));
document.querySelector("#trade-amount").addEventListener("input", renderTradeQuote);
document.querySelector("#trade-button").addEventListener("click", () => {
  const amount = Number(document.querySelector("#trade-amount").value);
  const token = currentToken();
  const preset = activePreset(amount);
  const costs = costsFor(preset, currentSolUsd());
  const error = validateBuy(token, amount, state.balance, { preset, costs });
  if (error) return showToast(error);
  const stopLossPct = document.querySelector("#stop-loss").value;
  const takeProfitPct = document.querySelector("#take-profit").value;
  const dip = Math.min(Math.max(Number(document.querySelector("#trade-dip").value) || 0, 0), 30);
  try { localStorage.setItem("pulse-limits", JSON.stringify({ sl: stopLossPct, tp: takeProfitPct, dip: String(dip) })); } catch { /* storage unavailable */ }
  if (dip > 0) {
    const now = Date.now();
    manualOrders.push({ id: `${token.id}-${now}`, tokenId: token.id, symbol: token.symbol, amount, limitPrice: token.price * (1 - dip / 100), refPrice: token.price, dipPct: dip, stopLossPct: optionalNumber(stopLossPct), takeProfitPct: optionalNumber(takeProfitPct), createdAt: now, expiresAt: now + MANUAL_ORDER_MINUTES * 60_000 });
    saveManualOrders(); renderManualOrders();
    showToast(`Ordre limite placé : $${token.symbol} à $${(token.price * (1 - dip / 100)).toLocaleString(locale, { maximumSignificantDigits: 4 })} (−${dip} %), valable ${MANUAL_ORDER_MINUTES} min.`);
    return;
  }
  state.balance -= amount;
  state.positions.unshift(openPosition(token, amount, { costs, preset, stopLossPct, takeProfitPct }));
  saveWallet(); renderPositions();
  showToast(`Achat simulé de ${formatMoney(amount)} sur $${token.symbol}${state.market.live ? "" : " (prix simulés)"}.`);
});

/* ---- Manual limit orders: buy on a pullback ---- */
const MANUAL_ORDER_MINUTES = 60;
const optionalNumber = value => { const number = Number(value); return Number.isFinite(number) && number > 0 ? number : null; };
let manualOrders = (() => { try { return normalizeLimitOrders(JSON.parse(localStorage.getItem("pulse-manual-orders") || "[]")); } catch { return []; } })();
function saveManualOrders() { try { localStorage.setItem("pulse-manual-orders", JSON.stringify(manualOrders)); } catch { /* storage unavailable */ } }

function renderManualOrders() {
  const node = document.querySelector("#manual-orders");
  if (!node) return;
  node.innerHTML = manualOrders.length
    ? `<div class="dash-head list-head"><strong>Ordres limites en attente</strong></div>${manualOrders.map(order => `<div class="limit-order"><span><b>$${esc(order.symbol)}</b> · achat ${formatMoney(order.amount)} à $${order.limitPrice.toLocaleString(locale, { maximumSignificantDigits: 4 })} (−${order.dipPct} %)</span><small>expire dans ${Math.max(0, Math.ceil((order.expiresAt - Date.now()) / 60_000))} min</small><button class="text-button" type="button" data-cancel-order="${esc(order.id)}">Annuler</button></div>`).join("")}`
    : "";
}
document.querySelector("#manual-orders").addEventListener("click", event => {
  const button = event.target.closest("[data-cancel-order]");
  if (!button) return;
  manualOrders = manualOrders.filter(order => order.id !== button.dataset.cancelOrder);
  saveManualOrders(); renderManualOrders();
  showToast("Ordre limite annulé.");
});

function runManualOrders() {
  if (state.mode === "live" || !manualOrders.length || !tokens.length || !state.market.live) return;
  const { filled, expired, waiting } = settleLimitOrders(manualOrders, id => tokenFor({ tokenId: id }));
  manualOrders = waiting;
  for (const order of expired) notify({ type: "entry", tokenId: order.tokenId, title: `Ordre limite expiré · $${order.symbol}`, body: `Le prix n'est pas descendu à $${order.limitPrice.toLocaleString(locale, { maximumSignificantDigits: 4 })}.` });
  let bought = false;
  for (const { order, token } of filled) {
    const preset = activePreset(order.amount);
    const costs = costsFor(preset, currentSolUsd());
    const error = validateBuy(token, order.amount, state.balance, { preset, costs });
    if (error) { notify({ type: "entry", tokenId: order.tokenId, title: `Ordre limite annulé · $${order.symbol}`, body: error }); continue; }
    state.balance -= order.amount;
    state.positions.unshift(openPosition(token, order.amount, { costs, preset, stopLossPct: order.stopLossPct, takeProfitPct: order.takeProfitPct }));
    bought = true;
    notify({ type: "entry", tokenId: order.tokenId, title: `Ordre limite exécuté · $${order.symbol}`, body: `Achat ${formatMoney(order.amount)} sur repli (−${order.dipPct} %)` });
  }
  if (filled.length || expired.length) saveManualOrders();
  if (bought) renderPositions();
  renderManualOrders();
}

function sellPosition(positionId, fraction, reason = "manual") {
  const index = state.positions.findIndex(position => position.id === positionId);
  if (index === -1) return null;
  const position = state.positions[index];
  const sale = sellFraction(position, tokenFor(position), fraction, { reason, force: reason !== "manual" });
  if (!sale || sale.blocked) return sale;
  if (sale.remaining) state.positions[index] = sale.remaining; else state.positions.splice(index, 1);
  state.balance += sale.proceeds;
  state.history = pushHistory(state.history, sale.trade);
  return sale;
}

/** Closes every position whose stop-loss or take-profit was crossed by the latest prices. */
function runTriggers() {
  if (state.mode === "live") return false;
  const fired = [];
  for (const position of [...state.positions]) {
    const token = tokenFor(position);
    if (!token) continue;
    const reason = checkTriggers(position, token);
    if (!reason) continue;
    const sale = sellPosition(position.id, 1, reason);
    if (!sale) continue;
    const pnlText = `${sale.trade.pnl >= 0 ? "+" : ""}${formatMoney(sale.trade.pnl, 2)} (${signed(sale.trade.pnlPct)})`;
    fired.push(position.tokenSymbol);
    notify({
      type: reason,
      tokenId: position.tokenId,
      title: reason === "take-profit" ? `Take-profit atteint · $${position.tokenSymbol}` : `Stop-loss déclenché · $${position.tokenSymbol}`,
      body: `Position clôturée à ${formatMoney(sale.proceeds, 2)} · ${pnlText}`
    });
  }
  return fired.length > 0;
}

/* ---- Positions turning positive: animated notification ---- */
const PROFIT_ENTER_PCT = 0.5;
const profitState = new Map();

function showProfitToast({ symbol, pct, pnl, tokenId }) {
  const node = document.createElement("div");
  node.className = "profit-toast";
  node.setAttribute("role", "status");
  node.innerHTML = `<span class="profit-burst" aria-hidden="true">${Array.from({ length: 10 }, (_, index) => `<i style="--a:${index * 36}deg"></i>`).join("")}</span>
    <span class="profit-icon" aria-hidden="true">▲</span>
    <div><strong>$${esc(symbol)} passe en positif</strong><small>${signed(pct)} · ${signedMoney(pnl)}</small></div>`;
  node.addEventListener("click", () => { if (tokenId && tokens.some(token => token.id === tokenId)) openCoin(tokenId); node.remove(); });
  document.body.append(node);
  setTimeout(() => node.classList.add("leaving"), 4200);
  setTimeout(() => node.remove(), 4800);
}

/** Fires once when a paper position moves from loss to profit (net of fees and price impact); a small hysteresis avoids flicker around zero. */
function detectProfitCrossings() {
  if (state.mode === "live") return;
  const open = new Set(state.positions.map(position => position.id));
  for (const id of profitState.keys()) if (!open.has(id)) profitState.delete(id);
  for (const position of state.positions) {
    const token = tokenFor(position);
    if (!token || !(token.price > 0)) continue;
    const pct = (positionValue(position, token) - position.amount) / position.amount * 100;
    const previous = profitState.get(position.id);
    const { next, crossed } = profitTransition(previous, pct, PROFIT_ENTER_PCT);
    profitState.set(position.id, next);
    if (!crossed || !notifState.profit) continue;
    const pnl = positionValue(position, token) - position.amount;
    notify({ type: "profit", tokenId: position.tokenId, title: `Position en positif · $${position.tokenSymbol}`, body: `${signed(pct)} · ${signedMoney(pnl)}`, toast: false });
    showProfitToast({ symbol: position.tokenSymbol, pct, pnl, tokenId: position.tokenId });
    const card = document.querySelector(`[data-pid="${CSS.escape(position.id)}"]`);
    if (card) { card.classList.remove("flash-up"); void card.offsetWidth; card.classList.add("flash-up"); }
  }
}

document.querySelector("#positions-list").addEventListener("change", event => {
  const input = event.target.closest("[data-limit]");
  const position = input && state.positions.find(item => item.id === input.dataset.position);
  if (!position) return;
  const value = Number(input.value);
  const limit = Number.isFinite(value) && value > 0 ? (input.dataset.limit === "stopLossPct" ? Math.min(value, 99) : value) : null;
  position[input.dataset.limit] = limit;
  const fired = runTriggers();
  saveWallet(); renderPositions();
  if (!fired) showToast(limit ? "Limite enregistrée." : "Limite retirée.");
});
document.querySelector("#positions-list").addEventListener("click", event => {
  const button = event.target.closest("[data-close]");
  if (!button) return;
  const sale = sellPosition(button.dataset.close, Number(button.dataset.fraction) || 1);
  if (!sale) return;
  if (sale.blocked) {
    showToast(`Vente bloquée : impact ${(sale.impact * 100).toFixed(1)} % > slippage ${sale.limit} % du preset. Vends en plusieurs fois (25 %).`);
    return;
  }
  saveWallet(); renderPositions();
  showToast(`Vente ${Math.round(sale.trade.fraction * 100)} % : ${formatMoney(sale.proceeds, 2)} (${sale.trade.pnl >= 0 ? "+" : ""}${formatMoney(sale.trade.pnl, 2)}).`);
});
document.querySelector("#reset-wallet").addEventListener("click", () => {
  state.balance = START_BALANCE; state.positions = []; state.history = []; state.equity = []; saveEquity(); saveWallet(); recordEquity(true); renderEquity(); renderPositions(); showToast("Paper wallet réinitialisé à 10 000 $.");
});
document.querySelectorAll("[data-scroll]").forEach(button => button.addEventListener("click", () => { if (document.querySelector("#positions").hidden) showView("scanner"); document.querySelector(`#${button.dataset.scroll}`).scrollIntoView(); }));

async function loadTokens(refresh = false) {
  if (window.location.protocol === "file:" || state.market.loading) return false;
  state.market.loading = true;
  try {
    const params = new URLSearchParams();
    if (refresh) params.set("refresh", "1");
    const callIds = recentCallTokenIds();
    const heldIds = [...new Set([...state.positions.map(position => position.tokenId), ...state.custom, ...callIds])].slice(0, 30);
    if (heldIds.length) params.set("held", heldIds.join(","));
    const response = await fetch(`/api/tokens${params.size ? `?${params}` : ""}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload?.tokens) || payload.tokens.length === 0) throw new Error("Invalid token payload");
    const previousTokens = new Map(tokens.map(token => [token.id, token]));
    tokens = payload.tokens.map(token => {
      const previous = previousTokens.get(token.id);
      const movement = {};
      for (const metric of ["marketCap", "price", "transactions", "volume24h", "change5m", "change", "change6h", "change24h", "liquidity"]) {
        if (!previous || token[metric] === previous[metric]) continue;
        movement[metric] = token[metric] > previous[metric] ? "tick-up" : "tick-down";
      }
      const history = [...(state.priceHistory.get(token.id) ?? []), token.price].slice(-32);
      state.priceHistory.set(token.id, history);
      const athMarketCap = Math.max(Number(token.athMarketCap) || 0, previous?.athMarketCap ?? 0, Number(token.marketCap) || 0) || null;
      return { ...token, athMarketCap, movement, seenAt: Date.now() };
    });
    state.held = new Map((payload.held ?? []).map(token => [token.id, token]));
    for (const token of state.held.values()) {
      if (state.custom.has(token.id) && !tokens.some(item => item.id === token.id)) tokens.push({ ...token, custom: true, movement: {} });
      else if (callIds.has(token.id) && !tokens.some(item => item.id === token.id)) tokens.push({ ...token, fromCall: true, movement: {} });
    }
    for (const position of state.positions) {
      const live = tokenFor(position);
      if (live?.price > 0) { position.lastPrice = live.price; position.liquidity = live.liquidity ?? position.liquidity; }
    }
    runTriggers();
    detectProfitCrossings();
    saveWallet();
    if (!tokens.some(token => token.id === state.selected)) state.selected = tokens[0].id;
    document.querySelector("#stat-scanned").textContent = Number(payload.scanned ?? 0).toLocaleString(locale);
    document.querySelector("#stat-qualified").textContent = tokens.filter(token => token.signal ? token.signal.tradable : token.score >= 70).length;
    renderMarketTotals();
    detectNewQualified(Boolean(payload.live));
    renderSignals();
    const source = document.querySelector("#data-source");
    source.textContent = payload.live ? "LIVE · DEX SCREENER" : "DONNÉES SIMULÉES · API INDISPONIBLE";
    source.className = payload.live ? "positive" : "negative";
    document.querySelector("#price-label").textContent = payload.live ? "Prix marché" : "Prix simulé";
    state.market.live = Boolean(payload.live);
    state.market.updatedAt = new Date(payload.updatedAt).getTime();
    state.market.nextRefreshAt = Date.now() + LIVE_REFRESH_MS;
    runBot();
    runManualOrders();
    saveWallet();
    document.querySelector("#scanner-label").textContent = payload.live ? "Marché live" : "Mode simulation";
    return true;
  } catch (error) {
    console.warn("API unavailable, using local demo data", error);
    document.querySelector("#scanner-label").textContent = "Flux interrompu";
    return false;
  } finally {
    state.market.loading = false;
  }
}

function updateLiveClock() {
  const label = document.querySelector("#last-scan");
  if (!state.market.updatedAt) return;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - state.market.updatedAt) / 1000));
  const remainingSeconds = Math.max(0, Math.ceil((state.market.nextRefreshAt - Date.now()) / 1000));
  const quoteAge = state.market.quotesAt ? Math.max(0, Math.floor((Date.now() - state.market.quotesAt) / 1000)) : null;
  label.textContent = state.market.live
    ? (quoteAge != null && quoteAge < 15 ? `live · cours actualisés il y a ${quoteAge} s` : `mis à jour il y a ${ageSeconds} s · prochain dans ${remainingSeconds} s`)
    : `données de secours · tentative dans ${remainingSeconds} s`;
}

async function refreshLiveMarket() {
  if (document.hidden || state.market.loading) return;
  const loaded = await loadTokens(true);
  if (!loaded) {
    state.market.nextRefreshAt = Date.now() + LIVE_REFRESH_MS;
    return;
  }
  renderTable();
  renderMarketTotals();
  renderDetail();
  renderPositions();
}

async function initialize() {
  await loadTokens();
  applyMarketMode();
  renderDetail();
  renderPositions();
  renderWallet();
  updateLiveClock();
  setInterval(updateLiveClock, 1_000);
  setInterval(refreshLiveMarket, LIVE_REFRESH_MS);
  scheduleLiveTick(1_000);
  showView("positions");
}

initialize().catch(error => {
  console.error("Application initialization failed", error);
  showToast("Impossible d'initialiser le scanner.");
});

try {
  const limits = JSON.parse(localStorage.getItem("pulse-limits") || "null");
  if (limits) { document.querySelector("#stop-loss").value = limits.sl ?? ""; document.querySelector("#take-profit").value = limits.tp ?? ""; document.querySelector("#trade-dip").value = limits.dip ?? "0"; }
} catch { /* ignore corrupt saved limits */ }

renderManualOrders();

/* ---- Telegram calls: public channels that announce trades ---- */
const CALL_FRESH_MS = 60 * 60_000;
/** Tokens announced in the last hour: kept in the market data so the bot can evaluate them like any scanned token. */
function recentCallTokenIds() {
  try { return new Set(calls.items.filter(call => call.at && Date.now() - call.at <= CALL_FRESH_MS).map(call => call.token.address).slice(0, 10)); } catch { return new Set(); } // `calls` is not initialised yet during the first scan
}
const MAX_CALL_CHANNELS = 8;
const calls = { channels: [], items: [], seen: new Set(), loaded: false, timer: null, bot: { connected: false, username: null, error: null } };
try { const saved = JSON.parse(localStorage.getItem("pulse-telegram") || "[]"); if (Array.isArray(saved)) calls.channels = saved.filter(name => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name)).slice(0, MAX_CALL_CHANNELS); } catch { /* ignore */ }
try { calls.seen = new Set(JSON.parse(localStorage.getItem("pulse-telegram-seen") || "[]")); } catch { /* ignore */ }
const saveCallChannels = () => { try { localStorage.setItem("pulse-telegram", JSON.stringify(calls.channels)); } catch { /* storage unavailable */ } };
const saveCallSeen = () => { try { localStorage.setItem("pulse-telegram-seen", JSON.stringify([...calls.seen].slice(-300))); } catch { /* storage unavailable */ } };

function renderCallChannels() {
  document.querySelector("#calls-channels").innerHTML = calls.channels.length
    ? calls.channels.map(name => `<span class="call-chip">@${esc(name)}<button type="button" data-remove-channel="${esc(name)}" aria-label="Retirer le canal">×</button></span>`).join("")
    : '<p class="signals-help">Aucun canal pour le moment. Ajoute un canal public ci-dessus.</p>';
}

function renderCalls() {
  const list = document.querySelector("#calls-list");
  document.querySelector("#calls-count").textContent = calls.items.length;
  if (!calls.channels.length && !calls.bot.connected) { list.innerHTML = ""; return; }
  list.innerHTML = calls.items.length ? calls.items.map(call => {
    const token = call.token;
    const change = token.change1h;
    return `<article class="call-card">
      <div class="call-head"><strong>$${esc(token.symbol)}</strong> <span>${esc(token.name)}</span><small>${call.private ? "🔒 " : "@"}${esc(call.channel)} · ${call.at ? timeAgo(call.at) : ""}</small></div>
      <p class="call-text">${esc(call.text.slice(0, 220))}</p>
      <div class="call-stats">
        <span>Prix <b>${esc(formatPrice(token.price))}</b></span><span>Market cap <b>${esc(formatMarketMoney(token.marketCap))}</b></span><span>Liquidité <b>${esc(formatMarketMoney(token.liquidity))}</b></span>
        <span>1 h <b class="${change >= 0 ? "positive" : "negative"}">${change == null ? "—" : `${change >= 0 ? "+" : ""}${change.toLocaleString(locale, { maximumFractionDigits: 1 })} %`}</b></span>
        ${call.sl ? `<span>SL du call <b>${esc(call.sl)}</b></span>` : ""}${call.tp ? `<span>TP du call <b>${esc(call.tp)}</b></span>` : ""}
      </div>
      <div class="call-actions"><button class="text-button" type="button" data-open-call="${esc(token.address)}">Analyser dans Pulse</button>${call.url ? `<a class="text-button" href="${esc(call.url)}" target="_blank" rel="noopener noreferrer">Voir sur Telegram ↗</a>` : ""}</div>
    </article>`;
  }).join("") : '<div class="empty-state">Aucune annonce de token trouvée dans les derniers messages de ces canaux.</div>';
}

async function loadPrivateCalls() {
  try {
    const response = await fetch("/api/telegram/private", { headers: { accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok) { calls.bot = { connected: false, username: null, error: payload.error ?? "Indisponible" }; return []; }
    calls.bot = { connected: Boolean(payload.connected), username: payload.username ?? null, error: null };
    return payload.calls ?? [];
  } catch { return []; }
}

function renderBotStatus() {
  const node = document.querySelector("#tg-bot-status");
  node.innerHTML = calls.bot.error ? `<p class="auth-error">${esc(calls.bot.error)}</p>`
    : calls.bot.connected ? `<span class="plan-pill ok">Bot @${esc(calls.bot.username ?? "")} connecté</span> <button class="text-button" id="tg-bot-disconnect" type="button">Déconnecter et effacer les messages</button>`
      : "";
}

async function loadCalls({ background = false } = {}) {
  const status = document.querySelector("#calls-status");
  if (!background) status.textContent = "chargement…";
  try {
    let payload = { calls: [], errors: {}, at: Date.now() };
    if (calls.channels.length) {
      const response = await fetch(`/api/telegram/calls?channels=${encodeURIComponent(calls.channels.join(","))}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      payload = await response.json();
    }
    const privateCalls = await loadPrivateCalls();
    renderBotStatus();
    const merged = [...payload.calls, ...privateCalls].sort((first, second) => (second.at ?? 0) - (first.at ?? 0)).slice(0, 40);
    const errors = Object.entries(payload.errors ?? {}).map(([channel, message]) => `@${channel} : ${message}`);
    const error = document.querySelector("#calls-error");
    error.hidden = !errors.length; error.textContent = errors.join(" · ");
    if (calls.loaded) {
      for (const call of merged) {
        if (calls.seen.has(call.post)) continue;
        notify({ type: "call", tokenId: call.token.address, title: `Call Telegram · $${call.token.symbol}`, body: `${call.private ? "🔒 " : "@"}${call.channel} · MCAP ${formatMarketMoney(call.token.marketCap)} · liquidité ${formatMarketMoney(call.token.liquidity)}` });
      }
    }
    for (const call of merged) calls.seen.add(call.post);
    calls.loaded = true; saveCallSeen();
    calls.items = merged;
    status.textContent = `mis à jour ${new Date(payload.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
    renderCalls();
  } catch {
    status.textContent = "indisponible";
  }
}

document.querySelector("#tg-bot-form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.querySelector("#tg-bot-token");
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch("/api/telegram/bot", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ token: input.value.trim() }) });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Échec");
    input.value = "";
    calls.bot = { connected: true, username: payload.username, error: null }; calls.loaded = false;
    showToast(`Bot @${payload.username} connecté. Ajoute-le à tes groupes : les nouveaux messages apparaîtront ici.`);
    loadCalls();
  } catch (error) { showToast(error.message); }
  button.disabled = false;
});
document.querySelector("#tg-bot-status").addEventListener("click", async event => {
  if (!event.target.closest("#tg-bot-disconnect")) return;
  await fetch("/api/telegram/bot", { method: "DELETE", headers: { accept: "application/json" } });
  calls.bot = { connected: false, username: null, error: null }; calls.items = calls.items.filter(call => !call.private); calls.loaded = false;
  renderBotStatus(); renderCalls();
  showToast("Bot déconnecté : token et messages supprimés.");
});

document.querySelector("#calls-form").addEventListener("submit", event => {
  event.preventDefault();
  const input = document.querySelector("#calls-input");
  const name = input.value.trim().replace(/^(https?:\/\/)?(t\.me|telegram\.me)\/(s\/)?/i, "").replace(/^@/, "").split(/[/?#]/)[0];
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(name)) return showToast("Nom de canal invalide : utilise le nom public du canal (5 à 32 caractères).");
  if (calls.channels.some(item => item.toLowerCase() === name.toLowerCase())) return showToast("Canal déjà ajouté.");
  if (calls.channels.length >= MAX_CALL_CHANNELS) return showToast(`Limite de ${MAX_CALL_CHANNELS} canaux atteinte.`);
  calls.channels.push(name); calls.loaded = false; saveCallChannels();
  input.value = "";
  renderCallChannels(); loadCalls();
});
document.querySelector("#calls-channels").addEventListener("click", event => {
  const button = event.target.closest("[data-remove-channel]");
  if (!button) return;
  calls.channels = calls.channels.filter(name => name !== button.dataset.removeChannel); saveCallChannels();
  renderCallChannels(); loadCalls();
});
document.querySelector("#calls-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-open-call]");
  if (!button) return;
  const address = button.dataset.openCall;
  if (!tokens.some(token => token.id === address)) {
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(address)}`, { headers: { accept: "application/json" } });
      const found = (await response.json()).tokens?.find(token => token.id === address);
      if (!found) return showToast("Token introuvable sur DexScreener.");
      state.custom.add(found.id); saveCustom(); tokens.push({ ...found, custom: true, movement: {} });
    } catch { return showToast("Impossible d'ouvrir ce token pour le moment."); }
  }
  showView("scanner");
  openCoin(address);
});
renderCallChannels();
loadCalls({ background: true });
calls.timer = setInterval(() => loadCalls({ background: true }), 90_000);

/* ---- Views and standings ---- */
const standingsState = { board: "competition", slug: null, timer: null, data: null };
const money = value => `${value >= 0 ? "+" : "−"}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const isQualified = token => (token.signal ? token.signal.tradable : token.score >= 70);

function signalCard(token) {
  const reasons = (token.signal?.reasons ?? []).slice(0, 3).map(reason => `<li>${esc(reason)}</li>`).join("");
  return `<button class="signal-card" type="button" data-open-coin="${esc(token.id)}">
    <div class="signal-card-head">
      <span class="mini-avatar" style="--accent:${esc(token.accent)}">${avatarContent(token)}</span>
      <span class="signal-card-name"><strong>${esc(token.name)}</strong><small>$${esc(token.symbol)} · ${formatTokenAge(token)}${token.pump ? ` · ${token.pump.graduated ? "gradué" : "pump.fun"}` : ""}</small></span>
      <span class="grade grade-${esc(token.signal?.grade ?? "C")}">${esc(token.signal?.grade ?? "")} <b>${token.score}</b></span>
    </div>
    <div class="signal-card-stats"><span>MCAP <strong>${formatMarketMoney(token.marketCap)}</strong></span><span>Liq <strong>${formatMarketMoney(token.liquidity)}</strong></span><span>1H ${changePill(token.change, "")}</span><span>6H ${changePill(token.change6h, "")}</span></div>
    <div data-plan-chip="${esc(token.id)}">${planChip(token)}</div>
    <ul class="signal-card-reasons">${reasons}</ul>
  </button>`;
}

function earlyCard(token) {
  const early = token.early;
  const reasons = early.reasons.slice(0, 3).map(reason => `<li>${esc(reason)}</li>`).join("");
  return `<button class="signal-card early-card" type="button" data-open-coin="${esc(token.id)}">
    <div class="signal-card-head">
      <span class="mini-avatar" style="--accent:${esc(token.accent)}">${avatarContent(token)}</span>
      <span class="signal-card-name"><strong>${esc(token.name)}</strong><small>$${esc(token.symbol)} · ${formatTokenAge(token)}${token.pump ? ` · ${token.pump.graduated ? "gradué" : "pump.fun"}` : ""}</small></span>
      <span class="grade grade-early">⚡ <b>${early.score}</b></span>
    </div>
    <div class="signal-card-stats"><span>${esc(early.stage)}</span><span>5M ${changePill(token.change5m, "")}</span><span>1H ${changePill(token.change, "")}</span><span>6H ${changePill(token.change6h, "")}</span></div>
    <div class="signal-card-stats"><span>MCAP <strong>${formatMarketMoney(token.marketCap)}</strong></span><span>Liq <strong>${formatMarketMoney(token.liquidity)}</strong></span><span>Vol ×<strong>${early.acceleration.toFixed(1)}</strong></span></div>
    <ul class="signal-card-reasons">${reasons}</ul>
  </button>`;
}

function renderSignals() {
  const starts = tokens.filter(token => token.early?.early).sort((first, second) => second.early.score - first.early.score);
  document.querySelector("#early-cards").innerHTML = starts.length
    ? starts.map(earlyCard).join("")
    : '<div class="positions-empty">Aucun démarrage détecté pour le moment. Les conditions sont strictes : reviens dans quelques minutes.</div>';
  const earlyBadge = document.querySelector("#early-count");
  earlyBadge.hidden = starts.length === 0;
  earlyBadge.textContent = `⚡${starts.length}`;
  const qualified = tokens.filter(isQualified).sort((first, second) => second.score - first.score);
  const watch = tokens.filter(token => !isQualified(token) && token.signal?.grade === "C").sort((first, second) => second.score - first.score).slice(0, 6);
  document.querySelector("#signals-count").textContent = qualified.length;
  document.querySelector("#signals-status").textContent = state.market.live ? `${qualified.length} sur ${tokens.length} tokens analysés` : "données simulées";
  document.querySelector("#signal-cards").innerHTML = qualified.length
    ? qualified.map(signalCard).join("")
    : '<div class="positions-empty">Aucun token ne passe tous les filtres pour le moment. C’est normal : le filtre est volontairement strict. Reviens dans quelques minutes.</div>';
  document.querySelector("#watch-cards").innerHTML = watch.length ? watch.map(signalCard).join("") : '<div class="positions-empty">Rien à surveiller pour l’instant.</div>';
}

let newCoinsTimer = null;
const historyPage = { filter: "all", status: new Map(), timer: null, loaded: false };

function showView(view) {
  document.querySelectorAll("[data-view]").forEach(section => { section.hidden = section.dataset.view !== view; });
  document.querySelectorAll("[data-view-tab]").forEach(button => button.classList.toggle("active", button.dataset.viewTab === view));
  clearInterval(standingsState.timer);
  clearInterval(newCoinsTimer);
  clearInterval(historyPage.timer);
  if (view === "admin") import("./admin.js").then(module => module.loadAdmin());
  if (view === "history") { renderHistoryPage(); loadHistoryStatus(); historyPage.timer = setInterval(loadHistoryStatus, 15_000); }
  if (view === "newcoins") { loadNewCoins(); newCoinsTimer = setInterval(loadNewCoins, 10_000); }
  if (view === "signals") renderSignals();
  if (view === "calls") { renderCallChannels(); loadCalls(); }
  if (view === "positions") { renderPositions(); ensureEquityChart(); }
  if (view === "standings") {
    loadStandings();
    standingsState.timer = setInterval(loadStandings, 60_000);
  }
}

function timeLeft(endsAt) {
  const ms = new Date(endsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "terminé";
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 24 ? `${Math.floor(hours / 24)} j ${hours % 24} h` : `${hours} h ${Math.floor((ms % 3_600_000) / 60_000)} min`;
}

function standingAvatar(entry) {
  return entry.profileImage
    ? `<span class="standing-avatar"><img src="${esc(entry.profileImage)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
    : `<span class="standing-avatar">${esc(entry.username.slice(0, 2).toUpperCase())}</span>`;
}

function paperPnl() {
  return state.balance + portfolioValue() - START_BALANCE;
}

function renderStandings(payload) {
  const { competitions, board } = payload;
  const select = document.querySelector("#competition-select");
  select.hidden = standingsState.board !== "competition";
  select.innerHTML = competitions.map(item => `<option value="${esc(item.slug)}" ${item.slug === (board?.competition?.slug ?? standingsState.slug) ? "selected" : ""}>${esc(item.title)}${item.phase === "live" ? " · live" : item.phase === "upcoming" ? " · à venir" : ""}</option>`).join("");

  const card = document.querySelector("#competition-card");
  const table = document.querySelector("#standings-table");
  const rank = document.querySelector("#paper-rank");
  if (!board) {
    card.innerHTML = "";
    rank.innerHTML = "";
    table.innerHTML = '<div class="positions-empty">Aucun classement disponible pour le moment.</div>';
    return;
  }

  if (board.kind === "competition") {
    const c = board.competition;
    card.innerHTML = `<div><strong>${esc(c.title)}</strong><span>${esc(c.description)}</span></div>
      <div class="competition-stats"><span>Cagnotte <strong>$${formatInteger(c.prizePool)}</strong></span><span>Participants <strong>${formatInteger(c.participants)}</strong></span><span>${c.phase === "live" ? "Fin dans" : "Phase"} <strong>${c.phase === "live" ? esc(timeLeft(c.endsAt)) : esc(c.phase)}</strong></span></div>`;
  } else {
    card.innerHTML = `<div><strong>Classement PnL pump.fun</strong><span>${esc(board.label)} · meilleurs traders par profit réalisé et latent</span></div>`;
  }

  const lastPaid = board.kind === "competition" ? Math.max(0, ...board.competition.prizes.map(prize => prize.rankTo)) : 0;
  table.innerHTML = board.entries.map(entry => {
    const crown = entry.rank <= 3 ? `<span class="crown">♛</span>` : "";
    const divider = lastPaid && entry.rank === lastPaid + 1 ? `<div class="paid-divider"><span>TOP ${lastPaid} GET PAID</span></div>` : "";
    return `${divider}<a class="standing-row rank-${Math.min(entry.rank, 4)}" href="https://pump.fun/profile/${esc(entry.wallet)}" target="_blank" rel="noopener noreferrer">
      <span class="standing-rank">${entry.rank}</span>
      ${standingAvatar(entry)}
      <span class="standing-name"><strong>${esc(entry.username)} ${crown}</strong><small>${esc(entry.shortWallet)}${entry.topSymbols.length ? ` · ${esc(entry.topSymbols.map(symbol => `$${symbol}`).join(" "))}` : ""}</small></span>
      <span class="standing-pnl"><strong class="${entry.pnlUsd >= 0 ? "positive" : "negative"}">${money(entry.pnlUsd)}</strong>${entry.prize ? `<em class="prize">${formatInteger(entry.prize)}</em>` : ""}</span>
      <span class="follow-btn ${isFollowed(entry.wallet) ? "on" : ""}" role="button" tabindex="0" data-follow="${esc(entry.wallet)}" data-name="${esc(entry.username)}" data-image="${esc(entry.profileImage ?? "")}">${isFollowed(entry.wallet) ? "Suivi ✓" : "+ Suivre"}</span>
    </a>`;
  }).join("");

  const pnl = paperPnl();
  const better = board.entries.filter(entry => entry.pnlUsd > pnl).length;
  const placement = better < board.entries.length ? `ton P&L paper te placerait <strong>#${better + 1}</strong> de ce classement` : `ton P&L paper est en dehors du top ${board.entries.length}`;
  rank.innerHTML = `<span>Ton paper wallet <strong class="${pnl >= 0 ? "positive" : "negative"}">${money(pnl)}</strong></span><span>${placement} <small>(comparaison indicative : les capitaux de départ diffèrent)</small></span>`;
}

async function loadStandings() {
  if (standingsState.board === "follows") return;
  const status = document.querySelector("#standings-status");
  const params = new URLSearchParams();
  if (standingsState.board !== "competition") params.set("period", standingsState.board);
  else if (standingsState.slug) params.set("slug", standingsState.slug);
  try {
    const response = await fetch(`/api/standings${params.size ? `?${params}` : ""}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    standingsState.data = payload;
    if (payload.board?.kind === "competition") standingsState.slug = payload.board.competition.slug;
    status.textContent = `mis à jour ${new Date(payload.board?.updatedAt ?? Date.now()).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
    renderStandings(payload);
  } catch {
    status.textContent = "indisponible";
    document.querySelector("#standings-table").innerHTML = '<div class="positions-empty">Classement momentanément indisponible. Réessaie dans un instant.</div>';
  }
}

document.querySelectorAll("[data-view-tab]").forEach(button => button.addEventListener("click", () => showView(button.dataset.viewTab)));
document.querySelectorAll("[data-board]").forEach(button => button.addEventListener("click", () => {
  standingsState.board = button.dataset.board;
  document.querySelectorAll("[data-board]").forEach(item => item.classList.toggle("active", item === button));
  const follows = standingsState.board === "follows";
  document.querySelector("#follows-panel").hidden = !follows;
  document.querySelector("#standings-table").hidden = follows;
  document.querySelector("#competition-card").hidden = follows;
  document.querySelector("#paper-rank").hidden = follows;
  document.querySelector("#competition-select").hidden = follows || standingsState.board !== "competition";
  if (follows) { document.querySelector("#standings-status").textContent = `${followState.list.length} trader${followState.list.length > 1 ? "s" : ""} suivi${followState.list.length > 1 ? "s" : ""}`; renderFollows(); pollFollows(); return; }
  document.querySelector("#standings-status").textContent = "chargement…";
  loadStandings();
}));
document.querySelector("#competition-select").addEventListener("change", event => {
  standingsState.slug = event.target.value;
  loadStandings();
});

/* ---- Signal reliability (server-side forward test) ---- */
const pct = value => (value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`);
const HORIZON_LABELS = { m15: "15 min", h1: "1 h", h4: "4 h" };

function statsRows(label, data) {
  return Object.entries(HORIZON_LABELS).map(([key, horizon]) => {
    const cell = data[key];
    const tone = cell.avg == null ? "" : cell.avg >= 0 ? "positive" : "negative";
    return `<tr><td>${key === "m15" ? esc(label) : ""}</td><td>${horizon}</td><td>${formatInteger(cell.n)}</td><td>${cell.winRate == null ? "—" : `${Math.round(cell.winRate * 100)} %`}</td><td class="${tone}">${pct(cell.avg)}</td><td>${pct(cell.median)}</td></tr>`;
  }).join("");
}

const FLAG_LABELS = {
  "low-liquidity": "Liquidité < 20 k$", "too-new": "Token < 20 min", "sell-pressure": "Pression vendeuse", "dumping": "Chute −25 % / 1 h",
  "already-pumped": "Déjà trop monté", "thin-vs-mcap": "Market cap > 100× liquidité", "far-from-ath": "Loin de l'ATH", "fading": "Marché qui s'éteint",
  "big-orders": "Gros ordres (wash)", "turnover": "Rotation anormale", "concentrated": "Top 10 > 60 % du supply", "insiders": "Snipers/bundlers/dev > 25 %"
};

function earlyBlock(early) {
  if (!early?.count) return '<h4 class="stats-subtitle">⚡ Démarrages</h4><p class="x-note">Aucun démarrage suivi pour le moment.</p>';
  const rate = value => (value == null ? "—" : `${Math.round(value * 100)} %`);
  return `<h4 class="stats-subtitle">⚡ Démarrages détectés : combien ont atteint +50 %, +100 %, +200 % dans les 4 h ?</h4>
    <table class="stats-table"><thead><tr><th>Suivis</th><th>Fenêtre 4 h terminée</th><th>+50 %</th><th>+100 %</th><th>+200 %</th><th>Ont perdu 25 %</th><th>Gain max moyen</th></tr></thead>
    <tbody><tr><td>${formatInteger(early.count)}</td><td>${formatInteger(early.completed)}</td><td>${rate(early.hit50)}</td><td>${rate(early.hit100)}</td><td>${rate(early.hit200)}</td><td>${rate(early.fellMinus25)}</td><td class="${(early.avgMaxGain ?? 0) >= 0 ? "positive" : "negative"}">${pct(early.avgMaxGain)}</td></tr></tbody></table>
    ${early.completed < 30 ? '<p class="x-note">Moins de 30 démarrages terminés : résultats encore peu fiables.</p>' : ""}`;
}

function flagRows(flags) {
  const rows = Object.entries(flags ?? {}).filter(([, data]) => data.h1.n > 0).sort((first, second) => second[1].h1.n - first[1].h1.n);
  if (!rows.length) return "";
  return `<h4 class="stats-subtitle">Efficacité des filtres (résultat à 1 h des tokens écartés : négatif = le filtre protège)</h4><table class="stats-table"><thead><tr><th>Filtre</th><th>Tokens</th><th>Gagnants</th><th>Rendement net moyen</th></tr></thead><tbody>${rows.map(([code, data]) => `<tr><td>${esc(FLAG_LABELS[code] ?? code)}</td><td>${formatInteger(data.h1.n)}</td><td>${Math.round(data.h1.winRate * 100)} %</td><td class="${data.h1.avg >= 0 ? "positive" : "negative"}">${pct(data.h1.avg)}</td></tr>`).join("")}</tbody></table>`;
}

async function loadSignalStats() {
  try {
    const response = await fetch("/api/signal-stats", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const stats = await response.json();
    const summary = document.querySelector("#signal-stats-summary");
    const body = document.querySelector("#signal-stats-body");
    if (!stats.enabled) { summary.textContent = "suivi désactivé"; return; }
    const hour = stats.tradable.h1;
    summary.textContent = `${formatInteger(stats.tracked)} signaux suivis` + (hour.n ? ` · signaux A/B à 1 h : médiane ${pct(hour.median)}, ${Math.round(hour.winRate * 100)} % gagnants (${hour.n})` : " · résultats à 1 h en attente");
    body.innerHTML = `<table class="stats-table"><thead><tr><th>Groupe</th><th>Horizon</th><th>Signaux</th><th>Gagnants</th><th>Rendement net moyen</th><th>Médiane (plus fiable)</th></tr></thead><tbody>${statsRows("Signaux A/B", stats.tradable)}${statsRows("Reste du marché (référence)", stats.baseline)}</tbody></table>
      ${earlyBlock(stats.early)}
      ${flagRows(stats.flags)}
      <p class="x-note">Chaque signal est enregistré par le serveur puis évalué automatiquement 15 min, 1 h et 4 h plus tard, achat et vente simulés avec frais de 1 % et impact de prix (200 $ par trade). Le serveur doit rester allumé. Les rendements au-delà de ×31 sont écartés comme erreurs de données. Regarde la médiane plutôt que la moyenne, qu'un seul coin explosif peut fausser, et fie-toi à ces chiffres seulement avec au moins 100 signaux par horizon.</p>`;
  } catch { /* stats are optional */ }
}
loadSignalStats();
setInterval(loadSignalStats, 120_000);

/* ---- Add any Solana token by name, symbol or address ---- */
const searchResults = document.querySelector("#search-results");
let searchTimer = null;
let searchSeq = 0;

function hideSearchResults() { searchResults.hidden = true; }

async function runRemoteSearch() {
  const query = state.query.trim();
  const seq = ++searchSeq;
  if (query.length < 2) return hideSearchResults();
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { tokens: found } = await response.json();
    if (seq !== searchSeq) return;
    const fresh = found.filter(token => !tokens.some(item => item.id === token.id));
    if (!fresh.length) return hideSearchResults();
    searchResults.innerHTML = `<p class="search-title">Autres tokens Solana (DexScreener)</p>` + fresh.map(token => `<button class="search-result" type="button" data-add-token="${esc(token.id)}">
      <span class="mini-avatar" style="--accent:${esc(token.accent)}">${avatarContent(token)}</span>
      <span class="search-name"><strong>${esc(token.name)}</strong><small>$${esc(token.symbol)} · ${esc(token.id.slice(0, 4))}…${esc(token.id.slice(-4))}</small></span>
      <span class="search-meta">MC ${formatMarketMoney(token.marketCap)}<small>Liq ${formatMarketMoney(token.liquidity)}</small></span>
      <b>+ Ajouter</b></button>`).join("");
    searchResults.hidden = false;
    searchResults.found = fresh;
  } catch {
    if (seq === searchSeq) hideSearchResults();
  }
}

document.querySelector("#search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runRemoteSearch, 450);
});
searchResults.addEventListener("click", event => {
  const button = event.target.closest("[data-add-token]");
  const token = button && searchResults.found?.find(item => item.id === button.dataset.addToken);
  if (!token) return;
  state.custom.add(token.id);
  saveCustom();
  tokens.push({ ...token, custom: true, movement: {} });
  hideSearchResults();
  document.querySelector("#search").value = "";
  state.query = "";
  openCoin(token.id);
  showToast(`$${token.symbol} ajouté à ta liste.`);
});
document.addEventListener("click", event => { if (!event.target.closest(".search-wrap")) hideSearchResults(); });

/* ---- Token Data & Security for the open coin: holders (pump.fun) and mint authorities (on-chain) ---- */
state.security = new Map();

const NA = "n/d";
const NA_TITLE = "Donnée indisponible via les API publiques";

function securityTile(label, value, tone, { title = "", sub = "" } = {}) {
  return `<div class="sec-tile ${tone}" title="${esc(title)}"><strong>${esc(value)}${sub ? `<small>${esc(sub)}</small>` : ""}</strong><span>${esc(label)}</span></div>`;
}

const riskTone = (value, danger, warning) => (value >= danger ? "bad" : value >= warning ? "warn" : "good");
const percentText = value => `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;

function renderSecurity() {
  const grid = document.querySelector("#security-grid");
  const token = currentToken();
  if (!grid || !token) return;
  const data = state.security.get(token.id);
  const holders = data?.holders?.available ? data.holders : token.holderStats ?? null;
  const reliable = Boolean(holders?.reliable);
  const authority = key => {
    const revoked = data?.authorities?.[key];
    return revoked == null ? securityTile(key === "mintRevoked" ? "Mint Auth." : "Freeze Auth.", data ? NA : "…", "neutral", { title: data ? NA_TITLE : "Chargement" })
      : securityTile(key === "mintRevoked" ? "Mint Auth." : "Freeze Auth.", revoked ? "No" : "Yes", revoked ? "good" : "bad", { title: revoked ? "Autorité révoquée : impossible de créer du supply / geler des comptes" : "Autorité active : risque" });
  };
  const holderTile = (label, text, tone, extra) => (reliable ? securityTile(label, text, tone, extra) : securityTile(label, data ? NA : "…", "neutral", { title: data ? "Disponible pour les tokens lancés sur pump.fun avec au moins 5 détenteurs" : "Chargement" }));
  const feesSol = token.quality?.feesSol;
  grid.innerHTML = [
    holderTile("Holders", reliable ? formatInteger(holders.totalHolders) : "", "neutral"),
    holderTile("Top 10 H.", reliable ? percentText(holders.top10Pct) : "", riskTone(holders?.top10Pct ?? 0, 40, 25)),
    holderTile("Dev holding", reliable ? percentText(holders.devPct) : "", riskTone(holders?.devPct ?? 0, 10, 3)),
    holderTile("Snipers", reliable ? percentText(holders.sniperPct) : "", riskTone(holders?.sniperPct ?? 0, 15, 5), { sub: reliable ? String(holders.sniperCount) : "" }),
    holderTile("Insiders H.", reliable ? percentText(holders.insidersPct ?? holders.devPct + holders.sniperPct + holders.bundlerPct) : "", riskTone(holders?.insidersPct ?? 0, 30, 10), { title: "Dev + snipers + bundlers parmi les principaux détenteurs" }),
    holderTile("Bundles H.", reliable ? percentText(holders.bundlerPct) : "", riskTone(holders?.bundlerPct ?? 0, 10, 3), { sub: reliable ? String(holders.bundlerCount) : "" }),
    securityTile("Fresh buys", NA, "neutral", { title: NA_TITLE }),
    securityTile("Fresh holding", NA, "neutral", { title: NA_TITLE }),
    authority("mintRevoked"),
    authority("freezeRevoked"),
    securityTile("Pro Vol. 1h", NA, "neutral", { title: NA_TITLE }),
    feesSol == null ? securityTile("Total fees", NA, "neutral", { title: NA_TITLE }) : securityTile("Total fees", `≈ ${feesSol.toLocaleString(locale, { maximumFractionDigits: 2 })} SOL`, feesSol >= 0.5 ? "good" : "warn", { title: "Estimation : environ 1 % du volume 24 h converti en SOL" })
  ].join("");
  document.querySelector("#security-note").textContent = reliable ? `${formatInteger(holders.totalHolders)} détenteurs` : "";
}

async function loadSecurity(token) {
  renderSecurity();
  if (!token || state.security.has(token.id) || !BASE58.test(token.id)) return;
  try {
    const response = await fetch(`/api/token-security?mint=${encodeURIComponent(token.id)}`, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const data = await response.json();
    state.security.set(token.id, data);
    if (data.holders?.available) state.holderStats.set(token.id, data.holders);
    if (currentToken().id === token.id) { renderSecurity(); renderDetail(); }
  } catch { /* optional data */ }
}

document.querySelector("#signals-view").addEventListener("click", event => {
  const card = event.target.closest("[data-open-coin]");
  if (card) openCoin(card.dataset.openCoin);
});
renderSignals();

/* ---- Notifications: new qualified coins, take-profit and stop-loss ---- */
const NOTIF_LIMIT = 50;
const QUALIFIED_COOLDOWN_MS = 60 * 60_000;

function loadNotifState() {
  try {
    const saved = JSON.parse(localStorage.getItem("pulse-notifications") || "null");
    return {
      items: Array.isArray(saved?.items) ? saved.items.slice(0, NOTIF_LIMIT) : [],
      sound: saved?.sound ?? false,
      qualified: saved?.qualified ?? true,
      early: saved?.early ?? true,
      profit: saved?.profit ?? true,
      newCoins: saved?.newCoins ?? false,
      traders: saved?.traders ?? true,
      minTrade: Number.isFinite(saved?.minTrade) ? saved.minTrade : 500,
      lastQualified: saved?.lastQualified && typeof saved.lastQualified === "object" ? saved.lastQualified : {}
    };
  } catch {
    return { items: [], sound: false, qualified: true, early: true, traders: true, minTrade: 500, lastQualified: {} };
  }
}
const notifState = loadNotifState();
let knownQualified = null;

function saveNotifState() {
  try { localStorage.setItem("pulse-notifications", JSON.stringify(notifState)); } catch { /* storage unavailable */ }
}

function unreadCount() { return notifState.items.filter(item => !item.read).length; }

function playChime(type) {
  if (!notifState.sound) return;
  try {
    const context = playChime.context ??= new AudioContext();
    const tones = type === "stop-loss" ? [330, 220] : type === "take-profit" ? [660, 880] : type === "profit" ? [523, 659, 784] : [520, 780];
    tones.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, context.currentTime + index * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + index * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + index * 0.14 + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(context.currentTime + index * 0.14);
      oscillator.stop(context.currentTime + index * 0.14 + 0.2);
    });
  } catch { /* audio blocked until the user interacts with the page */ }
}

function notify({ type, title, body, tokenId = null, toast = true }) {
  notifState.items.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type, title, body, tokenId, at: Date.now(), read: false });
  notifState.items = notifState.items.slice(0, NOTIF_LIMIT);
  saveNotifState();
  renderNotifications();
  if (toast) showToast(`${title} — ${body}`);
  playChime(type);
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const popup = new Notification(t(title), { body: t(body), tag: `${type}-${tokenId ?? ""}` });
      popup.onclick = () => { window.focus(); if (tokenId && tokens.some(token => token.id === tokenId)) openCoin(tokenId); popup.close(); };
    } catch { /* some browsers only allow notifications from a service worker */ }
  }
}

/** Notifies once per token (with a cooldown) when it newly enters the qualified list. The first load only records the baseline. */
function detectNewQualified(live) {
  if (!live) return;
  const current = new Set(tokens.filter(isQualified).map(token => token.id));
  if (knownQualified && notifState.qualified) {
    const now = Date.now();
    for (const token of tokens) {
      if (!current.has(token.id) || knownQualified.has(token.id)) continue;
      if (now - (notifState.lastQualified[token.id] ?? 0) < QUALIFIED_COOLDOWN_MS) continue;
      notifState.lastQualified[token.id] = now;
      notify({
        type: "qualified",
        tokenId: token.id,
        title: `Nouveau signal qualifié · $${token.symbol}`,
        body: `Note ${token.signal?.grade ?? ""} (${token.score}) · MCAP ${formatMarketMoney(token.marketCap)} · liquidité ${formatMarketMoney(token.liquidity)}`
      });
    }
    for (const [id, at] of Object.entries(notifState.lastQualified)) if (now - at > 24 * 3_600_000) delete notifState.lastQualified[id];
    saveNotifState();
  }
  knownQualified = current;
  detectNewEarly();
}

const NOTIF_ICON = { profit: "▲", call: "✈", newcoin: "✦", early: "⚡", trader: "◆", qualified: "●", entry: "◎", "take-profit": "▲", "stop-loss": "▼" };

function timeAgo(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "à l’instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `il y a ${hours} h` : `il y a ${Math.floor(hours / 24)} j`;
}

function renderNotifications() {
  const unread = unreadCount();
  const badge = document.querySelector("#notif-badge");
  badge.hidden = unread === 0;
  badge.textContent = unread > 9 ? "9+" : unread;
  document.title = `${unread ? `(${unread}) ` : ""}Pulse — Memecoin Scanner`;
  document.querySelector("#notif-sound").checked = notifState.sound;
  document.querySelector("#notif-qualified").checked = notifState.qualified;
  document.querySelector("#notif-traders").checked = notifState.traders;
  document.querySelector("#notif-early").checked = notifState.early;
  document.querySelector("#notif-profit").checked = notifState.profit;
  document.querySelector("#notif-new").checked = notifState.newCoins;
  document.querySelector("#notif-min-trade").value = String(notifState.minTrade);
  const permission = document.querySelector("#notif-permission");
  const supported = "Notification" in window;
  permission.hidden = !supported || Notification.permission === "granted";
  permission.disabled = supported && Notification.permission === "denied";
  permission.textContent = supported && Notification.permission === "denied" ? "Alertes bloquées dans le navigateur" : "Activer les alertes du navigateur";
  document.querySelector("#notif-list").innerHTML = notifState.items.length
    ? notifState.items.map(item => `<button class="notif-item ${item.read ? "" : "unread"} ${esc(item.type)}" type="button" data-notif="${esc(item.id)}"><span class="notif-icon">${NOTIF_ICON[item.type] ?? "●"}</span><span><strong>${esc(item.title)}</strong><small>${esc(item.body)}</small><em>${timeAgo(item.at)}</em></span></button>`).join("")
    : '<div class="positions-empty">Aucune notification pour le moment. Tu seras alerté d’un nouveau signal qualifié, d’un take-profit ou d’un stop-loss.</div>';
}

document.querySelector("#notif-button").addEventListener("click", () => {
  const menu = document.querySelector("#notif-menu");
  menu.hidden = !menu.hidden;
  if (!menu.hidden) renderNotifications();
});
document.querySelector("#notif-read").addEventListener("click", () => {
  notifState.items.forEach(item => { item.read = true; });
  saveNotifState();
  renderNotifications();
});
document.querySelector("#notif-list").addEventListener("click", event => {
  const row = event.target.closest("[data-notif]");
  const item = row && notifState.items.find(entry => entry.id === row.dataset.notif);
  if (!item) return;
  item.read = true;
  saveNotifState();
  renderNotifications();
  if (item.tokenId) {
    document.querySelector("#notif-menu").hidden = true;
    openTokenById(item.tokenId);
  }
});
document.querySelector("#notif-permission").addEventListener("click", async () => {
  try { await Notification.requestPermission(); } catch { /* unsupported */ }
  renderNotifications();
});
document.querySelector("#notif-sound").addEventListener("change", event => {
  notifState.sound = event.target.checked;
  saveNotifState();
  if (notifState.sound) playChime("qualified");
});
document.querySelector("#notif-new").addEventListener("change", event => {
  notifState.newCoins = event.target.checked;
  saveNotifState();
});
document.querySelector("#notif-profit").addEventListener("change", event => { notifState.profit = event.target.checked; saveNotifState(); });
document.querySelector("#notif-early").addEventListener("change", event => {
  notifState.early = event.target.checked;
  saveNotifState();
});
document.querySelector("#notif-traders").addEventListener("change", event => {
  notifState.traders = event.target.checked;
  saveNotifState();
});
document.querySelector("#notif-min-trade").addEventListener("change", event => {
  notifState.minTrade = Number(event.target.value) || 0;
  saveNotifState();
});
document.querySelector("#notif-qualified").addEventListener("change", event => {
  notifState.qualified = event.target.checked;
  saveNotifState();
});
document.addEventListener("click", event => {
  if (!event.target.closest(".notif-control")) document.querySelector("#notif-menu").hidden = true;
});
renderNotifications();
setInterval(renderNotifications, 60_000);

/* ---- Live lane: visible rows refreshed every ~1.5 s, patched in place ---- */
const LIVE_TICK_MS = 1_500;
const LIVE_CHUNK = 20;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
let liveCursor = 0;
let liveTicks = 0;

function flash(element, tone) {
  if (!element) return;
  element.classList.remove("flash-up", "flash-down");
  void element.offsetWidth;
  element.classList.add(tone === "up" ? "flash-up" : "flash-down");
}

function liveTargets() {
  const important = [...new Set([...state.positions.map(position => position.tokenId), ...(coinModal.hidden ? [] : [state.selected])])].filter(id => BASE58.test(id)).slice(0, 10);
  const rows = [...table.querySelectorAll(".token-row")].map(row => row.dataset.id).filter(id => BASE58.test(id) && !important.includes(id));
  if (!rows.length && !important.length) return [];
  const chunks = Math.max(1, Math.ceil(rows.length / LIVE_CHUNK));
  const start = (liveCursor++ % chunks) * LIVE_CHUNK;
  return [...important, ...rows.slice(start, start + LIVE_CHUNK)].slice(0, 30);
}

function patchRow(token) {
  const row = table.querySelector(`tr[data-id="${CSS.escape(token.id)}"]`);
  if (!row) return;
  const cell = name => row.querySelector(`[data-cell="${name}"]`);
  const set = (name, text) => { const node = cell(name); if (node && node.textContent !== text) node.textContent = text; };

  const mcap = cell("mcap");
  const tone = token.movement?.marketCap === "tick-up" ? "up" : token.movement?.marketCap === "tick-down" ? "down" : null;
  if (mcap) {
    mcap.textContent = formatMarketMoney(token.marketCap);
    if (tone) { mcap.classList.remove("up", "down"); mcap.classList.add(tone); flash(mcap, tone); }
  }
  const ath = cell("ath");
  if (ath) {
    ath.innerHTML = `${athBar(token)}<span>${formatAthMarketCap(token)}</span>`;
    if (token.athFlash) {
      const bar = ath.querySelector(".ath-bar");
      bar?.classList.add("sparkle");
      setTimeout(() => bar?.classList.remove("sparkle"), 1_600);
      token.athFlash = false;
    }
  }
  set("age", formatTokenAge(token));
  set("txns", formatInteger(token.transactions));
  set("vol", formatMarketMoney(token.volume24h));
  for (const [name, key] of [["c1h", "change"], ["c6h", "change6h"], ["c24h", "change24h"]]) {
    const node = cell(name);
    if (node) node.innerHTML = changePill(token[key], token.movement?.[key]);
  }
  const graph = cell("graph");
  if (graph) graph.innerHTML = sparklineSvg(token);
}

const LIVE_METRICS = ["marketCap", "price", "transactions", "volume24h", "change5m", "change", "change6h", "change24h", "liquidity"];

function applyQuotes(quotes) {
  const changed = [];
  for (const quote of quotes) {
    const token = tokens.find(item => item.id === quote.id) ?? state.held.get(quote.id) ?? state.adhoc.get(quote.id);
    if (!token || !(quote.price > 0)) continue;
    const movement = {};
    for (const metric of LIVE_METRICS) {
      if (Number.isFinite(quote[metric]) && quote[metric] !== token[metric]) movement[metric] = quote[metric] > token[metric] ? "tick-up" : "tick-down";
    }
    const previousAth = Number(token.athMarketCap) || 0;
    for (const metric of [...LIVE_METRICS, "volume", "volume5m", "volume6h", "buys", "sells", "buys5m", "sells5m", "ageMinutes"]) {
      if (Number.isFinite(quote[metric])) token[metric] = quote[metric];
    }
    token.seenAt = Date.now();
    const ath = Math.max(previousAth, Number(quote.athMarketCap) || 0, Number(quote.marketCap) || 0);
    token.athFlash = previousAth > 0 && ath > previousAth;
    token.athMarketCap = ath || null;
    token.movement = movement;
    if (Array.isArray(token.priceHistory) && token.priceHistory[token.priceHistory.length - 1] !== quote.price) token.priceHistory = [...token.priceHistory, quote.price].slice(-60);
    changed.push(token);
  }
  state.market.quotesAt = Date.now();
  return changed;
}

async function liveTick() {
  if (document.hidden || state.market.loading || !state.market.live || window.location.protocol === "file:") return 0;
  const ids = liveTargets();
  if (!ids.length) return 0;
  const response = await fetch(`/api/live?ids=${ids.join(",")}`, { headers: { accept: "application/json" } });
  if (response.status === 429) return -1;
  if (!response.ok) return 0;
  const { quotes } = await response.json();
  const changed = applyQuotes(quotes);
  changed.forEach(patchRow);
  liveTicks += 1;

  const fired = runTriggers();
  detectProfitCrossings();
  if (fired) { saveWallet(); renderTable(); renderPositions(); }
  else updateWalletUI();
  const selected = changed.find(token => token.id === state.selected);
  if (selected && !coinModal.hidden) {
    document.querySelector("#detail-price").textContent = formatPrice(selected.price);
    const change = document.querySelector("#detail-change");
    change.textContent = signed(selected.change);
    change.className = selected.change >= 0 ? "positive" : "negative";
    coinChart?.tick?.(selected.price);
    renderCoinHeader(selected);
    renderPlan();
  }
  return changed.length;
}

function scheduleLiveTick(delay = LIVE_TICK_MS) {
  setTimeout(async () => {
    let next = LIVE_TICK_MS;
    try {
      const result = await liveTick();
      if (result === -1) next = 10_000;
    } catch { next = 4_000; }
    scheduleLiveTick(next);
  }, delay);
}

/* ---- Trade plan: entry zone, stop and targets from price action ---- */
const planMoney = value => (value >= 1 ? value.toLocaleString(locale, { maximumFractionDigits: 4 }) : value.toPrecision(3)) + " $";
const pctText = value => `${value >= 0 ? "+" : "−"}${Math.abs(value * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`;
state.plan = null;

function currentPlan() {
  const token = currentToken();
  return buildTradePlan(chartCandles, { price: token.price, signal: token.signal, costPct: 0.03 });
}

function renderPlan() {
  const panel = document.querySelector("#plan-panel");
  if (coinModal.hidden || !panel) return;
  const token = currentToken();
  const plan = currentPlan();
  state.plan = plan;
  const [label, tone] = PLAN_BADGE[plan.state] ?? PLAN_BADGE.unknown;
  const badge = document.querySelector("#plan-badge");
  badge.textContent = plan.label ?? label;
  badge.className = `plan-badge ${tone}`;
  const body = document.querySelector("#plan-body");
  const apply = document.querySelector("#plan-apply");
  apply.disabled = !plan.stop;

  let html = "";
  if (plan.entry) {
    const entryText = plan.state === "buy" ? `maintenant (${planMoney(plan.entry.low)} – ${planMoney(plan.entry.high)})` : plan.state === "breakout" ? `au-dessus de ${planMoney(plan.entry.low)}` : `ordre limite ${planMoney(plan.entry.low)} – ${planMoney(plan.entry.high)}`;
    html += `<dl class="plan-levels">
      <div><dt>Entrée</dt><dd>${entryText}</dd></div>
      <div><dt>Stop-loss</dt><dd class="negative">${planMoney(plan.stop.price)} <small>(${pctText(-plan.stop.pct)})</small></dd></div>
      <div><dt>Cible 1</dt><dd class="positive">${planMoney(plan.targets[0].price)} <small>(${pctText(plan.targets[0].pct)} · R ${plan.targets[0].rr.toFixed(1)})</small></dd></div>
      <div><dt>Cible 2</dt><dd class="positive">${planMoney(plan.targets[1].price)} <small>(${pctText(plan.targets[1].pct)} · R ${plan.targets[1].rr.toFixed(1)})</small></dd></div>
      <div><dt>Ratio net de frais</dt><dd>${plan.netRr.toFixed(2)} <small>· volatilité ${pctText(plan.atrPct).replace("+", "")}/bougie</small></dd></div>
    </dl>`;
  }
  html += `<ul class="plan-notes">${plan.notes.map(note => `<li>${esc(note)}</li>`).join("")}</ul>`;
  const position = state.positions.find(item => item.tokenId === token.id);
  const advice = position && plan.stop ? exitAdvice(plan, position, token.price) : null;
  if (advice) html += `<p class="plan-advice ${esc(advice.action)}"><strong>Ta position :</strong> ${esc(advice.text)}</p>`;
  body.innerHTML = html;

  if (coinChart && document.querySelector("#plan-lines").checked && plan.entry) {
    coinChart.setPlanLines([
      { price: plan.entry.price, title: plan.state === "buy" ? "Entrée" : "Zone", color: "#60a5fa" },
      { price: plan.stop.price, title: "SL", color: "#f87171" },
      { price: plan.targets[0].price, title: "TP1", color: "#4ade80" },
      { price: plan.targets[1].price, title: "TP2", color: "#86efac" }
    ]);
  } else coinChart?.setPlanLines([]);
  renderVerdict();
}

document.querySelector("#plan-apply").addEventListener("click", () => {
  const percents = planPercents(state.plan);
  if (!percents) return;
  document.querySelector("#stop-loss").value = percents.stopLossPct;
  document.querySelector("#take-profit").value = percents.takeProfitPct;
  showToast(`Stop-loss −${percents.stopLossPct} % et take-profit +${percents.takeProfitPct} % appliqués (frais inclus).`);
});
document.querySelector("#plan-lines").addEventListener("change", renderPlan);

/* Background plans for qualified coins: chips on the signal cards and a notification when a good entry appears. */
const PLAN_TTL_MS = 90_000;
const ENTRY_COOLDOWN_MS = 30 * 60_000;
const lastEntryAlert = new Map();

function planChip(token) {
  const entry = planCache.get(token.id);
  if (!entry) return '<span class="plan-chip neutral">plan…</span>';
  const plan = entry.plan;
  const [label, tone] = PLAN_BADGE[plan.state] ?? PLAN_BADGE.unknown;
  const detail = plan.stop ? ` · SL −${Math.round(plan.stop.pct * 100)} % · TP +${Math.round(plan.targets[0].pct * 100)} %` : "";
  return `<span class="plan-chip ${tone}">${esc(plan.label ?? label)}${detail}</span>`;
}

async function refreshPlans() {
  if (document.hidden || state.market.loading || !state.market.live) return;
  const targets = tokens.filter(isQualified).filter(token => token.pairAddress).slice(0, 8);
  for (const token of targets) {
    const cached = planCache.get(token.id);
    if (cached && Date.now() - cached.at < PLAN_TTL_MS) continue;
    try {
      const response = await fetch(`/api/chart?pool=${encodeURIComponent(token.pairAddress)}&tf=5m`, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const { candles } = await response.json();
      const plan = buildTradePlan(candles, { price: token.price, signal: token.signal });
      const previous = cached?.plan?.state;
      planCache.set(token.id, { at: Date.now(), plan });
      document.querySelectorAll(`[data-plan-chip="${CSS.escape(token.id)}"]`).forEach(node => { node.innerHTML = planChip(token); });
      if (plan.state === "buy" && previous && previous !== "buy" && notifState.qualified && Date.now() - (lastEntryAlert.get(token.id) ?? 0) > ENTRY_COOLDOWN_MS) {
        lastEntryAlert.set(token.id, Date.now());
        notify({
          type: "entry", tokenId: token.id, title: `Bon point d'entrée · $${token.symbol}`,
          body: `Entrée ~${planMoney(plan.entry.price)} · SL ${planMoney(plan.stop.price)} (−${Math.round(plan.stop.pct * 100)} %) · TP1 ${planMoney(plan.targets[0].price)} (+${Math.round(plan.targets[0].pct * 100)} %)`
        });
      }
    } catch { /* plans are optional */ }
    await new Promise(resolve => setTimeout(resolve, 600));
  }
}
setTimeout(refreshPlans, 6_000);
setInterval(refreshPlans, 45_000);

/* ---- Followed pump.fun traders: buy/sell alerts and activity feed ---- */
const FOLLOW_LIMIT = 20;
const FOLLOW_POLL_MS = 30_000;
const FEED_LIMIT = 80;

function loadFollowState() {
  try {
    const saved = JSON.parse(localStorage.getItem("pulse-follows") || "null");
    return {
      list: Array.isArray(saved?.list) ? saved.list.filter(item => BASE58.test(item?.wallet ?? "")).slice(0, FOLLOW_LIMIT) : [],
      seen: Array.isArray(saved?.seen) ? saved.seen.slice(-400) : [],
      feed: Array.isArray(saved?.feed) ? saved.feed.slice(0, FEED_LIMIT) : []
    };
  } catch {
    return { list: [], seen: [], feed: [] };
  }
}
const followState = loadFollowState();
const seenTrades = new Set(followState.seen);

function saveFollowState() {
  followState.seen = [...seenTrades].slice(-400);
  try { localStorage.setItem("pulse-follows", JSON.stringify(followState)); } catch { /* storage unavailable */ }
}

function isFollowed(wallet) { return followState.list.some(item => item.wallet === wallet); }

function updateFollowCount() {
  document.querySelector("#follow-count").textContent = followState.list.length;
}

function profileAvatar(trader) {
  return trader.profileImage
    ? `<span class="standing-avatar"><img src="${esc(trader.profileImage)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`
    : `<span class="standing-avatar">${esc(String(trader.username ?? "?").slice(0, 2).toUpperCase())}</span>`;
}

function followTrader(trader) {
  if (isFollowed(trader.wallet)) return false;
  if (followState.list.length >= FOLLOW_LIMIT) { showToast(`Limite de ${FOLLOW_LIMIT} traders suivis atteinte.`); return false; }
  followState.list.push({ wallet: trader.wallet, username: trader.username, profileImage: trader.profileImage ?? null, since: Date.now() });
  saveFollowState();
  updateFollowCount();
  showToast(`Tu suis maintenant ${trader.username}.`);
  renderFollows();
  pollFollows();
  return true;
}

function unfollowTrader(wallet) {
  const trader = followState.list.find(item => item.wallet === wallet);
  followState.list = followState.list.filter(item => item.wallet !== wallet);
  followState.feed = followState.feed.filter(item => item.wallet !== wallet);
  saveFollowState();
  updateFollowCount();
  renderFollows();
  if (trader) showToast(`${trader.username} retiré de ta liste.`);
}

const tradeMoney = value => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function tradeLabel(trade) {
  return trade.name ?? trade.symbol ?? `${trade.mint.slice(0, 4)}…${trade.mint.slice(-4)}`;
}

function renderFollows() {
  updateFollowCount();
  const list = document.querySelector("#followed-list");
  if (!list) return;
  list.innerHTML = followState.list.length
    ? followState.list.map(trader => `<div class="followed-row">${profileAvatar(trader)}<span class="standing-name"><strong>${esc(trader.username)}</strong><small>${esc(shortAddress(trader.wallet))}</small></span><button class="wallet-row-action danger" type="button" data-unfollow="${esc(trader.wallet)}">Ne plus suivre</button></div>`).join("")
    : '<div class="positions-empty">Aucun trader suivi. Ajoute un pseudo pump.fun ci-dessus ou clique sur « + Suivre » dans les classements.</div>';
  const feed = document.querySelector("#activity-feed");
  feed.innerHTML = followState.feed.length
    ? followState.feed.map(trade => {
      const trader = followState.list.find(item => item.wallet === trade.wallet);
      return `<button class="activity-row ${trade.isBuy ? "buy" : "sell"}" type="button" data-trade-mint="${esc(trade.mint)}">
        <span class="activity-side">${trade.isBuy ? "ACHAT" : "VENTE"}</span>
        <span class="activity-main"><strong>${esc(trader?.username ?? shortAddress(trade.wallet))}</strong> ${trade.isBuy ? "a acheté" : "a vendu"} <strong>${tradeMoney(trade.amountUsd)}</strong> de <strong>${esc(tradeLabel(trade))}</strong>${trade.symbol ? ` <small>$${esc(trade.symbol)}</small>` : ""}</span>
        <span class="activity-meta">${trade.marketCapAtTrade ? `@ ${formatMarketMoney(trade.marketCapAtTrade)} MC` : ""}<small>${timeAgo(trade.timestamp)}</small></span>
      </button>`;
    }).join("")
    : '<div class="positions-empty">Pas encore d’activité. Les achats et ventes des traders suivis apparaîtront ici.</div>';
}

let followPolling = false;
async function pollFollows() {
  if (followPolling || !followState.list.length || window.location.protocol === "file:") return;
  followPolling = true;
  try {
    const response = await fetch(`/api/traders/trades?wallets=${followState.list.map(item => item.wallet).join(",")}`, { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const { trades } = await response.json();
    const fresh = [];
    for (const trade of [...trades].sort((first, second) => first.timestamp - second.timestamp)) {
      const trader = followState.list.find(item => item.wallet === trade.wallet);
      if (!trader || seenTrades.has(trade.tx)) continue;
      seenTrades.add(trade.tx);
      fresh.push(trade);
      followState.feed.unshift(trade);
      if (trade.timestamp > trader.since && notifState.traders && trade.amountUsd >= notifState.minTrade) {
        notify({
          type: "trader", tokenId: trade.mint,
          title: `${trader.username} ${trade.isBuy ? "a acheté" : "a vendu"} ${tradeMoney(trade.amountUsd)}`,
          body: `${tradeLabel(trade)}${trade.marketCapAtTrade ? ` @ ${formatMarketMoney(trade.marketCapAtTrade)} MC` : ""}`
        });
      }
    }
    if (fresh.length) {
      followState.feed = followState.feed.sort((first, second) => second.timestamp - first.timestamp).slice(0, FEED_LIMIT);
      saveFollowState();
      if (!document.querySelector("#follows-panel").hidden) renderFollows();
    }
  } catch { /* the next poll retries */ } finally {
    followPolling = false;
  }
}

/** Opens a token by mint: from the list when present, otherwise looked up on DEX Screener and pinned to "perso". */
async function openTokenById(mint) {
  if (tokens.some(token => token.id === mint)) { openCoin(mint); return; }
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(mint)}`, { headers: { accept: "application/json" } });
    const { tokens: found } = await response.json();
    const token = found?.find(item => item.id === mint);
    if (!token) { showToast("Token introuvable sur DexScreener."); return; }
    // Opened from a feed or a notification: viewable and tradable, but not pinned to the scanner list.
    state.adhoc.set(token.id, { ...token, movement: {} });
    openCoin(token.id);
  } catch {
    showToast("Impossible d’ouvrir ce token pour le moment.");
  }
}

document.querySelector("#follow-form").addEventListener("submit", async event => {
  event.preventDefault();
  const input = document.querySelector("#follow-input");
  const query = input.value.trim();
  if (!query) return;
  try {
    const response = await fetch(`/api/traders/resolve?q=${encodeURIComponent(query)}`, { headers: { accept: "application/json" } });
    if (response.status === 404) { showToast("Trader introuvable sur pump.fun."); return; }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const trader = await response.json();
    if (isFollowed(trader.wallet)) { showToast(`Tu suis déjà ${trader.username}.`); return; }
    if (followTrader(trader)) input.value = "";
  } catch {
    showToast("Recherche impossible pour le moment.");
  }
});
document.querySelector("#followed-list").addEventListener("click", event => {
  const button = event.target.closest("[data-unfollow]");
  if (button) unfollowTrader(button.dataset.unfollow);
});
document.querySelector("#activity-feed").addEventListener("click", event => {
  const row = event.target.closest("[data-trade-mint]");
  if (row) openTokenById(row.dataset.tradeMint);
});
function handleFollowButton(event) {
  const button = event.target.closest("[data-follow]");
  if (!button || (event.type === "keydown" && event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  event.stopPropagation();
  const wallet = button.dataset.follow;
  if (isFollowed(wallet)) unfollowTrader(wallet);
  else followTrader({ wallet, username: button.dataset.name, profileImage: button.dataset.image || null });
  const on = isFollowed(wallet);
  button.classList.toggle("on", on);
  button.textContent = on ? "Suivi ✓" : "+ Suivre";
}
document.querySelector("#standings-table").addEventListener("click", handleFollowButton);
document.querySelector("#standings-table").addEventListener("keydown", handleFollowButton);

updateFollowCount();
setTimeout(pollFollows, 4_000);
setInterval(pollFollows, FOLLOW_POLL_MS);

/* ---- Early starts: alert when a coin begins its move ---- */
let knownEarly = null;

function detectNewEarly() {
  const current = new Set(tokens.filter(token => token.early?.early).map(token => token.id));
  if (knownEarly && notifState.early) {
    const now = Date.now();
    for (const token of tokens) {
      if (!current.has(token.id) || knownEarly.has(token.id)) continue;
      if (now - (notifState.lastQualified[`early:${token.id}`] ?? 0) < QUALIFIED_COOLDOWN_MS) continue;
      notifState.lastQualified[`early:${token.id}`] = now;
      notify({
        type: "early", tokenId: token.id,
        title: `Démarrage détecté · $${token.symbol}`,
        body: `+${Math.round(token.change)} % sur 1 h · volume ×${token.early.acceleration.toFixed(1)} · MCAP ${formatMarketMoney(token.marketCap)} · liquidité ${formatMarketMoney(token.liquidity)}`
      });
    }
    saveNotifState();
  }
  knownEarly = current;
}

document.querySelector("#quality-filter").checked = state.qualityFilter;
document.querySelector("#quality-filter").addEventListener("change", event => {
  state.qualityFilter = event.target.checked;
  try { localStorage.setItem("pulse-quality-filter", state.qualityFilter ? "1" : "0"); } catch { /* storage unavailable */ }
  renderTable();
});

/* ---- Fee preset selector ---- */
renderPresetTable();
document.querySelector("#preset-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-preset]");
  if (!button) return;
  state.feeMode = button.dataset.preset;
  try { localStorage.setItem("pulse-fee-mode", state.feeMode); } catch { /* storage unavailable */ }
  renderTradeQuote();
});

/* ---- New pump.fun coins filtered with the Pulse filter ---- */
function loadNewChips() {
  try { const saved = JSON.parse(localStorage.getItem("pulse-new-chips") || "null"); return { mc: Number.isFinite(saved?.mc) ? saved.mc : 5500, vol: Number.isFinite(saved?.vol) ? saved.vol : 9000, full: Boolean(saved?.full) }; } catch { return { mc: 5500, vol: 9000, full: false }; }
}
const newChips = loadNewChips();
const newCoins = { tokens: [], loaded: false, known: null };
const passesNewChips = token => (token.marketCap ?? 0) >= newChips.mc && (token.volume24h ?? 0) >= newChips.vol && (!newChips.full || token.quality.passes);

function newCoinRow(token, index) {
  const live = !token.synthetic;
  const missing = token.quality.checks.filter(check => !check.ok);
  const verdict = token.quality.passes
    ? '<span class="new-badge ok">✓ passe</span>'
    : `<span class="new-badge fail" title="${esc(missing.map(check => `${check.label} : ${check.value == null ? "inconnu" : check.unit === "usd" ? formatMarketMoney(check.value) : check.unit === "sol" ? `${check.value.toFixed(2)} SOL` : Math.floor(check.value)}`).join(" · "))}">${esc(missing[0]?.id === "volume24h" && missing[0].value == null ? "volume inconnu" : missing[0]?.label.replace(/ minimum.*/, "") ?? "échoue")}</span>`;
  return `<tr class="token-row new-row ${token.quality.passes ? "qualified" : ""}" data-new="${esc(token.id)}" tabindex="0" aria-label="Voir ${esc(token.name)}">
    <td><div class="token-cell"><span class="token-rank">${index + 1}</span><span class="mini-avatar" style="--accent:#4ade80">${avatarContent(token)}</span><div><strong>${esc(token.name)}</strong><span>$${esc(token.symbol)}${token.pump?.graduated ? ' <em class="tag">gradué</em>' : ' <em class="tag">pump</em>'}${live ? "" : ' <em class="tag custom">pas encore sur DexScreener</em>'}</span></div></div></td>
    <td class="market-cap">${formatMarketMoney(token.marketCap)}</td>
    <td class="ath-cell">${athBar(token)}<span>${formatAthMarketCap(token)}</span></td>
    <td class="token-age">${token.ageMinutes < 60 ? `${token.ageMinutes}m` : formatTokenAge(token)}</td>
    <td>${formatInteger(token.transactions)}</td>
    <td title="${token.volumeEstimated ? "Estimation basse : SOL net déjà dans la courbe de liaison" : ""}">${token.volumeEstimated ? "≥ " : ""}${formatMarketMoney(token.volume24h)}</td>
    <td>${formatMarketMoney(token.liquidity)}</td>
    <td>${changePill(token.change, "")}</td>
    <td>${changePill(token.change6h, "")}</td>
    <td>${verdict}</td></tr>`;
}

function renderNewCoins() {
  const body = document.querySelector("#newcoins-body");
  const rows = newCoins.tokens.filter(passesNewChips);
  body.innerHTML = rows.map(newCoinRow).join("");
  document.querySelector("#newcoins-empty").hidden = rows.length > 0 || !newCoins.loaded;
  document.querySelector("#new-hidden").textContent = newChips.full ? `(${newCoins.tokens.filter(token => !token.quality.passes).length} échouent)` : "";
  document.querySelector("#new-count").textContent = rows.length;
  document.querySelector("#newcoins-status").textContent = `${rows.length} sur ${newCoins.tokens.length} passent${newCoins.updatedAt ? ` · mis à jour ${new Date(newCoins.updatedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : ""}`;
}

function notifyNewCoins(tokens) {
  const passing = new Set(tokens.filter(passesNewChips).map(token => token.id));
  if (newCoins.known && notifState.newCoins) {
    for (const token of tokens) {
      if (!passing.has(token.id) || newCoins.known.has(token.id)) continue;
      notify({ type: "newcoin", tokenId: token.id, title: `Nouveau coin · $${token.symbol}`, body: `${token.ageMinutes} min · MCAP ${formatMarketMoney(token.marketCap)} · volume ${formatMarketMoney(token.volume24h)} · liquidité ${formatMarketMoney(token.liquidity)}` });
    }
  }
  newCoins.known = passing;
}

async function loadNewCoins() {
  const status = document.querySelector("#newcoins-status");
  try {
    const response = await fetch("/api/new-coins", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    newCoins.tokens = payload.tokens;
    newCoins.loaded = true;
    newCoins.updatedAt = payload.updatedAt;
    notifyNewCoins(payload.tokens);
    renderNewCoins();
  } catch {
    status.textContent = "indisponible";
  }
}

function saveNewChips() {
  try { localStorage.setItem("pulse-new-chips", JSON.stringify(newChips)); } catch { /* storage unavailable */ }
}
document.querySelector("#new-min-mc").value = newChips.mc;
document.querySelector("#new-min-vol").value = newChips.vol;
document.querySelector("#new-filter").checked = newChips.full;
for (const [id, key] of [["#new-min-mc", "mc"], ["#new-min-vol", "vol"]]) {
  document.querySelector(id).addEventListener("input", event => { newChips[key] = Math.max(Number(event.target.value) || 0, 0); saveNewChips(); renderNewCoins(); });
}
document.querySelector("#new-filter").addEventListener("change", event => { newChips.full = event.target.checked; saveNewChips(); renderNewCoins(); });
document.querySelector("#new-refresh").addEventListener("click", loadNewCoins);
function openNewCoin(row) {
  const token = row && newCoins.tokens.find(item => item.id === row.dataset.new);
  if (!token) return;
  if (token.synthetic) { window.open(token.pumpUrl, "_blank", "noopener,noreferrer"); return; }
  openTokenById(token.id);
}
document.querySelector("#newcoins-body").addEventListener("click", event => openNewCoin(event.target.closest("[data-new]")));
document.querySelector("#newcoins-body").addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openNewCoin(event.target.closest("[data-new]")); } });
setTimeout(loadNewCoins, 2_500);
setInterval(() => { if (document.querySelector("#newcoins-view").hidden) loadNewCoins(); }, 30_000);

document.querySelector("#coin-tabs").addEventListener("click", event => {
  const button = event.target.closest("[data-ctab]");
  if (button) setCoinTab(button.dataset.ctab);
});
setCoinTab(["plan", "security", "signal", "news"].includes(state.coinTab) ? state.coinTab : "plan");

/* ---- History page: closed trades vs where the coin is now ---- */
const REASON_TEXT = { "stop-loss": "Stop-loss", "take-profit": "Take-profit", manual: "Manuel" };

function sinceExit(trade) {
  const status = historyPage.status.get(trade.tokenId);
  return status?.price > 0 && trade.exitPrice > 0 ? status.price / trade.exitPrice - 1 : null;
}

function historyMatches(trade) {
  const status = historyPage.status.get(trade.tokenId);
  switch (historyPage.filter) {
    case "win": return trade.pnl > 0;
    case "loss": return trade.pnl < 0;
    case "valid": return status?.quality.passes === true;
    case "up": return (sinceExit(trade) ?? -1) > 0;
    default: return true;
  }
}

function historyRow(trade) {
  const status = historyPage.status.get(trade.tokenId);
  const change = sinceExit(trade);
  const avatar = avatarContent({ imageUrl: status?.imageUrl ?? null, initials: String(trade.tokenSymbol ?? "?").slice(0, 2).toUpperCase() });
  const verdict = !status ? '<span class="new-badge neutral">—</span>'
    : status.quality.passes ? '<span class="new-badge ok">✓ passe encore</span>'
      : `<span class="new-badge fail" title="${esc(status.quality.failed.join(" · "))}">✗ ${esc(status.quality.failed[0]?.replace(/ minimum.*/, "") ?? "ne passe plus")}</span>`;
  const sinceCell = change == null ? '<span class="pill neutral">—</span>'
    : `<span class="pill ${change >= 0 ? "up" : "down"}">${change >= 0 ? "↑" : "↓"} ${Math.abs(change * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %</span><small class="since-note">${change >= 0 ? "a continué de monter" : "a baissé depuis"}</small>`;
  const held = Number.isFinite(trade.openedAt) ? formatDuration(trade.closedAt - trade.openedAt) : "—";
  return `<tr class="token-row history-row-tr" data-history-token="${esc(trade.tokenId)}" tabindex="0">
    <td><div class="token-cell"><span class="mini-avatar" style="--accent:#8b9699">${avatar}</span><div><strong>${esc(trade.tokenName ?? trade.tokenSymbol)}</strong><span>$${esc(trade.tokenSymbol)}${trade.fraction < 0.999 ? ` · vente ${Math.round(trade.fraction * 100)} %` : ""}</span></div></div></td>
    <td><span class="cell-main">${new Date(trade.closedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span><small class="since-note">${esc(REASON_TEXT[trade.reason] ?? "Manuel")} · détenu ${held}</small></td>
    <td>${formatPrice(trade.entryPrice)}</td>
    <td>${formatPrice(trade.exitPrice)}</td>
    <td><span class="cell-main ${trade.pnl >= 0 ? "positive" : "negative"}">${signedMoney(trade.pnl)}</span><small class="since-note ${trade.pnl >= 0 ? "positive" : "negative"}">${signed(trade.pnlPct)}</small></td>
    <td>${status?.price > 0 ? formatPrice(status.price) : "—"}</td>
    <td class="since-cell">${sinceCell}</td>
    <td><span class="cell-main">${status?.liquidity > 0 ? formatMarketMoney(status.liquidity) : "—"}</span>${trade.exitLiquidity > 0 ? `<small class="since-note">à la sortie ${formatMarketMoney(trade.exitLiquidity)}</small>` : ""}</td>
    <td>${verdict}</td></tr>`;
}

function renderHistoryPage() {
  updateHistoryCount();
  const trades = state.history.filter(historyMatches);
  document.querySelector("#history-body").innerHTML = trades.map(historyRow).join("");
  document.querySelector("#history-empty").hidden = trades.length > 0;
  const stats = tradeStats(state.history);
  const changes = state.history.map(sinceExit).filter(value => value != null);
  const average = changes.length ? changes.reduce((total, value) => total + value, 0) / changes.length : null;
  const valid = state.history.filter(trade => historyPage.status.get(trade.tokenId)?.quality.passes).length;
  document.querySelector("#history-summary").innerHTML = [
    ["Trades clôturés", formatInteger(stats.count), "", `${stats.wins} gagnants · ${stats.losses} perdants`],
    ["P&L réalisé", signedMoney(stats.realized), tone(stats.realized), stats.winRate == null ? "" : `réussite ${Math.round(stats.winRate * 100)} %`],
    ["Depuis tes sorties (moyenne)", average == null ? "—" : `${average >= 0 ? "+" : "−"}${Math.abs(average * 100).toLocaleString(locale, { maximumFractionDigits: 1 })} %`, tone(average ?? 0), average == null ? "prix en chargement" : average >= 0 ? "les coins ont continué de monter" : "les coins ont baissé après ta vente"],
    ["Passent encore le filtre", `${valid} / ${state.history.length}`, "", "Filtre Pulse actuel"]
  ].map(([label, value, valueTone, sub]) => `<article class="kpi"><span>${label}</span><strong class="${valueTone}">${value}</strong><small>${sub}</small></article>`).join("");
  document.querySelector("#history-status").textContent = historyPage.loaded ? "prix actualisés" : "chargement des prix…";
}

async function loadHistoryStatus() {
  const ids = [...new Set(state.history.map(trade => trade.tokenId).filter(id => BASE58.test(id)))].slice(0, 90);
  if (!ids.length) { historyPage.loaded = true; renderHistoryPage(); return; }
  try {
    for (let index = 0; index < ids.length; index += 30) {
      const response = await fetch(`/api/token-status?ids=${ids.slice(index, index + 30).join(",")}`, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      for (const status of (await response.json()).statuses) historyPage.status.set(status.id, status);
    }
    historyPage.loaded = true;
    renderHistoryPage();
  } catch { /* the page keeps its last prices */ }
}

document.querySelector("#history-page-filter").addEventListener("click", event => {
  const button = event.target.closest("[data-pfilter]");
  if (!button) return;
  historyPage.filter = button.dataset.pfilter;
  document.querySelectorAll("#history-page-filter [data-pfilter]").forEach(item => item.classList.toggle("active", item === button));
  renderHistoryPage();
});
function openHistoryTrade(row) { if (row) openTokenById(row.dataset.historyToken); }
document.querySelector("#history-body").addEventListener("click", event => openHistoryTrade(event.target.closest("[data-history-token]")));
document.querySelector("#history-body").addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openHistoryTrade(event.target.closest("[data-history-token]")); } });
document.querySelector("#history-export").addEventListener("click", () => {
  if (!state.history.length) { showToast("Aucun trade à exporter."); return; }
  const head = "date,token,prix_entree,prix_sortie,pnl_usd,pnl_pct,prix_actuel,depuis_sortie_pct,liquidite_actuelle,filtre_pulse,raison";
  const lines = state.history.map(trade => {
    const status = historyPage.status.get(trade.tokenId);
    const change = sinceExit(trade);
    return [new Date(trade.closedAt).toISOString(), trade.tokenSymbol, trade.entryPrice, trade.exitPrice, trade.pnl.toFixed(2), trade.pnlPct.toFixed(2), status?.price ?? "", change == null ? "" : (change * 100).toFixed(2), status?.liquidity ?? "", status ? (status.quality.passes ? "oui" : "non") : "", trade.reason ?? "manual"]
      .map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(",");
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([[head, ...lines].join("\n")], { type: "text/csv" }));
  link.download = "pulse-historique.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
updateHistoryCount();
document.querySelector("#open-history").addEventListener("click", () => showView("history"));

/* ============================================================================
 * Live mode: real orders (Jupiter swaps) signed by the user's own wallet.
 * Pulse never holds keys: it prepares an unsigned transaction, the user checks the summary and signs in the wallet.
 * ========================================================================== */
const SOLSCAN_TX = "https://solscan.io/tx/";
const LIVE_WALLET_REFRESH_MS = 15_000;
const LIVE_QUOTE_VALIDITY_MS = 60_000;

function loadJson(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key) || "null"); return value ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

state.live = {
  portfolio: null, prices: new Map(), positions: 0, loading: false, busy: false, alerted: new Set(), serverMax: 5,
  orders: loadJson("pulse-live-orders", []).filter(order => order && typeof order.id === "string").slice(0, 100),
  limits: loadJson("pulse-live-limits", {}),
  cap: Number(localStorage.getItem("pulse-live-cap")) > 0 ? Number(localStorage.getItem("pulse-live-cap")) : 1
};
const liveActive = () => state.mode === "live";
const solText2 = (value, digits = 3) => `${value.toLocaleString(locale, { maximumFractionDigits: digits })} SOL`;

function applyMode() {
  document.body.classList.toggle("mode-live", liveActive());
  document.querySelector("#live-banner").hidden = !liveActive();
  document.querySelectorAll("#mode-switch [data-mode]").forEach(button => button.classList.toggle("active", button.dataset.mode === state.mode));
  document.querySelector("#trade-heading").textContent = liveActive() ? "Trade réel" : "Paper trade";
  document.querySelector("#live-order-cap").value = state.live.cap;
  renderLiveTrade();
  if (liveActive()) refreshLive();
  updateWalletUI();
}

async function setMode(mode) {
  if (mode === state.mode) return;
  if (mode === "live") {
    if (!localStorage.getItem("pulse-live-ack")) { document.querySelector("#live-ack").checked = false; document.querySelector("#live-risk-accept").disabled = true; document.querySelector("#live-risk-modal").hidden = false; return; }
    if (!activeWallet()) { showToast("Connecte d'abord un wallet pour passer en mode LIVE."); document.querySelector("#wallet-button").click(); return; }
    try {
      const config = await (await fetch("/api/live/config", { headers: { accept: "application/json" } })).json();
      if (!config.enabled) { showToast("Le trading live est désactivé sur ce serveur."); return; }
      state.live.serverMax = config.maxOrderSol;
    } catch { showToast("Impossible de vérifier le service de trading."); return; }
  }
  state.mode = mode;
  try { localStorage.setItem("pulse-mode", mode); } catch { /* storage unavailable */ }
  applyMode();
  if (mode === "live" && bot.config.enabled) { bot.config.enabled = false; bot.pending = []; botLog("Bot désactivé : passage en mode LIVE."); saveBot(); }
  renderBot();
  showToast(mode === "live" ? "Mode LIVE activé : les ordres sont réels." : "Mode TEST : portefeuille de simulation.");
}

document.querySelector("#mode-switch").addEventListener("click", event => { const button = event.target.closest("[data-mode]"); if (button) setMode(button.dataset.mode); });
document.querySelector("#live-ack").addEventListener("change", event => { document.querySelector("#live-risk-accept").disabled = !event.target.checked; });
document.querySelectorAll("[data-close-live-risk]").forEach(button => button.addEventListener("click", () => { document.querySelector("#live-risk-modal").hidden = true; }));
document.querySelector("#live-risk-accept").addEventListener("click", () => {
  try { localStorage.setItem("pulse-live-ack", String(Date.now())); } catch { /* storage unavailable */ }
  document.querySelector("#live-risk-modal").hidden = true;
  setMode("live");
});

/* ---- Signing: Wallet Standard (Phantom, Solflare, Backpack…) or WalletConnect ---- */
async function signAndSend(wallet, transactionBase64) {
  if (wallet.id === "walletconnect") {
    if (!walletConnect.client) throw new Error("La session WalletConnect n'est plus active : reconnecte ton wallet.");
    return walletConnect.client.signAndSend(transactionBase64);
  }
  const standard = wallet.standardWallet;
  const feature = standard?.features?.["solana:signAndSendTransaction"];
  if (!feature) throw new Error("Ce wallet ne permet pas de signer depuis Pulse. Utilise Phantom, Solflare ou Backpack.");
  let account = standard.accounts?.find(item => item.address === wallet.address);
  if (!account) {
    const connected = await standard.features["standard:connect"].connect();
    account = connected?.accounts?.find(item => item.address === wallet.address) ?? standard.accounts?.find(item => item.address === wallet.address);
  }
  if (!account) throw new Error("Le compte actif du wallet ne correspond pas à l'adresse connectée dans Pulse.");
  const [result] = await feature.signAndSendTransaction({ account, chain: "solana:mainnet", transaction: base64ToBytes(transactionBase64) });
  return base58Encode(result.signature);
}

/* ---- Trade box (live) ---- */
function liveBuyContext() {
  const amount = Number(document.querySelector("#live-amount").value);
  const preset = activePreset((Number.isFinite(amount) ? amount : 0) * currentSolUsd());
  return { amount, preset, solUsd: currentSolUsd() };
}

function renderLiveTrade() {
  if (!liveActive()) return;
  const wallet = activeWallet();
  const { amount, preset, solUsd } = liveBuyContext();
  document.querySelector("#live-trade-wallet").textContent = wallet ? `${shortAddress(wallet.address)} · ${wallet.balance == null ? "…" : solText2(wallet.balance)}` : "aucun wallet";
  document.querySelector("#live-hint").innerHTML = `${Number.isFinite(amount) && amount > 0 ? `≈ ${formatMoney(amount * solUsd, 0)} · ` : ""}preset <strong style="color:${preset.accent}">${esc(preset.label)}</strong> : frais de priorité ${solText2(orderPrioritySol(preset), 4)} (priorité + tip), slippage max ${preset.slippageBuyPct} % achat / ${preset.slippageSellPct} % vente.`;
  const button = document.querySelector("#live-buy");
  button.disabled = !wallet || state.live.busy || !(currentToken()?.id && BASE58.test(currentToken().id));
  button.textContent = state.live.busy ? "Préparation…" : wallet ? "Acheter avec mon wallet" : "Connecte un wallet";
}
document.querySelector("#live-amount").addEventListener("input", renderLiveTrade);
document.querySelectorAll("[data-live-amount]").forEach(button => button.addEventListener("click", () => { document.querySelector("#live-amount").value = button.dataset.liveAmount; renderLiveTrade(); }));
document.querySelector("#live-order-cap").addEventListener("change", event => {
  const value = Math.min(Math.max(Number(event.target.value) || 0.1, 0.01), state.live.serverMax);
  state.live.cap = value;
  event.target.value = value;
  try { localStorage.setItem("pulse-live-cap", String(value)); } catch { /* storage unavailable */ }
});

/* ---- Prepare -> confirm -> sign ---- */
async function prepareOrder(body) {
  const response = await fetch("/api/live/prepare", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? "Impossible de préparer l'ordre.");
  return payload;
}

function tokenMeta(mint) {
  const token = tokens.find(item => item.id === mint) ?? state.adhoc.get(mint) ?? state.held.get(mint) ?? state.live.prices.get(mint);
  return { symbol: token?.symbol ?? mint.slice(0, 4), name: token?.name ?? token?.symbol ?? mint.slice(0, 4), decimals: state.security.get(mint)?.authorities?.decimals ?? state.live.portfolio?.tokens.find(item => item.mint === mint)?.decimals ?? 6 };
}

async function startLiveBuy() {
  const wallet = activeWallet();
  const token = currentToken();
  const { amount, preset } = liveBuyContext();
  if (!wallet || !token || !BASE58.test(token.id)) return;
  if (!(amount > 0)) return showToast("Entre un montant en SOL.");
  if (amount > state.live.cap) return showToast(`Montant supérieur à ta limite par ordre (${state.live.cap} SOL). Modifie-la dans le panneau si tu veux.`);
  await runPreparedOrder({ side: "buy", mint: token.id, userPublicKey: wallet.address, amountSol: amount, slippageBps: preset.slippageBuyPct * 100, prioritySol: orderPrioritySol(preset) }, tokenMeta(token.id));
}

async function startLiveSell(mint, fraction) {
  const wallet = activeWallet();
  const holding = state.live.portfolio?.tokens.find(item => item.mint === mint);
  if (!wallet || !holding) return;
  const raw = rawFraction(holding.raw, fraction);
  if (BigInt(raw) <= 0n) return showToast("Quantité trop faible pour cette vente.");
  const price = state.live.prices.get(mint)?.price ?? 0;
  const preset = activePreset(rawToUi(raw, holding.decimals) * price);
  await runPreparedOrder({ side: "sell", mint, userPublicKey: wallet.address, amountRaw: raw, slippageBps: preset.slippageSellPct * 100, prioritySol: orderPrioritySol(preset) }, { ...tokenMeta(mint), decimals: holding.decimals });
}

async function runPreparedOrder(body, meta) {
  if (state.live.busy) return;
  state.live.busy = true;
  renderLiveTrade();
  try {
    const prepared = await prepareOrder(body);
    openConfirm(prepared, body, meta);
  } catch (error) {
    showToast(error.message);
  } finally {
    state.live.busy = false;
    renderLiveTrade();
  }
}

let confirmTimer = null;
function closeConfirm() { document.querySelector("#live-confirm-modal").hidden = true; clearInterval(confirmTimer); }
document.querySelectorAll("[data-close-live-confirm]").forEach(button => button.addEventListener("click", closeConfirm));

function openConfirm(prepared, body, meta) {
  const details = describeOrder(prepared.summary, { decimals: meta.decimals, symbol: meta.symbol, solUsd: currentSolUsd() });
  const fmt = value => value.toLocaleString(locale, { maximumFractionDigits: value >= 100 ? 0 : 4 });
  const buy = body.side === "buy";
  const wallet = activeWallet();
  document.querySelector("#live-confirm-title").textContent = details.title;
  document.querySelector("#live-confirm-body").innerHTML = `
    <div class="order-lines">
      <div><span>${buy ? "Tu paies" : "Tu vends"}</span><strong>${fmt(details.pay.amount)} ${esc(details.pay.unit)}${details.pay.usd ? ` <small>≈ ${formatMoney(details.pay.usd, 2)}</small>` : ""}</strong></div>
      <div><span>Tu reçois (estimation)</span><strong>${fmt(details.receive.amount)} ${esc(details.receive.unit)}${details.receive.usd ? ` <small>≈ ${formatMoney(details.receive.usd, 2)}</small>` : ""}</strong></div>
      <div><span>Minimum garanti</span><strong>${fmt(details.receive.min)} ${esc(details.receive.unit)}</strong></div>
      <div><span>Impact de prix</span><strong class="${(details.priceImpactPct ?? 0) > 5 ? "negative" : ""}">${details.priceImpactPct == null ? "—" : `${details.priceImpactPct.toFixed(2)} %`}</strong></div>
      <div><span>Slippage maximum</span><strong>${details.slippagePct} %</strong></div>
      <div><span>Frais de priorité</span><strong>${solText2(details.priorityFeeSol, 4)}</strong></div>
      ${details.platformFee ? `<div><span>Frais Pulse (${details.platformFee.pct.toLocaleString(locale)} %)</span><strong>${solText2(details.platformFee.sol, 5)}${details.platformFee.usd ? ` <small>≈ ${formatMoney(details.platformFee.usd, 2)}</small>` : ""}</strong></div>` : ""}
      <div><span>Route</span><strong>${esc(details.routes.join(" → ") || "—")}</strong></div>
      <div><span>Wallet</span><strong>${esc(wallet.name)} · ${esc(shortAddress(wallet.address))}</strong></div>
    </div>
    ${details.warnings.map(warning => `<p class="order-warning">⚠ ${esc(warning)}</p>`).join("")}
    <p class="order-note">Ordre valable <b id="order-countdown">60</b> s. Le montant exact dépend du prix au moment où ta transaction est exécutée ; les frais réseau sont non remboursables.</p>
    <div class="order-actions"><button class="gate-secondary" id="order-cancel" type="button">Annuler</button><button class="gate-submit ${buy ? "" : "sell"}" id="order-sign" type="button" ${details.blocking ? "disabled" : ""}>Signer dans mon wallet</button></div>`;
  document.querySelector("#live-confirm-modal").hidden = false;
  const expiresAt = prepared.summary.preparedAt + LIVE_QUOTE_VALIDITY_MS;
  clearInterval(confirmTimer);
  const countdown = () => {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const node = document.querySelector("#order-countdown");
    if (node) node.textContent = left;
    if (left === 0) { clearInterval(confirmTimer); const sign = document.querySelector("#order-sign"); if (sign) { sign.disabled = true; sign.textContent = "Ordre expiré : recommence"; } }
  };
  confirmTimer = setInterval(countdown, 1000);
  document.querySelector("#order-cancel").addEventListener("click", closeConfirm);
  document.querySelector("#order-sign").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Confirme dans ton wallet…";
    try {
      const signature = await signAndSend(wallet, prepared.transaction);
      recordOrder(signature, prepared, body, meta, wallet);
      closeConfirm();
      showToast("Ordre envoyé : en attente de confirmation sur la blockchain.");
    } catch (error) {
      button.disabled = false;
      button.textContent = "Signer dans mon wallet";
      const rejected = /reject|denied|declin|cancel|4001/i.test(`${error?.message} ${error?.code}`);
      showToast(rejected ? "Signature refusée dans le wallet : aucun ordre envoyé." : (error.message || "Échec de la signature."));
    }
  });
}

function recordOrder(signature, prepared, body, meta, wallet) {
  const { summary } = prepared;
  const buy = body.side === "buy";
  const order = {
    id: signature, wallet: wallet.address, side: body.side, mint: body.mint, symbol: meta.symbol, name: meta.name, decimals: meta.decimals, ts: Date.now(), state: "pending",
    solLamports: buy ? summary.inAmount : summary.outAmount, outRaw: buy ? summary.outAmount : null, inRaw: buy ? null : summary.inAmount, impact: summary.priceImpactPct,
    feeId: summary.orderId ?? null
  };
  state.live.orders = upsertOrder(state.live.orders, order);
  saveJson("pulse-live-orders", state.live.orders);
  renderLive();
  trackOrder(signature);
}

async function trackOrder(signature, attempt = 0) {
  const order = state.live.orders.find(item => item.id === signature);
  if (!order || order.state === "confirmed" || order.state === "finalized" || order.state === "failed") return;
  try {
    const response = await fetch(`/api/live/status?signature=${encodeURIComponent(signature)}${order.feeId ? `&order=${encodeURIComponent(order.feeId)}` : ""}`, { headers: { accept: "application/json" } });
    const { state: next, error } = response.ok ? await response.json() : { state: "pending" };
    if (next !== "pending") {
      order.state = next;
      order.error = error ?? null;
      saveJson("pulse-live-orders", state.live.orders);
      notify({ type: next === "failed" ? "stop-loss" : "take-profit", tokenId: order.mint, title: next === "failed" ? `Ordre échoué · $${order.symbol}` : `Ordre confirmé · $${order.symbol}`, body: next === "failed" ? `La transaction a échoué sur la blockchain${error ? ` (${error})` : ""}.` : `${order.side === "buy" ? "Achat" : "Vente"} exécuté.` });
      renderLive();
      refreshLive();
      return;
    }
  } catch { /* retry */ }
  if (attempt < 50) setTimeout(() => trackOrder(signature, attempt + 1), 3_000);
  else { order.state = "expired"; saveJson("pulse-live-orders", state.live.orders); renderLive(); }
}

document.querySelector("#live-buy").addEventListener("click", startLiveBuy);

/* ---- Live dashboard ---- */
async function refreshLive() {
  if (!liveActive() || state.live.loading) return;
  const wallet = activeWallet();
  if (!wallet) { state.live.portfolio = null; renderLive(); return; }
  state.live.loading = true;
  try {
    const response = await fetch(`/api/live/portfolio?owner=${encodeURIComponent(wallet.address)}`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const portfolio = await response.json();
    wallet.balance = portfolio.sol;
    const mints = portfolio.tokens.map(token => token.mint);
    for (let index = 0; index < mints.length; index += 30) {
      const prices = await fetch(`/api/token-status?ids=${mints.slice(index, index + 30).join(",")}`, { headers: { accept: "application/json" } });
      if (prices.ok) for (const status of (await prices.json()).statuses) state.live.prices.set(status.id, status);
    }
    state.live.portfolio = portfolio;
    state.live.positions = portfolio.tokens.length;
    checkLiveLimits();
  } catch (error) {
    console.warn("Live portfolio unavailable", error);
  } finally {
    state.live.loading = false;
    renderLive();
  }
}

function liveHoldings() {
  const wallet = activeWallet();
  const book = costBasis(state.live.orders.filter(order => order.wallet === wallet?.address));
  const solUsd = currentSolUsd();
  return (state.live.portfolio?.tokens ?? []).map(token => {
    const status = state.live.prices.get(token.mint);
    const cost = book.get(token.mint);
    const value = livePositionValue({ raw: token.raw, decimals: token.decimals, priceUsd: status?.price, solUsd, costSol: cost?.costSol });
    return { ...token, status, cost, value, limits: state.live.limits[token.mint] ?? null, breach: limitBreach(value.pnlPct, state.live.limits[token.mint]) };
  }).sort((first, second) => (second.value.valueUsd ?? 0) - (first.value.valueUsd ?? 0));
}

function checkLiveLimits() {
  for (const holding of liveHoldings()) {
    const key = holding.mint;
    if (!holding.breach) { state.live.alerted.delete(`${key}:stop-loss`); state.live.alerted.delete(`${key}:take-profit`); continue; }
    const tag = `${key}:${holding.breach}`;
    if (state.live.alerted.has(tag)) continue;
    state.live.alerted.add(tag);
    const symbol = holding.status?.symbol ?? tokenMeta(holding.mint).symbol;
    notify({
      type: holding.breach, tokenId: holding.mint,
      title: `[LIVE] ${holding.breach === "stop-loss" ? "Stop-loss" : "Take-profit"} atteint · $${symbol}`,
      body: `${signed(holding.value.pnlPct)} sur ta position. Aucun ordre automatique : vends depuis le Dashboard si tu le souhaites.`
    });
  }
}

function renderLive() {
  const wallet = activeWallet();
  document.querySelector("#live-banner-balance").textContent = wallet?.balance != null ? `◎ ${solText2(wallet.balance)}` : "";
  renderLiveTrade();
  const kpis = document.querySelector("#live-kpis");
  const cards = document.querySelector("#live-positions");
  const ordersNode = document.querySelector("#live-orders");
  if (!kpis) return;
  if (!wallet) {
    kpis.innerHTML = "";
    cards.innerHTML = '<div class="positions-empty empty-card">Connecte un wallet (menu en haut à droite) pour voir ton portefeuille réel.</div>';
    ordersNode.innerHTML = "";
    return;
  }
  const holdings = liveHoldings();
  const solUsd = currentSolUsd();
  const tokenUsd = holdings.reduce((total, holding) => total + (holding.value.valueUsd ?? 0), 0);
  const solBalance = state.live.portfolio?.sol ?? wallet.balance ?? 0;
  const pnlSol = holdings.reduce((total, holding) => total + (holding.value.pnlSol ?? 0), 0);
  const realized = [...costBasis(state.live.orders.filter(order => order.wallet === wallet.address)).values()].reduce((total, entry) => total + entry.realizedSol, 0);
  kpis.innerHTML = [
    ["SOL du wallet", solText2(solBalance), formatMoney(solBalance * solUsd, 0), ""],
    ["Tokens", formatMoney(tokenUsd, 0), `${holdings.length} position${holdings.length > 1 ? "s" : ""}`, ""],
    ["Valeur totale", formatMoney(solBalance * solUsd + tokenUsd, 0), `${shortAddress(wallet.address)} · ${wallet.name}`, ""],
    ["P&L latent (ordres Pulse)", `${pnlSol >= 0 ? "+" : "−"}${solText2(Math.abs(pnlSol))}`, formatMoney(pnlSol * solUsd, 0), tone(pnlSol)],
    ["P&L réalisé (ordres Pulse)", `${realized >= 0 ? "+" : "−"}${solText2(Math.abs(realized))}`, formatMoney(realized * solUsd, 0), tone(realized)]
  ].map(([label, value, sub, valueTone]) => `<article class="kpi"><span>${label}</span><strong class="${valueTone}">${value}</strong><small>${sub}</small></article>`).join("");
  document.querySelector("#live-meta").textContent = state.live.loading ? "actualisation…" : "";

  cards.innerHTML = holdings.length ? holdings.map(holding => {
    const meta = tokenMeta(holding.mint);
    const status = holding.status;
    const pct = holding.value.pnlPct;
    return `<article class="position-card live-card ${holding.breach ? "due" : ""}" data-live-mint="${esc(holding.mint)}">
      <header><span class="mini-avatar" style="--accent:#8b9699">${avatarContent({ imageUrl: status?.imageUrl ?? null, initials: (status?.symbol ?? meta.symbol).slice(0, 2).toUpperCase() })}</span>
        <div class="pc-name"><strong>${esc(status?.name ?? meta.name)}</strong><small>$${esc(status?.symbol ?? meta.symbol)} · ${esc(shortAddress(holding.mint))}</small></div>
        ${pct == null ? '<span class="pc-pill neutral">coût inconnu</span>' : `<span class="pc-pill ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "↑" : "↓"} ${Math.abs(pct).toLocaleString(locale, { maximumFractionDigits: 1 })} %</span>`}</header>
      <div class="pc-main"><strong>${holding.value.valueUsd == null ? "prix inconnu" : formatMoney(holding.value.valueUsd, 2)}</strong><span>${holding.value.valueSol == null ? "" : solText2(holding.value.valueSol)}</span></div>
      <dl class="pc-grid"><div><dt>Quantité</dt><dd>${holding.value.amount.toLocaleString(locale, { maximumFractionDigits: 2 })}</dd></div><div><dt>Prix</dt><dd>${status?.price > 0 ? formatPrice(status.price) : "—"}</dd></div><div><dt>Coût (ordres Pulse)</dt><dd>${holding.cost?.costSol > 0 ? solText2(holding.cost.costSol) : "—"}</dd></div></dl>
      ${holding.breach ? `<p class="due-note">${holding.breach === "stop-loss" ? "Stop-loss atteint" : "Take-profit atteint"} : vends si tu le souhaites.</p>` : ""}
      <footer class="position-actions">
        <label class="limit-edit" title="Alerte de stop-loss (perte en %)">SL −<input type="number" min="1" max="99" step="1" placeholder="aucun" value="${holding.limits?.sl ?? ""}" data-live-limit="sl" data-live-mint="${esc(holding.mint)}" />%</label>
        <label class="limit-edit" title="Alerte de take-profit (gain en %)">TP +<input type="number" min="1" step="1" placeholder="aucun" value="${holding.limits?.tp ?? ""}" data-live-limit="tp" data-live-mint="${esc(holding.mint)}" />%</label>
        <button class="close-position" type="button" data-live-sell="${esc(holding.mint)}" data-fraction="0.25">25 %</button>
        <button class="close-position" type="button" data-live-sell="${esc(holding.mint)}" data-fraction="0.5">50 %</button>
        <button class="close-position ${holding.breach ? "pulse-due" : ""}" type="button" data-live-sell="${esc(holding.mint)}" data-fraction="1">Vendre tout</button>
      </footer></article>`;
  }).join("") : `<div class="positions-empty empty-card">${state.live.portfolio ? "Aucun token dans ce wallet." : "Chargement du portefeuille…"}</div>`;

  const mine = state.live.orders.filter(order => order.wallet === wallet.address).slice(0, 15);
  const STATE_LABEL = { pending: ["en attente", "warn"], confirmed: ["confirmé", "ok"], finalized: ["confirmé", "ok"], failed: ["échoué", "bad"], expired: ["sans réponse", "neutral"] };
  ordersNode.innerHTML = mine.length ? mine.map(order => {
    const [label, orderTone] = STATE_LABEL[order.state] ?? STATE_LABEL.pending;
    return `<div class="history-row live-order"><strong>$${esc(order.symbol)}</strong><span>${new Date(order.ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span><span><b class="${order.side === "buy" ? "positive" : "negative"}">${order.side === "buy" ? "ACHAT" : "VENTE"}</b> · ${solText2(lamportsToSol(order.solLamports))}</span><span><span class="plan-pill ${orderTone}">${label}</span> <a class="wallet-link" href="${SOLSCAN_TX}${esc(order.id)}" target="_blank" rel="noopener noreferrer">Solscan ↗</a></span></div>`;
  }).join("") : '<div class="positions-empty">Aucun ordre pour le moment.</div>';
}

document.querySelector("#live-positions").addEventListener("click", event => {
  const button = event.target.closest("[data-live-sell]");
  if (button) startLiveSell(button.dataset.liveSell, Number(button.dataset.fraction) || 1);
});
document.querySelector("#live-positions").addEventListener("change", event => {
  const input = event.target.closest("[data-live-limit]");
  if (!input) return;
  const mint = input.dataset.liveMint;
  const value = Number(input.value);
  const limits = { ...(state.live.limits[mint] ?? {}) };
  if (Number.isFinite(value) && value > 0) limits[input.dataset.liveLimit] = value; else delete limits[input.dataset.liveLimit];
  if (Object.keys(limits).length) state.live.limits[mint] = limits; else delete state.live.limits[mint];
  saveJson("pulse-live-limits", state.live.limits);
  state.live.alerted.clear();
  checkLiveLimits();
  renderLive();
  showToast("Alerte enregistrée (aucun ordre automatique en mode LIVE).");
});
document.querySelector("#live-refresh").addEventListener("click", () => refreshLive());
setInterval(() => { if (liveActive() && !document.hidden) refreshLive(); }, LIVE_WALLET_REFRESH_MS);
window.addEventListener("pulse-wallets-changed", () => { if (liveActive()) refreshLive(); });
applyMode();

/* ---- Auto-trade bot (TEST mode): fixed entry size and exit percentages ---- */
const BOT_FIELDS = ["minScore", "sizePct", "maxAmount", "stopLossPct", "takeProfitPct", "entryDipPct", "orderTimeoutMin", "maxOpen", "dailyLossPct", "cooldownHours"];
const BOT_LOG_LIMIT = 40;
function loadBot() { try { return normalizeBot(JSON.parse(localStorage.getItem("pulse-bot") || "null")); } catch { return normalizeBot(null); } }
function loadBotLog() { try { const log = JSON.parse(localStorage.getItem("pulse-bot-log") || "[]"); return Array.isArray(log) ? log.filter(item => item && typeof item.text === "string").slice(0, BOT_LOG_LIMIT) : []; } catch { return []; } }
function loadBotPending() { try { return normalizePending(JSON.parse(localStorage.getItem("pulse-bot-pending") || "[]")); } catch { return []; } }
const bot = { config: loadBot(), log: loadBotLog(), pending: loadBotPending(), entries: {} };
function saveBot() {
  try { localStorage.setItem("pulse-bot", JSON.stringify(bot.config)); localStorage.setItem("pulse-bot-log", JSON.stringify(bot.log)); localStorage.setItem("pulse-bot-pending", JSON.stringify(bot.pending)); } catch { /* storage unavailable */ }
}
function botLog(text) { bot.log.unshift({ at: Date.now(), text }); bot.log = bot.log.slice(0, BOT_LOG_LIMIT); }

function runBot() {
  if (state.mode === "live" || !bot.config.enabled || !tokens.length || !state.market.live) return;
  for (const position of state.positions) if (position.auto && position.openedAt) bot.entries[position.tokenId] = Math.max(bot.entries[position.tokenId] ?? 0, position.openedAt);
  for (const trade of state.history) if (trade.auto) bot.entries[trade.tokenId] = Math.max(bot.entries[trade.tokenId] ?? 0, trade.openedAt ?? 0);
  const { buys, pending, expired, placed, paused } = pickEntries({ tokens, positions: state.positions, history: state.history, balance: state.balance, startBalance: START_BALANCE, config: bot.config, lastEntries: bot.entries, pending: bot.pending, isQualified });
  bot.paused = paused;
  bot.pending = pending;
  const priceText = value => `$${value.toLocaleString(locale, { maximumSignificantDigits: 4 })}`;
  for (const order of expired) botLog(`Ordre limite expiré · $${order.symbol} (le prix n'est pas descendu à ${priceText(order.limitPrice)})`);
  for (const order of placed) botLog(`Ordre limite · $${order.symbol} à ${priceText(order.limitPrice)} (−${bot.config.entryDipPct} %) · valable ${bot.config.orderTimeoutMin} min`);
  for (const { token, amount, score, source, limit } of buys) {
    const preset = activePreset(amount);
    const costs = costsFor(preset, currentSolUsd());
    if (validateBuy(token, amount, state.balance, { preset, costs })) continue;
    state.balance -= amount;
    const position = { ...openPosition(token, amount, { costs, preset, stopLossPct: bot.config.stopLossPct, takeProfitPct: bot.config.takeProfitPct }), auto: true };
    state.positions.unshift(position);
    bot.entries[token.id] = position.openedAt;
    botLog(`Achat ${formatMoney(amount)} · $${token.symbol} (${source === "early" ? "⚡ démarrage" : source === "call" ? "call Telegram" : "qualifié"}, score ${score})${limit ? ` sur repli à ${priceText(limit)}` : ""} · SL −${bot.config.stopLossPct} % · TP +${bot.config.takeProfitPct} %`);
    notify({ type: "entry", tokenId: token.id, title: `Bot : achat · $${token.symbol}`, body: `${formatMoney(amount)} · SL −${bot.config.stopLossPct} % · TP +${bot.config.takeProfitPct} %` });
  }
  if (buys.length || expired.length || placed.length) { saveBot(); if (buys.length) renderPositions(); }
  renderBot();
}

function renderBot() {
  const card = document.querySelector("#bot-card");
  if (!card) return;
  const { config } = bot;
  document.querySelector("#bot-enabled").checked = config.enabled;
  const live = state.mode === "live";
  document.querySelector("#bot-state").textContent = live ? "Indisponible en LIVE" : config.enabled ? (bot.paused === "daily-loss" ? "En pause" : "Actif") : "Désactivé";
  document.querySelector("#bot-source").value = config.source;
  document.querySelector("#bot-useCalls").checked = config.useCalls;
  for (const field of BOT_FIELDS) { const input = document.querySelector(`#bot-${field}`); if (input && document.activeElement !== input) input.value = config[field]; }
  const stats = botStats(state.history);
  const open = state.positions.filter(position => position.auto).length;
  const pnlToday = botPnlToday(state.history);
  const parts = [`${open} / ${config.maxOpen} position${open > 1 ? "s" : ""} bot`, `${stats.count} trade${stats.count > 1 ? "s" : ""} clôturé${stats.count > 1 ? "s" : ""}`];
  if (stats.winRate != null) parts.push(`réussite ${stats.winRate.toFixed(0)} %`, `P&L bot ${stats.pnl >= 0 ? "+" : ""}${formatMoney(stats.pnl, 2)}`);
  parts.push(`aujourd'hui ${pnlToday >= 0 ? "+" : ""}${formatMoney(pnlToday, 2)}`);
  const status = document.querySelector("#bot-status");
  status.className = `bot-status ${bot.paused === "daily-loss" ? "warn" : ""}`;
  status.textContent = (bot.paused === "daily-loss" ? "⏸ Perte maximale du jour atteinte : le bot reprend demain. · " : "") + parts.join(" · ");
  document.querySelector("#bot-pending").innerHTML = bot.pending.length
    ? `<strong>Ordres limites en attente</strong>${bot.pending.map(order => `<div><span>$${esc(order.symbol)} · achat à $${order.limitPrice.toLocaleString(locale, { maximumSignificantDigits: 4 })}</span><small>expire dans ${Math.max(0, Math.ceil((order.expiresAt - Date.now()) / 60_000))} min</small></div>`).join("")}`
    : "";
  document.querySelector("#bot-log").innerHTML = bot.log.length
    ? bot.log.slice(0, 8).map(item => `<div><time>${new Date(item.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time><span>${esc(item.text)}</span></div>`).join("")
    : '<div class="muted">Aucune action pour le moment.</div>';
}

document.querySelector("#bot-enabled").addEventListener("change", event => {
  if (state.mode === "live") { event.target.checked = false; showToast("Le bot ne trade qu'en mode TEST : en LIVE, tu signes chaque ordre."); return; }
  bot.config.enabled = event.target.checked;
  if (!bot.config.enabled) bot.pending = [];
  botLog(bot.config.enabled ? "Bot activé." : "Bot désactivé.");
  saveBot(); renderBot();
  if (bot.config.enabled) runBot();
});
document.querySelector("#bot-source").addEventListener("change", event => { bot.config = normalizeBot({ ...bot.config, source: event.target.value }); saveBot(); renderBot(); });
document.querySelector("#bot-useCalls").addEventListener("change", event => { bot.config = normalizeBot({ ...bot.config, useCalls: event.target.checked }); saveBot(); renderBot(); });
for (const field of BOT_FIELDS) document.querySelector(`#bot-${field}`).addEventListener("change", event => { bot.config = normalizeBot({ ...bot.config, [field]: event.target.value }); saveBot(); renderBot(); });
renderBot();
