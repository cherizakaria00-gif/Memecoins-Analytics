import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_QUALITY, estimateFeesSol, evaluateQuality, lifeStage, qualityConfigFromEnv } from "../src/quality.mjs";

const migrated = { address: "So1anaMintWithoutTheSuffix111111111111111111", marketCap: 120_000, volume24h: 90_000, solPriceUsd: 100, ageMinutes: 300, liquidity: 60_000 };

test("fees are about 1 % of the volume expressed in SOL", () => {
  assert.equal(estimateFeesSol(migrated), 9);
  assert.equal(estimateFeesSol({ volume24h: 5 }), null);
});

test("stages follow the launchpad data, with a market-cap guess when it is missing", () => {
  assert.equal(lifeStage(migrated), "migrated");
  assert.equal(lifeStage({ address: "xpump", marketCap: 5_000 }), "new");
  assert.equal(lifeStage({ address: "xpump", marketCap: 40_000 }), "final");
  assert.equal(lifeStage({ address: "xpump", marketCap: 80_000 }), "migrated");
  assert.equal(lifeStage({ address: "xpump", pump: { graduated: false, bondingProgress: 0.7 } }), "final");
  assert.equal(lifeStage({ address: "xpump", pump: { graduated: false, bondingProgress: 0.1 } }), "new");
  assert.equal(lifeStage({ address: "xpump", pump: { graduated: true } }), "migrated");
});

test("migrated tokens need $30K market cap and 0.5 SOL of fees", () => {
  assert.equal(evaluateQuality(migrated).passes, true);
  assert.equal(evaluateQuality({ ...migrated, marketCap: 25_000 }).passes, false);
  const lowFees = evaluateQuality({ ...migrated, volume24h: 3_000 });
  assert.equal(lowFees.passes, false);
  assert.equal(lowFees.checks.find(check => check.id === "fees").ok, false);
  assert.equal(evaluateQuality({ ...migrated, solPriceUsd: 0 }).passes, false);
});

test("new pairs need $50 volume and final stretch $10K market cap", () => {
  const fresh = { address: "xpump", marketCap: 6_000, volume24h: 80_000, solPriceUsd: 100, ageMinutes: 30, liquidity: 12_000, pump: { graduated: false, bondingProgress: 0.1 } };
  assert.equal(evaluateQuality(fresh).passes, true);
  assert.equal(evaluateQuality({ ...fresh, volume24h: 40 }).passes, false);
  const final = { ...fresh, marketCap: 9_000, pump: { graduated: false, bondingProgress: 0.8 } };
  assert.equal(evaluateQuality(final).passes, false);
  assert.equal(evaluateQuality({ ...final, marketCap: 12_000 }).passes, true);
});

test("thresholds can be overridden from the environment", () => {
  const config = qualityConfigFromEnv({ QUALITY_MIN_MCAP_MIGRATED: "50000", QUALITY_MIN_FEES_SOL: "abc" });
  assert.equal(config.minMcapMigrated, 50_000);
  assert.equal(config.minFeesSol, DEFAULT_QUALITY.minFeesSol);
  assert.equal(evaluateQuality(migrated, config).passes, true);
  assert.equal(evaluateQuality({ ...migrated, marketCap: 45_000 }, config).passes, false);
});

test("every token needs 7 minutes of age, $5K market cap and $10K liquidity", () => {
  const failing = token => evaluateQuality(token).checks.filter(check => !check.ok).map(check => check.id);
  assert.deepEqual(failing({ ...migrated, ageMinutes: 5 }), ["age"]);
  assert.deepEqual(failing({ ...migrated, liquidity: 9_000 }), ["liquidity"]);
  assert.deepEqual(failing({ ...migrated, marketCap: 4_000 }).sort(), ["mcap", "mcap-floor"]);
  assert.deepEqual(failing({ ...migrated, ageMinutes: 7, liquidity: 10_000, marketCap: 30_000 }), []);
  assert.equal(evaluateQuality({ ...migrated, ageMinutes: 3 }).passes, false);
});

import { isPumpOrigin } from "../src/quality.mjs";

test("pump.fun origin is detected without relying on the vanity suffix", () => {
  assert.equal(isPumpOrigin({ address: "64ad16XapwT8y7UQPioMJzC91RgjZCEAeR4x8XNYUBTY", dex: "pumpswap" }), true);
  assert.equal(isPumpOrigin({ address: "xxxpump" }), true);
  assert.equal(isPumpOrigin({ address: "abc", pump: { graduated: true } }), true);
  assert.equal(isPumpOrigin({ address: "abc", dex: "raydium" }), false);
  assert.equal(lifeStage({ address: "64ad16XapwT8y7UQPioMJzC91RgjZCEAeR4x8XNYUBTY", dex: "pumpswap", marketCap: 400_000 }), "migrated");
});

test("the Pulse Filter requires a website and a social network, unless the links are unknown or the rule is off", () => {
  const base = { ageMinutes: 60, marketCap: 120_000, liquidity: 60_000, volume24h: 500_000, solPriceUsd: 100, address: "AAA" };
  const links = (website, twitter) => ({ website, twitter, telegram: null, discord: null, count: Number(Boolean(website)) + Number(Boolean(twitter)) });
  assert.equal(evaluateQuality({ ...base, socials: links("https://a.xyz/", "https://x.com/a") }).passes, true);
  const noWebsite = evaluateQuality({ ...base, socials: links(null, "https://x.com/a") });
  assert.equal(noWebsite.passes, false);
  assert.equal(noWebsite.checks.find(check => check.id === "socials").ok, false);
  assert.equal(evaluateQuality({ ...base, socials: links("https://a.xyz/", null) }).passes, false);
  assert.equal(evaluateQuality({ ...base }).passes, true);
  assert.equal(evaluateQuality({ ...base, socials: links(null, null) }, { ...DEFAULT_QUALITY, requireSocials: false }).passes, true);
  assert.equal(qualityConfigFromEnv({ QUALITY_REQUIRE_SOCIALS: "0" }).requireSocials, false);
  assert.equal(qualityConfigFromEnv({}).requireSocials, true);
});
