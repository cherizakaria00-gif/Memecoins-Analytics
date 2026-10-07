const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

export const GRADE_THRESHOLDS = { A: 78, B: 65, C: 50 };

/**
 * Entry signal for short-term memecoin trades. Hard filters reject setups that are dangerous
 * whatever their momentum (illiquid, brand new, dumping, already pumped, wash-like); the soft score then
 * rewards liquid markets with fresh, controlled buying pressure rather than the biggest recent pump.
 * It is a heuristic: use the signal tracker statistics to check whether it actually pays.
 */
export function evaluateSignal(token) {
  const liquidity = num(token.liquidity);
  const marketCap = num(token.marketCap);
  const ageMinutes = num(token.ageMinutes);
  const vol5m = num(token.volume5m);
  const vol1h = num(token.volume);
  const vol24h = num(token.volume24h);
  const buys1h = num(token.buys);
  const sells1h = num(token.sells);
  const buys5m = num(token.buys5m);
  const sells5m = num(token.sells5m);
  const change5m = num(token.change5m);
  const change1h = num(token.change);
  const change24h = num(token.change24h);
  const txns1h = buys1h + sells1h;
  const txns5m = buys5m + sells5m;
  const buyRatio1h = txns1h > 0 ? buys1h / txns1h : 0.5;
  const buyRatio5m = txns5m >= 5 ? buys5m / txns5m : buyRatio1h;
  const athRatio = token.athMarketCap > 0 && marketCap > 0 ? Math.min(marketCap / token.athMarketCap, 1) : null;
  const turnover = liquidity > 0 ? vol1h / liquidity : 0;
  const avgTrade = txns1h > 0 ? vol1h / txns1h : 0;

  const flags = [];
  const flagCodes = [];
  const flag = (code, text) => { flags.push(text); flagCodes.push(code); };
  if (liquidity < 20_000) flag("low-liquidity", "Liquidité trop faible (< 20 k$) : sortie coûteuse");
  if (ageMinutes < 20) flag("too-new", "Token trop récent (< 20 min) : zone de snipers");
  if (txns1h >= 20 && buyRatio1h < 0.4) flag("sell-pressure", "Pression vendeuse dominante sur 1 h");
  if (change1h <= -25) flag("dumping", "Chute en cours (−25 % ou pire sur 1 h)");
  if (change1h >= 250 || change24h >= 2500) flag("already-pumped", "Déjà trop monté : risque de sommet");
  if (marketCap > 0 && liquidity > 0 && marketCap / liquidity > 100) flag("thin-vs-mcap", "Market cap > 100× la liquidité");
  if (athRatio != null && athRatio < 0.3) flag("far-from-ath", "Loin de son ATH (< 30 %) : couteau qui tombe");
  if (vol1h > 0 && vol5m < vol1h * 0.015) flag("fading", "Marché qui s'éteint (volume 5 min quasi nul)");
  if (txns1h >= 30 && avgTrade > liquidity * 0.04) flag("big-orders", "Volume concentré en peu de gros ordres (wash possible)");
  if (token.quality && !token.quality.passes) {
    const failed = token.quality.checks.find(check => !check.ok);
    flag("below-minimums", `Sous les minimums du filtre : ${failed?.label ?? "activité insuffisante"}`);
  }
  const holders = token.holderStats?.reliable ? token.holderStats : null;
  if (holders && holders.top10Pct > 60) flag("concentrated", `Top 10 détenteurs : ${Math.round(holders.top10Pct)} % du supply`);
  if (holders && holders.sniperPct + holders.bundlerPct + holders.devPct > 25) flag("insiders", `Snipers, bundlers et dev : ${Math.round(holders.sniperPct + holders.bundlerPct + holders.devPct)} % du supply`);
  if (token.jup && (token.jup.mintAuthorityDisabled === false || token.jup.freezeAuthorityDisabled === false)) flag("authority", "Mint ou freeze authority active : le créateur peut créer ou geler des tokens");
  if (token.rug?.danger?.length) flag("rugcheck", `RugCheck : ${token.rug.danger[0]}`);
  if (txns1h >= 30 && buyRatio1h > 0.95) flag("one-sided-buys", "Achats à sens unique (> 95 %) : la vente est peut-être bloquée (honeypot)");
  if (num(token.transactions) > 0 && num(token.transactions) < 10 && vol24h > 10_000) flag("few-txns", "Gros volume avec très peu de transactions : volume truqué probable");
  if (turnover > 25) flag("turnover", "Rotation de volume anormale (wash possible)");

  const reasons = [];
  const add = (points, text) => { if (points > 0) reasons.push(text); return points; };
  let score = 0;
  score += add(clamp(Math.log10(Math.max(liquidity, 1) / 20_000) / Math.log10(10), 0, 1) * 18, "Liquidité profonde");
  score += add(clamp((buyRatio1h - 0.45) / 0.25, 0, 1) * 12, "Acheteurs majoritaires sur 1 h");
  score += add(clamp((buyRatio5m - 0.5) / 0.25, 0, 1) * 10, "Achats frais sur 5 min");
  const acceleration = vol1h > 0 ? (vol5m * 12) / vol1h : 0;
  score += add(clamp((acceleration - 0.7) / 0.9, 0, 1) * 12, "Volume en accélération");
  score += add(change1h >= 3 && change1h <= 120 ? clamp(1 - Math.abs(change1h - 35) / 85, 0.2, 1) * 16 : 0, "Momentum contrôlé sur 1 h");
  score += add(change5m > 0 && change5m < 25 ? clamp(change5m / 6, 0, 1) * 6 : 0, "Prix qui continue de monter");
  score += add(turnover >= 0.3 && turnover <= 4 ? 8 : turnover > 0.1 ? 3 : 0, "Rotation saine du volume");
  score -= marketCap > 0 && liquidity > 0 && marketCap / liquidity > 40 ? 6 : 0;
  score += add(athRatio == null ? 0 : clamp((athRatio - 0.4) / 0.5, 0, 1) * 8, "Proche de son ATH");
  score += add(ageMinutes >= 60 && ageMinutes <= 1440 ? 5 : ageMinutes >= 20 ? 2 : 0, "Âge favorable");
  score += add(vol1h > 0 && vol24h > 0 && (vol1h * 24) / vol24h > 1.5 ? 5 : 0, "Activité récente soutenue");
  score += add(holders && holders.top10Pct < 25 && holders.totalHolders >= 500 ? 5 : 0, "Supply bien répartie");
  const growth10m = Number.isFinite(holders?.growth10m) ? holders.growth10m : token.jup?.holderGrowth10m;
  score += add(growth10m >= 10 ? clamp(growth10m / 60, 0, 1) * 6 : 0, "Nombre de holders en forte hausse");
  score += add(token.jup?.organicScore >= 50 ? 5 : token.jup?.organicScore >= 30 ? 2 : 0, "Trafic organique élevé (Jupiter)");
  const pump = token.pump;
  if (pump?.graduated) score += add(3, "Gradué de pump.fun");
  const socialCount = token.socials ? token.socials.count : pump?.hasSocials ? 1 : 0;
  if (socialCount > 0) score += add(Math.min(socialCount, 3) + 1, socialCount > 1 ? `${socialCount} réseaux sociaux présents` : "Réseau social présent");

  if (flags.length) score = Math.min(score, 39);
  score = Math.round(clamp(score, 0, 100));
  const grade = flags.length ? "avoid" : score >= GRADE_THRESHOLDS.A ? "A" : score >= GRADE_THRESHOLDS.B ? "B" : score >= GRADE_THRESHOLDS.C ? "C" : "avoid";
  return { score, grade, tradable: grade === "A" || grade === "B", flags, flagCodes, reasons };
}

export const riskFromGrade = grade => (grade === "A" || grade === "B" ? "Faible" : grade === "C" ? "Moyen" : "Élevé");
