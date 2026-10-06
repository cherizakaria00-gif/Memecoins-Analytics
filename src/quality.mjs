/**
 * Minimum activity a token must show to be worth looking at, by life stage (thresholds found by research):
 *  - New pairs (bonding curve just started): $50 minimum volume
 *  - Final stretch (bonding curve well advanced): $10K minimum market cap
 *  - Migrated (graduated to the AMM, or not a launchpad token): $30K minimum market cap
 *  - Global fees paid: 0.5 SOL minimum, for every stage
 *  - Every token: at least 7 minutes old, $5K market cap and $10K liquidity
 * Override with QUALITY_MIN_VOLUME, QUALITY_MIN_MCAP_FINAL, QUALITY_MIN_MCAP_MIGRATED and QUALITY_MIN_FEES_SOL.
 */
export const DEFAULT_QUALITY = { minVolumeNew: 50, minMcapFinalStretch: 10_000, minMcapMigrated: 30_000, minFeesSol: 0.5, minAgeMinutes: 7, minMcap: 5_000, minLiquidity: 10_000 };

const FINAL_STRETCH_PROGRESS = 0.5;
const PUMP_GRADUATION_MCAP_USD = 69_000;
const FEE_RATE = 0.01;
const PUMP_DEXES = new Set(["pumpswap", "pumpfun"]);
/** A token launched on pump.fun: vanity "pump" mint suffix, a pump.fun DEX, or pump.fun data already attached. */
export const isPumpOrigin = token => Boolean(token?.pump) || PUMP_DEXES.has(String(token?.dex).toLowerCase()) || (typeof (token?.address ?? token?.id) === "string" && String(token.address ?? token.id).endsWith("pump"));
const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

export function qualityConfigFromEnv(env = process.env) {
  const read = (name, fallback) => (Number.isFinite(Number(env[name])) && env[name] !== "" && env[name] != null ? Number(env[name]) : fallback);
  return {
    minVolumeNew: read("QUALITY_MIN_VOLUME", DEFAULT_QUALITY.minVolumeNew),
    minMcapFinalStretch: read("QUALITY_MIN_MCAP_FINAL", DEFAULT_QUALITY.minMcapFinalStretch),
    minMcapMigrated: read("QUALITY_MIN_MCAP_MIGRATED", DEFAULT_QUALITY.minMcapMigrated),
    minFeesSol: read("QUALITY_MIN_FEES_SOL", DEFAULT_QUALITY.minFeesSol),
    minAgeMinutes: read("QUALITY_MIN_AGE_MIN", DEFAULT_QUALITY.minAgeMinutes),
    minMcap: read("QUALITY_MIN_MCAP", DEFAULT_QUALITY.minMcap),
    minLiquidity: read("QUALITY_MIN_LIQUIDITY", DEFAULT_QUALITY.minLiquidity)
  };
}

/** Life stage: "new" (early bonding curve), "final" (curve nearly full), "migrated" (AMM or non-launchpad token). */
export function lifeStage(token) {
  if (!isPumpOrigin(token)) return "migrated";
  const marketCap = num(token.marketCap);
  if (token.pump) {
    if (token.pump.graduated) return "migrated";
    return num(token.pump.bondingProgress) >= FINAL_STRETCH_PROGRESS ? "final" : "new";
  }
  // No launchpad data: guess from the market cap (a pump.fun token graduates around $69K).
  return marketCap >= PUMP_GRADUATION_MCAP_USD ? "migrated" : marketCap >= PUMP_GRADUATION_MCAP_USD / 2 ? "final" : "new";
}

/** Estimated protocol + creator fees paid by traders (about 1 % of the traded volume), in SOL. */
export function estimateFeesSol(token) {
  const solUsd = num(token.solPriceUsd);
  return solUsd > 0 ? (num(token.volume24h) * FEE_RATE) / solUsd : null;
}

export function evaluateQuality(token, config = DEFAULT_QUALITY) {
  const stage = lifeStage(token);
  const feesSol = estimateFeesSol(token);
  const checks = [];
  if (stage === "new") checks.push({ id: "volume", label: "Volume minimum (new pairs)", value: num(token.volume24h), min: config.minVolumeNew, unit: "usd" });
  if (stage === "final") checks.push({ id: "mcap", label: "Market cap minimum (final stretch)", value: num(token.marketCap), min: config.minMcapFinalStretch, unit: "usd" });
  if (stage === "migrated") checks.push({ id: "mcap", label: "Market cap minimum (migrated)", value: num(token.marketCap), min: config.minMcapMigrated, unit: "usd" });
  checks.push({ id: "age", label: "Âge minimum", value: num(token.ageMinutes), min: config.minAgeMinutes, unit: "min" });
  checks.push({ id: "mcap-floor", label: "Market cap minimum", value: num(token.marketCap), min: config.minMcap, unit: "usd" });
  checks.push({ id: "liquidity", label: "Liquidité minimum", value: num(token.liquidity), min: config.minLiquidity, unit: "usd" });
  if (config.minVolume24h > 0) checks.push({ id: "volume24h", label: "Volume 24 h minimum", value: token.volume24h == null ? null : num(token.volume24h), min: config.minVolume24h, unit: "usd" });
  checks.push({ id: "fees", label: "Frais globaux payés (estimés)", value: feesSol, min: config.minFeesSol, unit: "sol" });
  for (const check of checks) check.ok = check.value != null && check.value >= check.min;
  return { stage, feesSol, checks, passes: checks.every(check => check.ok) };
}
