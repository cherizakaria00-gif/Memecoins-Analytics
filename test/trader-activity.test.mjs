import test from "node:test";
import assert from "node:assert/strict";
import { attachTokenMeta, getFollowedTrades, getWalletTrades, mapTrade, resolveTrader } from "../src/trader-activity.mjs";

const WALLET = "EqBQhoU88ty3a3aDphDRCBuiRirjUsFSFi4UHGY64qvv";
const WALLET_2 = "EnPjBjzy6zaufzpZ2m3Q8nPS3KpyiRxNLKtcSiMYwWCa";
const MINT = "AndrmNWYxvHpxn1VkgQjmbZVFQJwDzUsbDFVzSZcpump";
const raw = (tx, isBuy, timestamp, wallet = WALLET) => ({ tx, isBuy, timestamp, amountUsd: 1054.41, amountSol: 8.8, priceUsd: 0.000056, mint: MINT, walletAddress: wallet });

test("maps a pump.fun trade and rejects malformed ones", () => {
  const trade = mapTrade(raw("t1", true, "2026-10-05T12:00:00.000Z"));
  assert.equal(trade.isBuy, true);
  assert.equal(trade.timestamp, Date.parse("2026-10-05T12:00:00.000Z"));
  assert.equal(mapTrade({ tx: "x" }), null);
  assert.equal(mapTrade(raw("t", true, "not a date")), null);
});

test("resolves a trader by username and keeps only safe avatars", async () => {
  const fetchImpl = async url => {
    assert.match(url, /\/users\/sadcrissy$/);
    return { ok: true, status: 200, json: async () => ({ address: WALLET, username: "sadcrissy", profile_image: "https://socialimages.pump.fun/a.png" }) };
  };
  const trader = await resolveTrader("sadcrissy", { fetchImpl });
  assert.deepEqual(trader, { wallet: WALLET, username: "sadcrissy", profileImage: "https://socialimages.pump.fun/a.png" });
  const noAvatar = await resolveTrader("sadcrissy", { fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ address: WALLET, username: "x", profile_image: "https://evil.example/a.png" }) }) });
  assert.equal(noAvatar.profileImage, null);
  assert.equal(await resolveTrader("nobody_here", { fetchImpl: async () => ({ ok: false, status: 404 }) }), null);
  await assert.rejects(resolveTrader("../etc/passwd", { fetchImpl }), TypeError);
});

test("loads, sorts and caches wallet trades; rejects bad wallets", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, status: 200, json: async () => ({ trades: [raw("a", true, "2026-10-05T10:00:00Z"), raw("b", false, "2026-10-05T11:00:00Z")] }) }; };
  const trades = await getWalletTrades(WALLET, { fetchImpl, now: 1_000 });
  assert.deepEqual(trades.map(trade => trade.tx), ["b", "a"]);
  await getWalletTrades(WALLET, { fetchImpl, now: 2_000 });
  assert.equal(calls, 1);
  await assert.rejects(getWalletTrades("nope", { fetchImpl }), TypeError);
});

test("attaches token names and the market cap at trade time", async () => {
  const pair = { chainId: "solana", baseToken: { address: MINT, name: "SHALOM INU", symbol: "SI" }, priceUsd: "0.0001", marketCap: 100_000, liquidity: { usd: 20_000 }, pairAddress: "p" };
  const fetchImpl = async () => ({ ok: true, json: async () => [pair] });
  const [trade] = await attachTokenMeta([mapTrade(raw("a", true, "2026-10-05T10:00:00Z"))], { fetchImpl, now: 5_000_000 });
  assert.equal(trade.symbol, "SI");
  assert.equal(Math.round(trade.marketCapAtTrade), 56_000);
  assert.equal(trade.marketCapNow, 100_000);
});

test("one failing wallet does not break the merged feed", async () => {
  const fetchImpl = async url => {
    if (url.includes("api.dexscreener.com")) return { ok: true, json: async () => [] };
    if (url.includes(WALLET_2)) return { ok: false, status: 429 };
    return { ok: true, status: 200, json: async () => ({ trades: [raw("z", true, "2026-10-05T09:00:00Z")] }) };
  };
  const trades = await getFollowedTrades([WALLET, WALLET_2], { fetchImpl, now: 9_000_000 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].marketCapAtTrade, 56_000);
});
