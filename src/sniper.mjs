import { DEFAULT_QUALITY } from "./quality.mjs";

/**
 * Sniper Score /100: two layers of filters applied one after the other.
 *  1. Security (50 pts): token age, top 10 holders, dev, insiders, snipers, bundlers.
 *  2. Momentum (50 pts): market cap, liquidity, volume, buys vs sells (1 h and 5 min), growth of the holder count.
 * A check is "ok", "fail" or "unknown" (data not available: it earns half the points and never blocks).
 * A layer passes when none of its checks fails; the token is a sniper entry only when BOTH layers pass, the holder data could be verified and the score is high enough.
 */
export const SNIPER_ENTRY_SCORE = 65;
export const SECURITY_LIMITS = { top10Pct: 40, devPct: 5, insidersPct: 15, sniperPct: 10, bundlerPct: 10 };
export const MOMENTUM_LIMITS = { minVolume1h: 2_000, minBuyRatio: 0.5, minHolderGrowth10m: 5, minOrganicScore: 30 };

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const pct = value => `${(Math.round(value * 10) / 10).toString()} %`;

const check = (id, label, status, text) => ({ id, label, status, text });
const maxCheck = (id, label, value, limit) => (value == null ? check(id, label, "unknown", "donnée indisponible") : check(id, label, value < limit ? "ok" : "fail", `${pct(value)} (max ${limit} %)`));

function layerOf(id, label, checks, points) {
  const credit = checks.reduce((total, item) => total + (item.status === "ok" ? 1 : item.status === "unknown" ? 0.5 : 0), 0);
  return { id, label, checks, passed: checks.every(item => item.status !== "fail"), score: Math.round((credit / checks.length) * points * 10) / 10, max: points };
}

/** Jupiter's Organic Score (real traders vs bots). Brand-new tokens naturally score low, so only older ones are failed. */
function organicCheck(token, jup) {
  if (jup?.organicScore == null) return check("organic", "Organic Score (Jupiter)", "unknown", "donnée indisponible");
  const text = `${Math.round(jup.organicScore)}/100${jup.organicLabel ? ` (${jup.organicLabel})` : ""}`;
  if (jup.organicScore >= MOMENTUM_LIMITS.minOrganicScore) return check("organic", "Organic Score (Jupiter)", "ok", text);
  return check("organic", "Organic Score (Jupiter)", num(token.ageMinutes) >= 60 ? "fail" : "unknown", `${text} · min ${MOMENTUM_LIMITS.minOrganicScore}`);
}

/** RugCheck's danger-level risks (e.g. a creator who already rugged tokens) eliminate the token. */
function rugCheck(rug) {
  if (!rug) return check("rugcheck", "RugCheck", "unknown", "donnée indisponible");
  if (rug.danger.length) return check("rugcheck", "RugCheck", "fail", rug.danger.slice(0, 2).join(" · "));
  return check("rugcheck", "RugCheck", "ok", rug.warnings.length ? `${rug.warnings.length} avertissement(s) : ${rug.warnings.slice(0, 2).join(" · ")}` : "aucun risque signalé");
}

/** A real project declares a website and at least one social network (declared links, not verified). */
function socialsCheck(socials) {
  if (!socials) return check("socials", "Site web + réseau social", "unknown", "donnée indisponible");
  const ok = Boolean(socials.website) && Boolean(socials.twitter || socials.telegram || socials.discord);
  return check("socials", "Site web + réseau social", ok ? "ok" : "fail", ok ? `site + ${["twitter", "telegram", "discord"].filter(key => socials[key]).length} réseau(x)` : socials.website ? "site sans réseau social" : socials.count ? "réseaux sans site web" : "aucun lien déclaré");
}

export function evaluateSniper(token) {
  const holders = token.holderStats?.reliable ? token.holderStats : null;
  const jup = token.jup ?? null;
  const top10 = holders ? num(holders.top10Pct) : jup?.topHoldersPct ?? null; // pump.fun's list when available, else Jupiter's audit
  const dev = holders ? num(holders.devPct) : jup?.devBalancePct ?? null;
  const insiders = holders ? num(holders.insidersPct ?? holders.devPct + holders.sniperPct + holders.bundlerPct) : null;
  const minAge = num(token.quality?.checks?.find(item => item.id === "age")?.min) || DEFAULT_QUALITY.minAgeMinutes;
  const security = layerOf("security", "Sécurité", [
    check("age", "Âge du token", num(token.ageMinutes) >= minAge ? "ok" : "fail", `${Math.round(num(token.ageMinutes))} min (min ${minAge})`),
    maxCheck("top10", "Top 10 holders", top10, SECURITY_LIMITS.top10Pct),
    maxCheck("dev", "Dev holding", dev, SECURITY_LIMITS.devPct),
    maxCheck("insiders", "Insider holdings", insiders, SECURITY_LIMITS.insidersPct),
    maxCheck("snipers", "Sniper holdings", holders ? num(holders.sniperPct) : null, SECURITY_LIMITS.sniperPct),
    maxCheck("bundlers", "Bundles holding", holders ? num(holders.bundlerPct) : null, SECURITY_LIMITS.bundlerPct),
    socialsCheck(token.socials),
    rugCheck(token.rug),
    jup && jup.mintAuthorityDisabled != null && jup.freezeAuthorityDisabled != null
      ? check("authorities", "Mint / freeze authority", jup.mintAuthorityDisabled && jup.freezeAuthorityDisabled ? "ok" : "fail", jup.mintAuthorityDisabled && jup.freezeAuthorityDisabled ? "révoquées" : "ACTIVE : le créateur garde un contrôle")
      : check("authorities", "Mint / freeze authority", "unknown", "donnée indisponible")
  ], 50);

  const buys1h = num(token.buys), sells1h = num(token.sells), buys5m = num(token.buys5m), sells5m = num(token.sells5m);
  const ratio = (buys, sells, minTxns) => (buys + sells >= minTxns ? buys / (buys + sells) : null);
  const ratio1h = ratio(buys1h, sells1h, 10), ratio5m = ratio(buys5m, sells5m, 5);
  const ratioCheck = (id, label, value) => (value == null ? check(id, label, "unknown", "pas assez de transactions") : check(id, label, value >= MOMENTUM_LIMITS.minBuyRatio ? "ok" : "fail", `${Math.round(value * 100)} % d'achats`));
  const growth = holders && Number.isFinite(holders.growth10m) ? holders.growth10m : Number.isFinite(jup?.holderGrowth10m) ? jup.holderGrowth10m : null;
  const minMcap = num(token.quality?.checks?.find(item => item.id === "mcap-floor")?.min) || DEFAULT_QUALITY.minMcap;
  const minLiquidity = num(token.quality?.checks?.find(item => item.id === "liquidity")?.min) || DEFAULT_QUALITY.minLiquidity;
  const momentum = layerOf("momentum", "Momentum", [
    check("mcap", "Market cap", num(token.marketCap) >= minMcap ? "ok" : "fail", `${Math.round(num(token.marketCap)).toLocaleString("en-US")} $ (min ${minMcap.toLocaleString("en-US")} $)`),
    check("liquidity", "Liquidité", num(token.liquidity) >= minLiquidity ? "ok" : "fail", `${Math.round(num(token.liquidity)).toLocaleString("en-US")} $ (min ${minLiquidity.toLocaleString("en-US")} $)`),
    check("volume", "Volume 1 h", num(token.volume) >= MOMENTUM_LIMITS.minVolume1h ? "ok" : "fail", `${Math.round(num(token.volume)).toLocaleString("en-US")} $ (min ${MOMENTUM_LIMITS.minVolume1h.toLocaleString("en-US")} $)`),
    ratioCheck("buys1h", "Achats vs ventes (1 h)", ratio1h),
    ratioCheck("buys5m", "Achats vs ventes (5 min)", ratio5m),
    organicCheck(token, jup),
    growth == null ? check("holders", "Croissance des holders", "unknown", "historique insuffisant")
      : check("holders", "Croissance des holders", growth >= MOMENTUM_LIMITS.minHolderGrowth10m ? "ok" : "fail", `${growth >= 0 ? "+" : ""}${Math.round(growth)} holders / 10 min`)
  ], 50);

  const score = Math.round(security.score + momentum.score);
  const layers = [security, momentum];
  const failed = layers.find(layer => !layer.passed);
  const verifiable = security.checks.filter(item => !["authorities", "socials", "rugcheck"].includes(item.id)).every(item => item.status !== "unknown"); // never recommend an entry on unverified holder data
  return {
    score, layers, entry: !failed && verifiable && score >= SNIPER_ENTRY_SCORE,
    verdict: failed ? `Écarté par la couche ${failed.label.toLowerCase()}` : verifiable && score >= SNIPER_ENTRY_SCORE ? "Entrée possible" : verifiable ? "À surveiller" : "Holders non vérifiés"
  };
}
