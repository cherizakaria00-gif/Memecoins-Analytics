import test from "node:test";
import assert from "node:assert/strict";
import { getCompetitionStandings, getCompetitions, getPnlLeaderboard, mapEntry } from "../src/standings-client.mjs";

const prizes = [{ rankFrom: 1, rankTo: 1, amount: "50000" }, { rankFrom: 2, rankTo: 3, amount: "10000" }];

test("maps an entry with prize, short wallet and safe avatar", () => {
  const entry = mapEntry({ rank: 2, username: "bob", walletAddress: "GMqwf2ct8runQarHgHxkbXgcMBJzwjVoL525ZLCAFLB2", pnlUsd: "1234.5", positionsCount: 7, profileImageUrl: "https://socialimages.pump.fun/a.png", topPositions: [{ symbol: "PUMP" }, { symbol: null }] }, prizes);
  assert.equal(entry.prize, 10000);
  assert.equal(entry.shortWallet, "GMqw…FLB2");
  assert.equal(entry.profileImage, "https://socialimages.pump.fun/a.png");
  assert.deepEqual(entry.topSymbols, ["PUMP"]);
  assert.equal(mapEntry({ rank: 9, username: "x", profileImageUrl: "https://evil.example/a.png" }, prizes).profileImage, null);
  assert.equal(mapEntry({ rank: 9 }, prizes).prize, null);
});

test("loads standings for a competition and rejects bad slugs", async () => {
  const fetchImpl = async url => {
    assert.match(url, /\/competitions\/solo-test$/);
    return { ok: true, status: 200, json: async () => ({ competition: { slug: "solo-test", title: "Solo", prizes, participants: 5, phase: "live" }, leaderboard: { totalRanked: 5, entries: [{ rank: 1, username: "a", pnlUsd: 10 }] } }) };
  };
  const standings = await getCompetitionStandings("solo-test", { fetchImpl, now: 1 });
  assert.equal(standings.entries[0].prize, 50000);
  assert.equal(standings.totalRanked, 5);
  assert.throws(() => getCompetitionStandings("../etc", { fetchImpl }), TypeError);
  assert.equal(await getCompetitionStandings("unknown-one", { fetchImpl: async () => ({ ok: false, status: 404 }), now: 1 }), null);
});

test("lists competitions and the pnl leaderboard", async () => {
  const fetchImpl = async url => ({ ok: true, status: 200, json: async () => String(url).includes("pnl-leaderboard")
    ? { periodLabel: "Today", entries: [{ rank: 1, walletAddress: "4ugDhHJ8XDXAeABmrNmGffFaLbJb9BkPyiFGVSV9ocwo", pnlUsd: 5, xUsername: "xuser" }] }
    : { live: [{ slug: "a", title: "A", prizeCopy: "100", phase: "live" }], upcoming: [], past: [{ slug: "b", title: "B" }] } });
  const list = await getCompetitions({ fetchImpl, now: 10 });
  assert.deepEqual(list.map(item => item.slug), ["a", "b"]);
  const board = await getPnlLeaderboard("daily", { fetchImpl, now: 10 });
  assert.equal(board.entries[0].username, "xuser");
  assert.throws(() => getPnlLeaderboard("yearly", { fetchImpl }), TypeError);
});
