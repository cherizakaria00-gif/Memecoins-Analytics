import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { costsFor, openPosition, presetForCapital, sellFraction } from "../dist/paper-trading.js";

export const HORIZONS = { m15: 15 * 60_000, h1: 60 * 60_000, h4: 4 * 60 * 60_000 };
const NOTIONAL = 200;
const REFERENCE_SOL_USD = 120;
const COOLDOWN_MS = 30 * 60_000;
const MAX_NEW_PER_TICK = 25;
const BASELINE_PER_TICK = 8;
const MAX_RECORDS = 4000;
const LATE_TOLERANCE_MS = 10 * 60_000;
/** A 31x move within the 4 h tracking window is a data glitch (wrong pair or price), not a trade result. */
export const MAX_PLAUSIBLE_RETURN = 30;
const plausible = value => Number.isFinite(value) && value <= MAX_PLAUSIBLE_RETURN && value >= -1;

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Net return of buying $200 at the signal and selling at the horizon, with the simulator's fees and price impact. */
export function netReturn(record, exitToken) {
  if (!(exitToken?.price > 0)) return null;
  const entry = { id: record.tokenId, name: record.symbol, symbol: record.symbol, initials: "", price: record.entryPrice, liquidity: record.liquidity };
  const preset = presetForCapital(NOTIONAL / REFERENCE_SOL_USD);
  const position = openPosition(entry, NOTIONAL, { now: record.t0, costs: costsFor(preset, REFERENCE_SOL_USD), preset });
  const sale = sellFraction(position, exitToken, 1, { now: record.t0 });
  return sale.proceeds / NOTIONAL - 1;
}

export function createTracker({ file = null, now = () => Date.now() } = {}) {
  let records = [];
  const lastTracked = new Map();
  const earlyTracked = new Map();

  return {
    get records() { return records; },

    /** Records new signals (all tradable ones plus a few untradable ones as a baseline) with a per-token cooldown. */
    track(tokens, at = now()) {
      const eligible = tokens.filter(token => token.signal && token.price > 0 && (!lastTracked.has(token.id) || at - lastTracked.get(token.id) >= COOLDOWN_MS));
      const picked = [
        ...eligible.filter(token => token.signal.tradable).slice(0, MAX_NEW_PER_TICK),
        ...eligible.filter(token => !token.signal.tradable).sort(() => Math.random() - 0.5).slice(0, BASELINE_PER_TICK)
      ];
      const earlyPicks = tokens.filter(token => token.early?.early && token.price > 0 && !(earlyTracked.has(token.id) && at - earlyTracked.get(token.id) < COOLDOWN_MS));
      for (const token of earlyPicks) {
        earlyTracked.set(token.id, at);
        records.push({
          id: `${token.id}-early-${at}`, tokenId: token.id, symbol: token.symbol, grade: "early", score: token.early.score,
          t0: at, entryPrice: token.price, liquidity: token.liquidity, ageMinutes: token.ageMinutes, flags: [],
          change1h: token.change, outcomes: {}, maxPrice: token.price, minPrice: token.price
        });
      }
      for (const token of picked) {
        lastTracked.set(token.id, at);
        records.push({
          id: `${token.id}-${at}`, tokenId: token.id, symbol: token.symbol, grade: token.signal.grade, score: token.signal.score,
          t0: at, entryPrice: token.price, liquidity: token.liquidity, ageMinutes: token.ageMinutes, flags: token.signal.flagCodes ?? [], outcomes: {}
        });
      }
      if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
      return picked.length + earlyPicks.length;
    },

    /** Updates the best/worst price reached since each recent signal (max favorable / adverse excursion). */
    observe(latest, at = now()) {
      for (const record of records) {
        if (at > record.t0 + HORIZONS.h4 + LATE_TOLERANCE_MS || !("maxPrice" in record)) continue;
        const price = latest.get(record.tokenId)?.price;
        if (!(price > 0)) continue;
        record.maxPrice = Math.max(record.maxPrice, price);
        record.minPrice = Math.min(record.minPrice, price);
      }
    },

    /** Token ids whose excursion window is still open (so their prices keep being fetched). */
    activeIds(at = now()) {
      return [...new Set(records.filter(record => "maxPrice" in record && at <= record.t0 + HORIZONS.h4 + LATE_TOLERANCE_MS).map(record => record.tokenId))];
    },

    /** Token ids that have at least one horizon due and not yet resolved. */
    pendingIds(at = now()) {
      return [...new Set(records.filter(record => Object.entries(HORIZONS).some(([key, ms]) => !(key in record.outcomes) && at >= record.t0 + ms)).map(record => record.tokenId))];
    },

    /** Resolves due horizons using the latest known tokens (a Map id -> token). */
    resolve(latest, at = now()) {
      let resolved = 0;
      for (const record of records) {
        for (const [key, ms] of Object.entries(HORIZONS)) {
          if (key in record.outcomes || at < record.t0 + ms) continue;
          if (at - (record.t0 + ms) > LATE_TOLERANCE_MS) { record.outcomes[key] = null; continue; }
          const token = latest.get(record.tokenId);
          const value = netReturn(record, token);
          if (value == null) continue;
          record.outcomes[key] = plausible(value) ? Math.round(value * 10_000) / 10_000 : null;
          resolved += 1;
        }
      }
      return resolved;
    },

    stats() {
      const groups = { A: [], B: [], C: [], avoid: [] };
      const earlyRecords = records.filter(record => record.grade === "early");
      for (const record of records) groups[record.grade]?.push(record);
      const summarize = list => Object.fromEntries(Object.keys(HORIZONS).map(key => {
        const values = list.map(record => record.outcomes[key]).filter(value => typeof value === "number" && plausible(value));
        return [key, {
          n: values.length,
          winRate: values.length ? values.filter(value => value > 0).length / values.length : null,
          avg: values.length ? values.reduce((total, value) => total + value, 0) / values.length : null,
          median: median(values)
        }];
      }));
      const flagStats = {};
      for (const record of records) {
        for (const code of Array.isArray(record.flags) ? record.flags : []) (flagStats[code] ??= []).push(record);
      }
      const tradable = [...groups.A, ...groups.B];
      const gain = record => record.maxPrice / record.entryPrice - 1;
      const completed = earlyRecords.filter(record => now() >= record.t0 + HORIZONS.h4 && plausible(gain(record)));
      const share = (list, predicate) => (list.length ? list.filter(predicate).length / list.length : null);
      const early = {
        count: earlyRecords.length, completed: completed.length,
        hit50: share(completed, record => gain(record) >= 0.5), hit100: share(completed, record => gain(record) >= 1), hit200: share(completed, record => gain(record) >= 2),
        fellMinus25: share(completed, record => record.minPrice / record.entryPrice - 1 <= -0.25),
        avgMaxGain: completed.length ? completed.reduce((total, record) => total + gain(record), 0) / completed.length : null,
        ...summarize(earlyRecords)
      };
      return { tracked: records.length, early, flags: Object.fromEntries(Object.entries(flagStats).map(([code, list]) => [code, { count: list.length, ...summarize(list) }])), tradable: summarize(tradable), grades: Object.fromEntries(Object.entries(groups).map(([grade, list]) => [grade, { count: list.length, ...summarize(list) }])), baseline: summarize([...groups.C, ...groups.avoid]) };
    },

    async load() {
      if (!file) return;
      try {
        const saved = JSON.parse(await readFile(file, "utf8"));
        if (Array.isArray(saved?.records)) records = saved.records.filter(record => record?.tokenId && Number.isFinite(record.t0));
        for (const record of records) lastTracked.set(record.tokenId, Math.max(lastTracked.get(record.tokenId) ?? 0, record.t0));
      } catch { /* first run or unreadable file: start empty */ }
    },

    async save() {
      if (!file) return;
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, records }));
      await rename(temp, file);
    }
  };
}
