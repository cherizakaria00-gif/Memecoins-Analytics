/**
 * RugCheck report summary (public API, no key): risks graded "danger" or "warn", the creator's history and the share of locked liquidity.
 * Only requested for the few tokens that already look promising, cached for 10 minutes, never throws.
 */
const API_URL = "https://api.rugcheck.xyz/v1/tokens";
const TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const CONCURRENCY = 4;
const cache = new Map();

export function mapRugCheck(raw) {
  const risks = Array.isArray(raw?.risks) ? raw.risks : [];
  const names = level => risks.filter(risk => risk?.level === level && typeof risk.name === "string").map(risk => risk.name.slice(0, 80));
  const lp = Number(raw?.lpLockedPct);
  const score = Number(raw?.score_normalised);
  return { danger: names("danger"), warnings: names("warn"), score: Number.isFinite(score) ? score : null, lpLockedPct: Number.isFinite(lp) ? lp : null };
}

async function fetchOne(mint, fetchImpl, now) {
  const hit = cache.get(mint);
  if (hit && now - hit.at < (hit.data ? TTL_MS : FAILURE_TTL_MS)) return hit.data;
  try {
    const response = await fetchImpl(`${API_URL}/${mint}/report/summary`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = mapRugCheck(await response.json());
    cache.set(mint, { at: now, data });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return data;
  } catch {
    cache.set(mint, { at: now, data: null }); // an unavailable check never blocks a token
    return null;
  }
}

/** RugCheck data by mint (missing entries = unavailable). */
export async function fetchRugChecks(mints, { fetchImpl = fetch, now = Date.now(), env = process.env } = {}) {
  const result = new Map();
  if (env.RUGCHECK === "0") return result;
  const queue = [...new Set(mints)];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const mint = queue.shift();
      const data = await fetchOne(mint, fetchImpl, now);
      if (data) result.set(mint, data);
    }
  }));
  return result;
}

export const _test = { cache };
