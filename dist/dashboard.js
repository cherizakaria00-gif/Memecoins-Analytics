const DAY_MS = 86_400_000;
const EQUITY_MIN_GAP_MS = 10_000;
const EQUITY_MAX_POINTS = 1_500;

const sum = values => values.reduce((total, value) => total + value, 0);

/** Realized-trade statistics: win rate, averages, profit factor, extremes, expectancy and average holding time. */
export function tradeStats(history) {
  const trades = Array.isArray(history) ? history.filter(trade => Number.isFinite(trade?.pnl)) : [];
  const wins = trades.filter(trade => trade.pnl > 0);
  const losses = trades.filter(trade => trade.pnl < 0);
  const grossWin = sum(wins.map(trade => trade.pnl));
  const grossLoss = Math.abs(sum(losses.map(trade => trade.pnl)));
  const holds = trades.map(trade => trade.closedAt - trade.openedAt).filter(value => Number.isFinite(value) && value >= 0);
  return {
    count: trades.length, wins: wins.length, losses: losses.length,
    winRate: trades.length ? wins.length / trades.length : null,
    realized: sum(trades.map(trade => trade.pnl)),
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    best: trades.length ? Math.max(...trades.map(trade => trade.pnl)) : null,
    worst: trades.length ? Math.min(...trades.map(trade => trade.pnl)) : null,
    expectancy: trades.length ? sum(trades.map(trade => trade.pnl)) / trades.length : null,
    avgHoldMs: holds.length ? sum(holds) / holds.length : null
  };
}

/** Largest peak-to-trough fall of an equity series [{ t, v }]. */
export function maxDrawdown(points) {
  let peak = -Infinity;
  let worst = { pct: 0, abs: 0 };
  for (const point of points) {
    peak = Math.max(peak, point.v);
    const abs = peak - point.v;
    const pct = peak > 0 ? abs / peak : 0;
    if (pct > worst.pct) worst = { pct, abs };
  }
  return worst;
}

/** Appends an equity sample at most every 10 s (unless forced) and halves the oldest history when the series grows too long. */
export function addEquityPoint(series, point, { force = false, minGapMs = EQUITY_MIN_GAP_MS, max = EQUITY_MAX_POINTS } = {}) {
  if (!Number.isFinite(point?.v) || !Number.isFinite(point?.t)) return series;
  const last = series[series.length - 1];
  if (last && !force && point.t - last.t < minGapMs) return series;
  let next = last && point.t <= last.t ? [...series.slice(0, -1), point] : [...series, point];
  if (next.length > max) next = [...next.slice(0, Math.floor(next.length / 2)).filter((_, index) => index % 2 === 0), ...next.slice(Math.floor(next.length / 2))];
  return next;
}

/** Realized + unrealized P&L per token, best first. `open` is [{ symbol, tokenId, pnl }]. */
export function pnlByToken(history, open = []) {
  const map = new Map();
  const entry = (id, symbol) => map.get(id) ?? map.set(id, { id, symbol, realized: 0, unrealized: 0 }).get(id);
  for (const trade of history) if (Number.isFinite(trade?.pnl)) entry(trade.tokenId, trade.tokenSymbol).realized += trade.pnl;
  for (const position of open) if (Number.isFinite(position?.pnl)) entry(position.tokenId, position.symbol).unrealized += position.pnl;
  return [...map.values()].map(item => ({ ...item, total: item.realized + item.unrealized })).sort((first, second) => second.total - first.total);
}

/** Realized P&L per local calendar day for the last `days` days (oldest first, zero-filled). */
export function pnlByDay(history, days = 14, now = Date.now()) {
  const dayKey = ms => { const date = new Date(ms); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const buckets = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) buckets.set(dayKey(now - offset * DAY_MS), 0);
  for (const trade of history) {
    const key = dayKey(trade.closedAt);
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + trade.pnl);
  }
  return [...buckets].map(([day, pnl]) => ({ day, pnl }));
}

/** Portfolio split between cash and each open position. */
export function allocation(balance, positions) {
  const items = [{ label: "Cash", value: Math.max(balance, 0), cash: true }, ...positions.map(position => ({ label: `$${position.symbol}`, value: Math.max(position.value, 0), tokenId: position.tokenId }))].filter(item => item.value > 0);
  const total = sum(items.map(item => item.value));
  return items.map(item => ({ ...item, pct: total > 0 ? item.value / total : 0 })).sort((first, second) => second.value - first.value);
}

/** Where a position sits between its stop-loss and take-profit (0 = at the stop, 1 = at the target). */
export function limitProgress(pnlPct, stopLossPct, takeProfitPct) {
  const low = -(stopLossPct > 0 ? stopLossPct : 30);
  const high = takeProfitPct > 0 ? takeProfitPct : 60;
  return { position: Math.min(1, Math.max(0, (pnlPct - low) / (high - low))), low, high, hasStop: stopLossPct > 0, hasTarget: takeProfitPct > 0 };
}

export const formatDuration = ms => {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${String(minutes % 60).padStart(2, "0")}` : `${Math.floor(hours / 24)} j`;
};

/** SVG donut ring (stroke segments) for allocation shares. */
export function donutSvg(segments, colors) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const rings = segments.map((segment, index) => {
    const length = segment.pct * circumference;
    const ring = `<circle cx="60" cy="60" r="${radius}" fill="none" stroke="${colors[index % colors.length]}" stroke-width="16" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 60 60)"></circle>`;
    offset += length;
    return ring;
  });
  return `<svg class="donut" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="${radius}" fill="none" stroke="#1a1d1f" stroke-width="16"></circle>${rings.join("")}</svg>`;
}

/** Horizontal diverging bars (positive right, negative left) as plain data for the template: pct of the max magnitude. */
export function barScale(items, key = "total") {
  const max = Math.max(...items.map(item => Math.abs(item[key])), 0);
  return items.map(item => ({ ...item, width: max > 0 ? Math.abs(item[key]) / max : 0 }));
}

/** Loss → profit transition of a position: "down" until it reaches +enter %, back to "down" at 0 % or below, unchanged in between. */
export function profitTransition(previous, pct, enter = 0.5) {
  const next = pct >= enter ? "up" : pct <= 0 ? "down" : previous ?? "down";
  return { next, crossed: previous === "down" && next === "up" };
}
