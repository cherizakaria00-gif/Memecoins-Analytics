import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HORIZONS, createTracker, netReturn } from "../src/signal-tracker.mjs";

const token = (id, grade, price = 1) => ({ id, symbol: id.toUpperCase(), price, liquidity: 500_000, ageMinutes: 120, signal: { grade, score: grade === "A" ? 85 : 30, tradable: grade === "A" || grade === "B", flags: [] } });
const T0 = 1_000_000_000_000;

test("tracks tradable signals plus a baseline, with a per-token cooldown", () => {
  const tracker = createTracker();
  tracker.track([token("a", "A"), token("b", "avoid")], T0);
  assert.equal(tracker.records.length, 2);
  assert.equal(tracker.track([token("a", "A")], T0 + 60_000), 0);
  assert.equal(tracker.track([token("a", "A")], T0 + 31 * 60_000), 1);
});

test("resolves horizons net of fees and price impact", () => {
  const tracker = createTracker();
  tracker.track([token("a", "A", 1)], T0);
  assert.deepEqual(tracker.pendingIds(T0 + 60_000), []);
  assert.deepEqual(tracker.pendingIds(T0 + HORIZONS.m15 + 1), ["a"]);
  tracker.resolve(new Map([["a", token("a", "A", 1.5)]]), T0 + HORIZONS.m15 + 1000);
  const outcome = tracker.records[0].outcomes.m15;
  assert.ok(outcome > 0.4 && outcome < 0.5, `net ${outcome}`);
  assert.ok(netReturn(tracker.records[0], token("a", "A", 1)) < 0);
});

test("marks horizons missed when the price arrives far too late", () => {
  const tracker = createTracker();
  tracker.track([token("a", "A")], T0);
  tracker.resolve(new Map([["a", token("a", "A", 2)]]), T0 + HORIZONS.m15 + 30 * 60_000);
  assert.equal(tracker.records[0].outcomes.m15, null);
});

test("summarizes win rate, average and median per grade", () => {
  const tracker = createTracker();
  tracker.track([token("a", "A", 1), token("b", "A", 1), token("c", "A", 1)], T0);
  tracker.resolve(new Map([["a", token("a", "A", 2)], ["b", token("b", "A", 0.5)], ["c", token("c", "A", 1.2)]]), T0 + HORIZONS.m15 + 1000);
  const stats = tracker.stats();
  assert.equal(stats.tradable.m15.n, 3);
  assert.ok(Math.abs(stats.tradable.m15.winRate - 2 / 3) < 1e-9);
  assert.equal(stats.grades.A.count, 3);
  assert.equal(stats.tradable.h1.n, 0);
});

test("persists and reloads records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pulse-"));
  const file = join(dir, "signals.json");
  const first = createTracker({ file });
  first.track([token("a", "A")], T0);
  await first.save();
  assert.equal(JSON.parse(await readFile(file, "utf8")).records.length, 1);
  const second = createTracker({ file });
  await second.load();
  assert.equal(second.records.length, 1);
  assert.equal(second.track([token("a", "A")], T0 + 1000), 0);
});

test("reports outcomes per filter flag so thresholds can be tuned", () => {
  const tracker = createTracker();
  const flagged = { ...token("f", "avoid", 1), signal: { grade: "avoid", score: 20, tradable: false, flags: ["x"], flagCodes: ["dumping"] } };
  tracker.track([flagged], T0);
  tracker.resolve(new Map([["f", token("f", "avoid", 0.7)]]), T0 + HORIZONS.m15 + 1000);
  const stats = tracker.stats();
  assert.equal(stats.flags.dumping.count, 1);
  assert.ok(stats.flags.dumping.m15.avg < -0.3);
});

test("records early starts and measures the best and worst price reached", () => {
  const tracker = createTracker();
  const early = { ...token("e", "avoid", 1), early: { early: true, score: 80 } };
  assert.equal(tracker.track([early], T0) >= 1, true);
  const record = tracker.records.find(item => item.grade === "early");
  assert.ok(record && record.maxPrice === 1);
  tracker.observe(new Map([["e", token("e", "avoid", 2.5)]]), T0 + 10 * 60_000);
  tracker.observe(new Map([["e", token("e", "avoid", 0.7)]]), T0 + 20 * 60_000);
  assert.equal(record.maxPrice, 2.5);
  assert.equal(record.minPrice, 0.7);
  assert.deepEqual(tracker.activeIds(T0 + 60_000), ["e"]);
  assert.deepEqual(tracker.activeIds(T0 + HORIZONS.h4 + 60 * 60_000), []);
  assert.equal(tracker.track([early], T0 + 60_000), 0);
});

test("early stats report how many starts reached +50, +100 and +200 %", () => {
  let clock = T0;
  const tracker = createTracker({ now: () => clock });
  const mk = id => ({ ...token(id, "avoid", 1), early: { early: true, score: 80 } });
  tracker.track([mk("a"), mk("b"), mk("c"), mk("d")], T0);
  const prices = { a: [3.5, 0.9], b: [2.2, 1.1], c: [1.6, 0.8], d: [1.05, 0.7] };
  for (const [id, [high, low]] of Object.entries(prices)) {
    tracker.observe(new Map([[id, token(id, "avoid", high)]]), T0 + 30 * 60_000);
    tracker.observe(new Map([[id, token(id, "avoid", low)]]), T0 + 60 * 60_000);
  }
  assert.equal(tracker.stats().early.completed, 0);
  clock = T0 + HORIZONS.h4 + 1000;
  const stats = tracker.stats().early;
  assert.equal(stats.completed, 4);
  assert.equal(stats.hit50, 0.75);
  assert.equal(stats.hit100, 0.5);
  assert.equal(stats.hit200, 0.25);
  assert.equal(stats.fellMinus25, 0.25);
});

test("absurd returns from data glitches are ignored in the statistics", () => {
  const tracker = createTracker();
  tracker.track([token("a", "A", 1), token("b", "A", 1), token("c", "A", 1)], T0);
  tracker.resolve(new Map([["a", token("a", "A", 1.2)], ["b", token("b", "A", 0.9)], ["c", token("c", "A", 800)]]), T0 + HORIZONS.m15 + 1000);
  const stats = tracker.stats().tradable.m15;
  assert.equal(stats.n, 2);
  assert.ok(stats.avg < 0.2, `avg ${stats.avg}`);
  assert.equal(tracker.records.find(record => record.tokenId === "c").outcomes.m15, null);
});
