import { calculateTokenScore, classifyRisk } from "./scoring.mjs";

const seeds = [
  { id: "pbot", name: "PEPEBOT", symbol: "PBOT", initials: "PB", ageMinutes: 18, liquidity: 184200, volume: 96200, change: 32.4, price: 0.004218, accent: "#b8f55d", holders: 1842, liquidityLocked: 100, top10Concentration: 18.2, mintRevoked: true, freezeRevoked: true },
  { id: "wifx", name: "WIF X", symbol: "WIFX", initials: "WX", ageMinutes: 34, liquidity: 128600, volume: 71400, change: 18.7, price: 0.000841, accent: "#5fe0d0", holders: 926, liquidityLocked: 92, top10Concentration: 22.5, mintRevoked: true, freezeRevoked: true },
  { id: "mogz", name: "MOG ZERO", symbol: "MOGZ", initials: "MZ", ageMinutes: 72, liquidity: 94200, volume: 108900, change: 64.2, price: 0.000065, accent: "#ffc65c", holders: 2104, liquidityLocked: 80, top10Concentration: 31.8, mintRevoked: true, freezeRevoked: false },
  { id: "bonk2", name: "BONK TWO", symbol: "BNK2", initials: "B2", ageMinutes: 128, liquidity: 62300, volume: 49700, change: -8.6, price: 0.000013, accent: "#ff9b62", holders: 712, liquidityLocked: 76, top10Concentration: 38.4, mintRevoked: true, freezeRevoked: false },
  { id: "rugr", name: "RUG RUNNER", symbol: "RUGR", initials: "RR", ageMinutes: 7, liquidity: 21800, volume: 83200, change: 122.5, price: 0.000002, accent: "#ff6b62", holders: 318, liquidityLocked: 0, top10Concentration: 71.3, mintRevoked: false, freezeRevoked: false },
  { id: "degen", name: "DEGEN AI", symbol: "DGEN", initials: "DA", ageMinutes: 221, liquidity: 210400, volume: 135800, change: 11.2, price: 0.002704, accent: "#8bb7ff", holders: 3421, liquidityLocked: 100, top10Concentration: 16.9, mintRevoked: true, freezeRevoked: true },
  { id: "moon", name: "MOON TAPE", symbol: "TAPE", initials: "MT", ageMinutes: 48, liquidity: 45700, volume: 38800, change: -21.4, price: 0.000091, accent: "#ff6b62", holders: 489, liquidityLocked: 24, top10Concentration: 58.1, mintRevoked: false, freezeRevoked: true }
];

let market = structuredClone(seeds);

const formatAge = minutes => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
const formatPercent = value => `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;

function toClientToken(token) {
  const score = calculateTokenScore(token);
  return {
    ...token,
    age: formatAge(token.ageMinutes),
    holders: token.holders.toLocaleString("fr-FR"),
    lock: formatPercent(token.liquidityLocked),
    top10: formatPercent(token.top10Concentration),
    mint: token.mintRevoked,
    freeze: token.freezeRevoked,
    score,
    risk: classifyRisk(score)
  };
}

export function listTokens({ refresh = false } = {}) {
  if (refresh) {
    market = market.map(token => ({
      ...token,
      ageMinutes: token.ageMinutes + 1,
      change: Math.round((token.change + (Math.random() - 0.46) * 7) * 10) / 10,
      price: token.price * (1 + (Math.random() - 0.48) * 0.04),
      volume: Math.round(token.volume * (1 + Math.random() * 0.025))
    }));
  }

  return market.map(toClientToken).sort((first, second) => second.score - first.score);
}
