import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HR, SECURITY_GREEN, hrPnlToday, hrRejection, hrStats, normalizeHr, pickHrEntries, securityProblem } from "../dist/hrbot.js";

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const coin = (id, extra = {}) => ({ id, symbol: id, price: 0.00001, ageMinutes: 3, marketCap: 12_000, volume24h: 5_000, quality: { passes: false }, socials: { count: 0 }, ...extra });
const config = { ...DEFAULT_HR, enabled: true, requireSecurity: false, minHolderGrowthPct: 0 };
const run = (overrides = {}) => pickHrEntries({ coins: [], positions: [], history: [], balance: 10_000, startBalance: 10_000, config, now: NOW, ...overrides });

test("defaults: 5 % take-profit, disabled, sane bounds, untrusted input is clamped", () => {
  assert.equal(DEFAULT_HR.takeProfitPct, 5);
  assert.equal(DEFAULT_HR.enabled, false);
  const safe = normalizeHr({ enabled: "yes", amount: 1e9, takeProfitPct: -3, stopLossPct: "abc", maxAgeMin: 0, requireFilter: 1 });
  assert.equal(safe.enabled, false);
  assert.equal(safe.amount, 5000);
  assert.equal(safe.takeProfitPct, 1);
  assert.equal(safe.stopLossPct, DEFAULT_HR.stopLossPct);
  assert.equal(safe.maxAgeMin, 1);
  assert.equal(safe.requireFilter, false);
});

test("buys only fresh coins inside the market-cap and volume limits, newest first", () => {
  const coins = [coin("OLD", { ageMinutes: 40 }), coin("TINY", { marketCap: 2000 }), coin("HUGE", { marketCap: 5_000_000 }), coin("QUIET", { volume24h: 100 }), coin("B", { ageMinutes: 8 }), coin("A", { ageMinutes: 2 }), coin("NOPRICE", { price: 0 })];
  const { buys } = run({ coins });
  assert.deepEqual(buys.map(buy => buy.token.id), ["A", "B"]);
  assert.equal(buys[0].amount, 50);
  assert.equal(hrRejection(coins[0], config), "trop vieux");
  assert.equal(hrRejection(coins[6], config), "prix inconnu");
});

test("optional filters: Pulse filter and social networks", () => {
  const coins = [coin("X"), coin("OK", { quality: { passes: true }, socials: { count: 2 } })];
  assert.equal(run({ coins, config: { ...config, requireFilter: true } }).buys.map(buy => buy.token.id).join(), "OK");
  assert.equal(run({ coins, config: { ...config, requireSocials: true } }).buys.map(buy => buy.token.id).join(), "OK");
});

test("respects open slots, held coins, cooldown and the available balance", () => {
  const coins = ["A", "B", "C", "D", "E", "F", "G"].map((id, index) => coin(id, { ageMinutes: index + 1 }));
  assert.equal(run({ coins }).buys.length, 5);
  const positions = [{ tokenId: "A", hr: true }, { tokenId: "Z", hr: true }, { tokenId: "Q", auto: true }];
  assert.deepEqual(run({ coins, positions }).buys.map(buy => buy.token.id), ["B", "C", "D"]); // 2 of 5 slots used by this bot; the other bot's position does not count
  assert.deepEqual(run({ coins, lastEntries: { A: NOW - 3_600_000 } }).buys.map(buy => buy.token.id).slice(0, 2), ["B", "C"]);
  assert.equal(run({ coins, balance: 120 }).buys.length, 2);
  assert.equal(run({ coins, balance: 5 }).buys.length, 0);
  assert.equal(run({ coins, config: { ...config, enabled: false } }).buys.length, 0);
});

test("a daily loss limit pauses the bot, only its own trades count", () => {
  const trade = (pnl, extra = {}) => ({ hr: true, closedAt: NOW - 1000, pnl, ...extra });
  assert.equal(hrPnlToday([trade(-300), trade(-800), { closedAt: NOW - 1000, pnl: -5000 }], NOW), -1100);
  const paused = run({ coins: [coin("A")], history: [trade(-600), trade(-500)] });
  assert.equal(paused.paused, "daily-loss");
  assert.equal(paused.buys.length, 0);
  const stats = hrStats([trade(5), trade(-2), { pnl: 100 }]);
  assert.deepEqual([stats.count, stats.wins, stats.winRate, stats.pnl], [2, 1, 50, 3]);
});

test("the High Risk Bot skips base assets", () => {
  assert.equal(hrRejection(coin("So11111111111111111111111111111111111111112"), config), "actif de base");
  assert.equal(run({ coins: [coin("So11111111111111111111111111111111111111112"), coin("OK")] }).buys.map(buy => buy.token.id).join(), "OK");
});

const greenHolders = { reliable: true, totalHolders: 300, top10Pct: 12, devPct: 0, sniperPct: 0, insidersPct: 0, bundlerPct: 0 };
const secure = (id, extra = {}) => coin(id, { holderStats: greenHolders, authorities: { mintRevoked: true, freezeRevoked: true }, quality: { passes: true, feesSol: 1.2 }, ...extra });

test("security requirement is on by default and mirrors the green tiles of Token Data & Security", () => {
  assert.equal(DEFAULT_HR.requireSecurity, true);
  assert.equal(normalizeHr({}).requireSecurity, true);
  assert.equal(normalizeHr({ requireSecurity: false }).requireSecurity, false);
  assert.equal(securityProblem(secure("OK")), null);
  const cases = [
    [{ holderStats: undefined }, /absentes/], [{ holderStats: { ...greenHolders, top10Pct: 30 } }, /top 10/], [{ holderStats: { ...greenHolders, devPct: 0.4 } }, /dev/],
    [{ holderStats: { ...greenHolders, sniperPct: 0.5 } }, /snipers/], [{ holderStats: { ...greenHolders, insidersPct: 3 } }, /insiders/], [{ holderStats: { ...greenHolders, bundlerPct: 1 } }, /bundles/],
    [{ authorities: { mintRevoked: true, freezeRevoked: false } }, /authority/], [{ authorities: null }, /authority/], [{ quality: { passes: true, feesSol: 0.1 } }, /frais/]
  ];
  for (const [extra, pattern] of cases) assert.match(securityProblem(secure("X", extra)), pattern);
  assert.equal(securityProblem(secure("ROUND", { holderStats: { ...greenHolders, top10Pct: 24.9, sniperPct: 0.03 } })), null); // 0.0 % once rounded
  assert.equal(SECURITY_GREEN.minFeesSol, 0.5);
});

test("with the security requirement the bot only buys coins whose tiles are all green", () => {
  const strict = { ...config, requireSecurity: true };
  const coins = [coin("PLAIN"), secure("GREEN"), secure("SNIPED", { holderStats: { ...greenHolders, sniperPct: 2 } })];
  assert.deepEqual(run({ coins, config: strict }).buys.map(buy => buy.token.id), ["GREEN"]);
  assert.equal(run({ coins: [coin("PLAIN")], config: strict }).buys.length, 0);
  assert.equal(hrRejection(coin("PLAIN"), strict), "données holders absentes");
});

test("holders must have grown by the required percentage, and unknown growth waits", () => {
  const grown = (id, pct) => coin(id, { holderStats: { reliable: true, totalHolders: 80, growthPct: pct } });
  const cfg = { ...config, minHolderGrowthPct: 30 };
  assert.equal(DEFAULT_HR.minHolderGrowthPct, 30);
  assert.equal(normalizeHr({ minHolderGrowthPct: -5 }).minHolderGrowthPct, 0);
  assert.deepEqual(run({ coins: [grown("UP", 45), grown("FLAT", 12), grown("EXACT", 30), coin("NODATA"), grown("NAN", null)], config: cfg }).buys.map(buy => buy.token.id).sort(), ["EXACT", "UP"]);
  assert.equal(hrRejection(grown("FLAT", 12), cfg), "holders +30 % requis");
  assert.equal(hrRejection(coin("NODATA"), cfg), "croissance des holders inconnue");
  assert.equal(hrRejection(grown("FLAT", 12), { ...cfg, minHolderGrowthPct: 0 }), null);
});
