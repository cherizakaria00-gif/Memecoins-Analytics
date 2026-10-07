import assert from "node:assert/strict";
import test from "node:test";
import { recordHolderGrowth } from "../src/pumpfun-client.mjs";
import { evaluateSniper } from "../src/sniper.mjs";

const holders = { reliable: true, totalHolders: 800, top10Pct: 22, devPct: 1, sniperPct: 3, bundlerPct: 2, insidersPct: 6, growth10m: 30 };
const token = {
  ageMinutes: 90, marketCap: 120_000, liquidity: 60_000, volume: 40_000, buys: 300, sells: 150, buys5m: 40, sells5m: 15, holderStats: holders,
  rug: { danger: [], warnings: [], score: 1, lpLockedPct: 100 },
  socials: { website: "https://coin.xyz/", twitter: "https://x.com/coin", telegram: null, discord: null, count: 2 },
  jup: { organicScore: 70, organicLabel: "high", mintAuthorityDisabled: true, freezeAuthorityDisabled: true, holderGrowth10m: 20 }
};

test("a clean token with momentum passes both layers and scores as an entry", () => {
  const sniper = evaluateSniper(token);
  assert.equal(sniper.layers[0].passed, true);
  assert.equal(sniper.layers[1].passed, true);
  assert.equal(sniper.score, 100);
  assert.equal(sniper.entry, true);
  assert.equal(sniper.verdict, "Entrée possible");
});

test("one failed security check eliminates the token whatever its momentum", () => {
  const sniper = evaluateSniper({ ...token, holderStats: { ...holders, sniperPct: 18, insidersPct: 22 } });
  assert.equal(sniper.layers[0].passed, false);
  assert.equal(sniper.entry, false);
  assert.match(sniper.verdict, /sécurité/);
  assert.deepEqual(sniper.layers[0].checks.filter(item => item.status === "fail").map(item => item.id), ["insiders", "snipers"]);
});

test("missing holder data is unknown (half points), never a failure", () => {
  const sniper = evaluateSniper({ ...token, holderStats: undefined, jup: undefined, socials: undefined, rug: undefined });
  const security = sniper.layers[0];
  assert.equal(security.passed, true);
  assert.deepEqual(security.checks.filter(item => item.status === "unknown").map(item => item.id), ["top10", "dev", "insiders", "snipers", "bundlers", "socials", "rugcheck", "authorities"]);
  assert.ok(security.score < security.max);
  assert.equal(sniper.entry, false);
  assert.equal(sniper.verdict, "Holders non vérifiés");
});

test("momentum fails on weak volume, selling pressure and shrinking holder count", () => {
  const sniper = evaluateSniper({ ...token, volume: 500, buys: 40, sells: 120, holderStats: { ...holders, growth10m: -12 } });
  assert.equal(sniper.layers[1].passed, false);
  assert.deepEqual(sniper.layers[1].checks.filter(item => item.status === "fail").map(item => item.id), ["volume", "buys1h", "holders"]);
});

test("holder growth is measured per 10 minutes once the token was watched for 3+ minutes", () => {
  const start = 1_000_000;
  assert.equal(recordHolderGrowth("g1", 100, start), null);
  assert.equal(recordHolderGrowth("g1", 110, start + 60_000), null);
  assert.equal(Math.round(recordHolderGrowth("g1", 130, start + 5 * 60_000)), 60);
  assert.equal(recordHolderGrowth("g1", 0, start + 6 * 60_000), null);
});

test("Jupiter data: active authorities eliminate the token, a low organic score fails older tokens only", () => {
  const risky = evaluateSniper({ ...token, jup: { ...token.jup, freezeAuthorityDisabled: false } });
  assert.equal(risky.layers[0].passed, false);
  assert.equal(risky.layers[0].checks.find(item => item.id === "authorities").status, "fail");
  const bots = { ...token.jup, organicScore: 5, organicLabel: "low" };
  assert.equal(evaluateSniper({ ...token, jup: bots }).layers[1].checks.find(item => item.id === "organic").status, "fail");
  assert.equal(evaluateSniper({ ...token, ageMinutes: 20, jup: bots }).layers[1].checks.find(item => item.id === "organic").status, "unknown");
});

test("without pump.fun holder data, Jupiter's audit fills top holders, dev and holder growth", () => {
  const sniper = evaluateSniper({ ...token, holderStats: undefined, jup: { ...token.jup, topHoldersPct: 18, devBalancePct: 1.2, holderGrowth10m: 25 } });
  const status = id => [...sniper.layers[0].checks, ...sniper.layers[1].checks].find(item => item.id === id).status;
  assert.deepEqual(["top10", "dev", "holders", "insiders"].map(status), ["ok", "ok", "ok", "unknown"]);
  assert.equal(sniper.entry, false);
});

test("a token needs a website and at least one social network to pass the security layer", () => {
  const status = socials => evaluateSniper({ ...token, socials }).layers[0].checks.find(item => item.id === "socials");
  assert.equal(status({ website: "https://a.xyz/", twitter: "https://x.com/a", telegram: null, discord: null, count: 2 }).status, "ok");
  assert.equal(status({ website: "https://a.xyz/", twitter: null, telegram: null, discord: null, count: 1 }).status, "fail");
  assert.equal(status({ website: null, twitter: "https://x.com/a", telegram: "https://t.me/a", discord: null, count: 2 }).status, "fail");
  assert.equal(status({ website: null, twitter: null, telegram: null, discord: null, count: 0 }).status, "fail");
  assert.equal(evaluateSniper({ ...token, socials: { website: null, twitter: null, telegram: null, discord: null, count: 0 } }).entry, false);
});

test("a RugCheck danger-level risk eliminates the token", () => {
  const sniper = evaluateSniper({ ...token, rug: { danger: ["Creator history of rugged tokens"], warnings: [], score: 80, lpLockedPct: 100 } });
  assert.equal(sniper.layers[0].passed, false);
  assert.equal(sniper.entry, false);
  assert.match(sniper.layers[0].checks.find(item => item.id === "rugcheck").text, /rugged/);
  const warned = evaluateSniper({ ...token, rug: { danger: [], warnings: ["Low Liquidity"], score: 20, lpLockedPct: 10 } });
  assert.equal(warned.layers[0].checks.find(item => item.id === "rugcheck").status, "ok");
});
