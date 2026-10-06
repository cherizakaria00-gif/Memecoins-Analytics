const API_ROOT = "https://frontend-api-v3.pump.fun";
const CACHE_TTL_MS = 30_000;
const PROFILE_IMAGE_HOST = "socialimages.pump.fun";
const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PERIODS = new Set(["daily", "weekly", "monthly"]);
const cache = new Map();

export const isValidSlug = slug => SLUG.test(slug ?? "");
export const isValidPeriod = period => PERIODS.has(period);

const asNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function safeProfileImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === PROFILE_IMAGE_HOST ? url.href : null;
  } catch {
    return null;
  }
}

const shortWallet = wallet => typeof wallet === "string" && wallet.length > 10 ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : wallet ?? "";

function prizeForRank(prizes, rank) {
  const prize = (Array.isArray(prizes) ? prizes : []).find(item => rank >= item.rankFrom && rank <= item.rankTo);
  return prize ? asNumber(prize.amount) : null;
}

export function mapCompetition(raw) {
  return {
    slug: String(raw?.slug ?? ""),
    title: String(raw?.title ?? "Compétition"),
    description: String(raw?.description ?? ""),
    phase: String(raw?.phase ?? ""),
    prizePool: asNumber(raw?.prizeCopy),
    prizes: (Array.isArray(raw?.prizes) ? raw.prizes : []).map(prize => ({ rankFrom: asNumber(prize.rankFrom), rankTo: asNumber(prize.rankTo), amount: asNumber(prize.amount) })),
    startsAt: raw?.startsAt ?? null,
    endsAt: raw?.endsAt ?? null,
    participants: asNumber(raw?.participants ?? raw?.entriesCount),
    isFinal: Boolean(raw?.isFinal)
  };
}

export function mapEntry(entry, prizes = []) {
  const wallet = typeof entry?.walletAddress === "string" ? entry.walletAddress : "";
  const rank = asNumber(entry?.rank);
  return {
    rank,
    username: String(entry?.username ?? "") || shortWallet(wallet),
    wallet,
    shortWallet: shortWallet(wallet),
    profileImage: safeProfileImage(entry?.profileImageUrl ?? entry?.profileImage),
    verified: Boolean(entry?.isVerified),
    pnlUsd: asNumber(entry?.pnlUsd),
    pnlPercent: entry?.pnlPercent == null ? null : asNumber(entry.pnlPercent),
    positions: asNumber(entry?.positionsCount),
    topSymbols: (Array.isArray(entry?.topPositions) ? entry.topPositions : []).map(position => position?.symbol).filter(Boolean).slice(0, 3),
    prize: prizeForRank(prizes, rank)
  };
}

async function fetchJson(path, fetchImpl) {
  const response = await fetchImpl(`${API_ROOT}${path}`, {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; PulsePaperScanner/0.1)" },
    signal: AbortSignal.timeout(8_000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`pump.fun responded with HTTP ${response.status}`);
  return response.json();
}

async function cached(key, now, load) {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await load();
  cache.set(key, { at: now, value });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return value;
}

/** Live, upcoming and past pump.fun trading competitions (summaries only). */
export function getCompetitions({ fetchImpl = fetch, now = Date.now() } = {}) {
  return cached("competitions", now, async () => {
    const payload = await fetchJson("/competitions", fetchImpl);
    return ["live", "upcoming", "past"].flatMap(group => (Array.isArray(payload?.[group]) ? payload[group] : []).map(mapCompetition));
  });
}

/** Standings of one competition: up to 100 ranked entries with prizes. Null when the slug is unknown. */
export function getCompetitionStandings(slug, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!isValidSlug(slug)) throw new TypeError("Invalid competition slug");
  return cached(`competition:${slug}`, now, async () => {
    const payload = await fetchJson(`/competitions/${slug}`, fetchImpl);
    if (!payload?.competition) return null;
    const competition = mapCompetition(payload.competition);
    const board = payload.leaderboard ?? {};
    return {
      kind: "competition", competition, totalRanked: asNumber(board.totalRanked, competition.participants), updatedAt: asNumber(board.builtAtMs, now),
      entries: (Array.isArray(board.entries) ? board.entries : []).map(entry => mapEntry(entry, competition.prizes))
    };
  });
}

/** Global pump.fun PnL leaderboard for a period. */
export function getPnlLeaderboard(period, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!isValidPeriod(period)) throw new TypeError("Invalid period");
  return cached(`pnl:${period}`, now, async () => {
    const payload = await fetchJson(`/pnl-leaderboard?period=${period}&limit=50`, fetchImpl);
    return {
      kind: "pnl", period, label: String(payload?.periodLabel ?? period), updatedAt: now,
      entries: (Array.isArray(payload?.entries) ? payload.entries : []).map(entry => mapEntry({ ...entry, username: entry.username || entry.xUsername }))
    };
  });
}
