import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isSameOrigin } from "./saas-routes.mjs";
import { getHeldTokens, getLiveQuotes, getTokenFeed, getTokenStatuses, searchTokens } from "./token-service.mjs";
import { getSolBalance, isValidSolanaAddress } from "./wallet-balance.mjs";
import { createPhantomQrSvg } from "./wallet-qr.mjs";
import { getCandles, isValidTimeframe } from "./chart-client.mjs";
import { getXSignal } from "./x-client.mjs";
import { createTelegramNotifier } from "./telegram-notify.mjs";
import { createTracker } from "./signal-tracker.mjs";
import { fetchHolderStats } from "./pumpfun-client.mjs";
import { getFollowedTrades, resolveTrader } from "./trader-activity.mjs";
import { getMintSecurity } from "./token-security.mjs";
import { getNewCoins } from "./new-coins.mjs";
import { openStore } from "./db.mjs";
import { createAuth } from "./auth.mjs";
import { createBilling } from "./billing.mjs";
import { createCryptoPayments, paymentAddresses } from "./crypto-payments.mjs";
import { createSaas, readBody } from "./saas-routes.mjs";
import { LiveTradingError, checkFeeAccount, getPortfolio, getSignatureState, liveConfig, prepareSwap } from "./live-trading.mjs";
import { getCompetitionStandings, getCompetitions, getPnlLeaderboard, isValidPeriod, isValidSlug } from "./standings-client.mjs";

try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* no .env file, rely on the process environment */ }

const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";
const APP_URL = (process.env.APP_URL ?? `http://${HOST}:${PORT}`).replace(/\/+$/, "");
const store = openStore(process.env.DATABASE_FILE ?? fileURLToPath(new URL("../data/pulse.db", import.meta.url)));
const telegram = createTelegramNotifier({ store, token: process.env.TELEGRAM_BOT_TOKEN });
const telegramRequests = new Map();
const liveTradingConfig = liveConfig();
let feeProblem = null;
if (liveTradingConfig.platformFeeAccount) {
  checkFeeAccount({ config: liveTradingConfig }).then(problem => {
    if (!problem) return;
    feeProblem = problem;
    liveTradingConfig.platformFeeBps = 0;
    console.warn(`PLATFORM_FEE_ACCOUNT invalide (${problem}) : commission désactivée.`);
  });
}
let solUsdCache = { value: 0, at: 0 };
async function getSolUsd() {
  if (solUsdCache.value && Date.now() - solUsdCache.at < 60_000) return solUsdCache.value;
  const response = await fetch("https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(6000) });
  const pairs = (await response.json()).pairs ?? [];
  const best = pairs.filter(pair => pair.baseToken?.address === "So11111111111111111111111111111111111111112" && /^(USDC|USDT)$/.test(pair.quoteToken?.symbol)).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const price = Number(best?.priceUsd);
  if (!(price > 0)) return solUsdCache.value;
  solUsdCache = { value: price, at: Date.now() };
  return price;
}
const saas = createSaas({
  store, platformFee: { get bps() { return liveTradingConfig.platformFeeBps; }, get account() { return liveTradingConfig.platformFeeAccount; }, get problem() { return feeProblem; }, getSolUsd }, crypto: createCryptoPayments({ store, addresses: paymentAddresses(), getSolUsd }), send: sendJson, secureCookies: APP_URL.startsWith("https://"),
  auth: createAuth({ store }),
  billing: createBilling({
    store, appUrl: APP_URL, secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    trialDays: Math.max(0, Number(process.env.TRIAL_DAYS) || 0), devMode: process.env.DEV_BILLING === "1" && !APP_URL.startsWith("https://"),
    adminEmails: (process.env.ADMIN_EMAILS ?? "").split(",").map(email => email.trim().toLowerCase()).filter(Boolean)
  })
});
const liveRequests2 = new Map();
const clientOf = request => (request.user ? `u:${request.user.id}` : request.socket.remoteAddress ?? "unknown");
const STATIC_ROOT = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".mjs", "text/javascript; charset=utf-8"]
]);
const tracker = createTracker({ file: fileURLToPath(new URL("../data/signals.json", import.meta.url)) });
const TRACKING_ENABLED = process.env.SIGNAL_TRACKING !== "0";
const TRACKING_INTERVAL_MS = 60_000;
const balanceRequests = new Map();
const chartRequests = new Map();
const xRequests = new Map();
const searchRequests = new Map();
const holderRequests = new Map();
const liveRequests = new Map();
const traderRequests = new Map();
const securityRequests = new Map();
const newCoinsRequests = new Map();
const statusRequests = new Map();
const standingsRequests = new Map();
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self' chrome-extension: moz-extension:; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.dexscreener.com https://socialimages.pump.fun https://images.pump.fun https://imagedelivery.net; connect-src 'self' https://*.walletconnect.org https://*.walletconnect.com https://*.reown.com wss://*.walletconnect.org wss://*.walletconnect.com; frame-src https://verify.walletconnect.org https://verify.walletconnect.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

function writeHead(response, status, headers = {}) {
  response.writeHead(status, { ...SECURITY_HEADERS, ...headers });
}

function sendJson(response, status, payload, headers = {}) {
  writeHead(response, status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(payload));
}

function isRateLimited(requests, client, limit) {
  const now = Date.now();
  const recent = (requests.get(client) ?? []).filter(timestamp => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= limit) return true;
  recent.push(now);
  requests.set(client, recent);
  return false;
}

async function serveStatic(pathname, response) {
  let relativePath;
  try {
    relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    sendJson(response, 400, { error: "Malformed URL" });
    return;
  }
  const filePath = resolve(STATIC_ROOT, relativePath);
  if (filePath !== STATIC_ROOT && !filePath.startsWith(`${STATIC_ROOT}${sep}`)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const content = await readFile(filePath);
    writeHead(response, 200, { "content-type": MIME_TYPES.get(extname(filePath)) ?? "application/octet-stream" });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok", mode: "paper" });
      return;
    }
    if (await saas.handle(request, response, url)) return;
    if (url.pathname.startsWith("/api/live/")) {
      const denied = saas.gate(request);
      if (denied) { sendJson(response, denied.status, denied.body); return; }
      if (isRateLimited(liveRequests2, clientOf(request), 120)) { sendJson(response, 429, { error: "Trop de requêtes." }); return; }
      try {
        if (url.pathname === "/api/live/config" && request.method === "GET") {
          sendJson(response, 200, { enabled: liveTradingConfig.enabled, maxOrderSol: liveTradingConfig.maxOrderSol, platformFeeBps: liveTradingConfig.platformFeeBps });
          return;
        }
        if (url.pathname === "/api/live/portfolio" && request.method === "GET") {
          sendJson(response, 200, await getPortfolio(url.searchParams.get("owner") ?? "", { config: liveTradingConfig }));
          return;
        }
        if (url.pathname === "/api/live/status" && request.method === "GET") {
          const signature = url.searchParams.get("signature") ?? "";
          const result = await getSignatureState(signature, { config: liveTradingConfig });
          const feeId = url.searchParams.get("order") ?? "";
          if (/^[\w-]{8,64}$/.test(feeId) && result.state !== "pending") {
            store.settleFee({ id: feeId, userId: request.user.id, status: result.state === "failed" ? "failed" : "confirmed", signature, now: Date.now() });
          }
          sendJson(response, 200, result);
          return;
        }
        if (url.pathname === "/api/live/prepare" && request.method === "POST") {
          let body;
          try { body = JSON.parse(await readBody(request, 20_000)); } catch { throw new LiveTradingError("Requête invalide."); }
          console.log(`Live order prepared: ${body?.side} ${String(body?.mint).slice(0, 6)}… by ${request.user.id.slice(0, 8)}`);
          const prepared = await prepareSwap(body, { config: liveTradingConfig });
          if (prepared.summary.platformFee) {
            const orderId = randomUUID();
            store.recordPreparedFee({ id: orderId, userId: request.user.id, side: prepared.summary.side, mint: prepared.summary.mint, bps: prepared.summary.platformFee.bps, feeLamports: prepared.summary.platformFee.lamports, now: Date.now() });
            prepared.summary.orderId = orderId;
          }
          sendJson(response, 200, prepared);
          return;
        }
        sendJson(response, 404, { error: "Introuvable." });
      } catch (error) {
        if (error instanceof LiveTradingError) sendJson(response, error.status, { error: error.message });
        else { console.warn("Live trading route failed:", error.message); sendJson(response, 502, { error: "Service de trading momentanément indisponible." }); }
      }
      return;
    }
    if (url.pathname.startsWith("/api/telegram/")) {
      const denied = saas.gate(request);
      if (denied) { sendJson(response, denied.status, denied.body); return; }
      if (request.method !== "GET" && !isSameOrigin(request)) { sendJson(response, 403, { error: "Origine non autorisée." }); return; }
      if (isRateLimited(telegramRequests, clientOf(request), 40)) { sendJson(response, 429, { error: "Trop de requêtes." }); return; }
      try {
        if (url.pathname === "/api/telegram/status" && request.method === "GET") { sendJson(response, 200, await telegram.status(request.user.id)); return; }
        if (url.pathname === "/api/telegram/link" && request.method === "POST") { sendJson(response, 200, await telegram.startLink(request.user.id)); return; }
        if (url.pathname === "/api/telegram/link" && request.method === "DELETE") { telegram.unlink(request.user.id); sendJson(response, 200, { linked: false }); return; }
        if (url.pathname === "/api/telegram/notify" && request.method === "POST") {
          let body;
          try { body = JSON.parse(await readBody(request, 2_000)); } catch { throw Object.assign(new Error("Requête invalide."), { status: 400 }); }
          const text = typeof body?.text === "string" ? body.text.trim() : "";
          if (!text) throw Object.assign(new Error("Message vide."), { status: 400 });
          sendJson(response, 200, { sent: await telegram.send(request.user.id, text) });
          return;
        }
        sendJson(response, 404, { error: "Introuvable." });
      } catch (error) {
        if (error.status === 503 || (error.status && error.status < 500)) sendJson(response, error.status, { error: error.message });
        else { console.warn("Telegram route failed:", String(error.message).replace(/bot\d+:[\w-]+/g, "bot***")); sendJson(response, 502, { error: "Telegram indisponible pour le moment." }); }
      }
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const denied = saas.gate(request);
      if (denied) {
        sendJson(response, denied.status, denied.body);
        return;
      }
    }
    if (url.pathname === "/api/tokens") {
      const feed = await getTokenFeed({ refresh: url.searchParams.get("refresh") === "1" });
      const held = (url.searchParams.get("held") ?? "").split(",").filter(isValidSolanaAddress).slice(0, 20);
      sendJson(response, 200, { ...feed, held: held.length && feed.live ? await getHeldTokens(held) : [], updatedAt: new Date(feed.updatedAt).toISOString() });
      return;
    }
    if (url.pathname === "/api/wallet/options") {
      const projectId = /^[a-f0-9]{32}$/i.test(process.env.REOWN_PROJECT_ID ?? "") ? process.env.REOWN_PROJECT_ID : null;
      sendJson(response, 200, {
        phantomMobileQr: Boolean(process.env.PUBLIC_APP_URL),
        walletConnectQr: Boolean(projectId),
        walletConnectProjectId: projectId
      });
      return;
    }
    if (url.pathname === "/api/wallet/phantom-qr.svg") {
      if (!process.env.PUBLIC_APP_URL) {
        sendJson(response, 503, { error: "PUBLIC_APP_URL is not configured" });
        return;
      }
      const svg = await createPhantomQrSvg(process.env.PUBLIC_APP_URL);
      writeHead(response, 200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" });
      response.end(svg);
      return;
    }
    if (url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (query.length < 2 || query.length > 60 || /[^\p{L}\p{N} ._$#@-]/u.test(query)) {
        sendJson(response, 400, { error: "Invalid query" });
        return;
      }
      if (isRateLimited(searchRequests, clientOf(request), 20)) {
        sendJson(response, 429, { error: "Too many searches" });
        return;
      }
      try {
        sendJson(response, 200, { tokens: await searchTokens(query) });
      } catch (error) {
        console.warn("Search unavailable:", error.message);
        sendJson(response, 502, { error: "Search unavailable" });
      }
      return;
    }
    if (url.pathname === "/api/token-status") {
      const ids = [...new Set((url.searchParams.get("ids") ?? "").split(",").filter(isValidSolanaAddress))].slice(0, 30);
      if (!ids.length) {
        sendJson(response, 400, { error: "No valid token ids" });
        return;
      }
      if (isRateLimited(statusRequests, clientOf(request), 40)) {
        sendJson(response, 429, { error: "Too many requests" });
        return;
      }
      sendJson(response, 200, { statuses: await getTokenStatuses(ids), at: Date.now() });
      return;
    }
    if (url.pathname === "/api/new-coins") {
      if (isRateLimited(newCoinsRequests, clientOf(request), 40)) {
        sendJson(response, 429, { error: "Too many requests" });
        return;
      }
      try {
        sendJson(response, 200, await getNewCoins());
      } catch (error) {
        console.warn("New coins unavailable:", error.message);
        sendJson(response, 502, { error: "New coins unavailable" });
      }
      return;
    }
    if (url.pathname === "/api/token-security") {
      const mint = url.searchParams.get("mint") ?? "";
      if (!isValidSolanaAddress(mint)) {
        sendJson(response, 400, { error: "Invalid mint" });
        return;
      }
      if (isRateLimited(securityRequests, clientOf(request), 40)) {
        sendJson(response, 429, { error: "Too many security requests" });
        return;
      }
      const [authorities, holders] = await Promise.allSettled([getMintSecurity(mint), fetchHolderStats(mint)]);
      sendJson(response, 200, {
        authorities: authorities.status === "fulfilled" ? authorities.value : null,
        holders: holders.status === "fulfilled" && holders.value ? { available: true, ...holders.value } : { available: false }
      });
      return;
    }
    if (url.pathname === "/api/holders") {
      const mint = url.searchParams.get("mint") ?? "";
      if (!isValidSolanaAddress(mint)) {
        sendJson(response, 400, { error: "Invalid mint" });
        return;
      }
      if (isRateLimited(holderRequests, clientOf(request), 30)) {
        sendJson(response, 429, { error: "Too many holder requests" });
        return;
      }
      try {
        const stats = await fetchHolderStats(mint);
        sendJson(response, 200, stats ? { available: true, ...stats } : { available: false });
      } catch (error) {
        console.warn("Holder stats unavailable:", error.message);
        sendJson(response, 200, { available: false });
      }
      return;
    }
    if (url.pathname === "/api/live") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(isValidSolanaAddress).slice(0, 30);
      if (!ids.length) {
        sendJson(response, 400, { error: "No valid token ids" });
        return;
      }
      if (isRateLimited(liveRequests, clientOf(request), 150)) {
        sendJson(response, 429, { error: "Too many live requests" });
        return;
      }
      sendJson(response, 200, { quotes: await getLiveQuotes(ids), at: Date.now() });
      return;
    }
    if (url.pathname === "/api/traders/resolve" || url.pathname === "/api/traders/trades") {
      if (isRateLimited(traderRequests, clientOf(request), 60)) {
        sendJson(response, 429, { error: "Too many trader requests" });
        return;
      }
      try {
        if (url.pathname === "/api/traders/resolve") {
          const trader = await resolveTrader(url.searchParams.get("q") ?? "");
          sendJson(response, trader ? 200 : 404, trader ?? { error: "Trader not found" });
        } else {
          const wallets = [...new Set((url.searchParams.get("wallets") ?? "").split(",").filter(isValidSolanaAddress))].slice(0, 20);
          sendJson(response, 200, { trades: wallets.length ? await getFollowedTrades(wallets) : [], at: Date.now() });
        }
      } catch (error) {
        if (error instanceof TypeError) sendJson(response, 400, { error: "Invalid trader query" });
        else {
          console.warn("Trader activity unavailable:", error.message);
          sendJson(response, 502, { error: "Trader activity unavailable" });
        }
      }
      return;
    }
    if (url.pathname === "/api/signal-stats") {
      const firstTracked = tracker.records.reduce((earliest, record) => Math.min(earliest, record.t0), Infinity);
      sendJson(response, 200, { enabled: TRACKING_ENABLED, since: Number.isFinite(firstTracked) ? firstTracked : null, ...tracker.stats() });
      return;
    }
    if (url.pathname === "/api/standings") {
      if (isRateLimited(standingsRequests, clientOf(request), 30)) {
        sendJson(response, 429, { error: "Too many standings requests" });
        return;
      }
      const period = url.searchParams.get("period");
      const slug = url.searchParams.get("slug");
      if ((period && !isValidPeriod(period)) || (slug && !isValidSlug(slug))) {
        sendJson(response, 400, { error: "Invalid period or competition" });
        return;
      }
      try {
        const competitions = await getCompetitions();
        const board = period
          ? await getPnlLeaderboard(period)
          : await (async () => {
            const target = slug ?? (competitions.find(item => item.phase === "live") ?? competitions[0])?.slug;
            return target ? getCompetitionStandings(target) : null;
          })();
        sendJson(response, 200, { competitions, board });
      } catch (error) {
        console.warn("Standings unavailable:", error.message);
        sendJson(response, 502, { error: "Standings unavailable" });
      }
      return;
    }
    if (url.pathname === "/api/x") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const address = url.searchParams.get("address") ?? "";
      if (!/^[A-Za-z0-9]{1,15}$/.test(symbol)) {
        sendJson(response, 400, { error: "Invalid symbol" });
        return;
      }
      if (!process.env.X_BEARER_TOKEN) {
        sendJson(response, 200, { enabled: false });
        return;
      }
      if (isRateLimited(xRequests, clientOf(request), 10)) {
        sendJson(response, 429, { error: "Too many X requests" });
        return;
      }
      try {
        sendJson(response, 200, await getXSignal({ symbol, address }));
      } catch (error) {
        console.warn("X signal unavailable:", error.message);
        sendJson(response, 502, { error: "X data unavailable", code: error.code ?? null });
      }
      return;
    }
    if (url.pathname === "/api/chart") {
      const pool = url.searchParams.get("pool") ?? "";
      const timeframe = url.searchParams.get("tf") ?? "5m";
      if (!isValidSolanaAddress(pool) || !isValidTimeframe(timeframe)) {
        sendJson(response, 400, { error: "Invalid pool or timeframe" });
        return;
      }
      if (isRateLimited(chartRequests, clientOf(request), 40)) {
        sendJson(response, 429, { error: "Too many chart requests" });
        return;
      }
      try {
        sendJson(response, 200, { pool, timeframe, candles: await getCandles(pool, timeframe, { background: url.searchParams.get("bg") === "1" }) });
      } catch (error) {
        console.warn("Chart unavailable:", error.message);
        sendJson(response, 502, { error: "Chart data unavailable" });
      }
      return;
    }
    if (url.pathname.startsWith("/api/wallet/") && url.pathname.endsWith("/balance")) {
      let address;
      try {
        address = decodeURIComponent(url.pathname.slice("/api/wallet/".length, -"/balance".length));
      } catch {
        sendJson(response, 400, { error: "Invalid Solana public key" });
        return;
      }
      if (!isValidSolanaAddress(address)) {
        sendJson(response, 400, { error: "Invalid Solana public key" });
        return;
      }
      if (isRateLimited(balanceRequests, clientOf(request), RATE_LIMIT)) {
        sendJson(response, 429, { error: "Too many balance requests" });
        return;
      }
      const balance = await getSolBalance(address);
      sendJson(response, 200, balance);
      return;
    }
    await serveStatic(url.pathname, response);
  } catch (error) {
    console.error("Request failed", error);
    sendJson(response, 500, { error: "Internal server error" });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const requests of [balanceRequests, chartRequests, xRequests, standingsRequests, searchRequests, holderRequests, liveRequests, traderRequests, securityRequests, newCoinsRequests, statusRequests]) {
    for (const [client, timestamps] of requests) {
      if (!timestamps.some(timestamp => now - timestamp < RATE_WINDOW_MS)) requests.delete(client);
    }
  }
}, RATE_WINDOW_MS).unref();

let trackingBusy = false;
async function trackingTick() {
  if (trackingBusy) return;
  trackingBusy = true;
  try {
    const feed = await getTokenFeed();
    if (!feed.live) return;
    tracker.track(feed.tokens);
    const latest = new Map(feed.tokens.map(token => [token.id, token]));
    const missing = [...new Set([...tracker.pendingIds(), ...tracker.activeIds()])].filter(id => !latest.has(id)).slice(0, 60);
    if (missing.length) for (const token of await getHeldTokens(missing)) latest.set(token.id, token);
    tracker.observe(latest);
    tracker.resolve(latest);
    await tracker.save();
  } catch (error) {
    console.warn("Signal tracking tick failed:", error.message);
  } finally {
    trackingBusy = false;
  }
}

if (TRACKING_ENABLED) {
  await tracker.load();
  setTimeout(trackingTick, 5_000).unref();
  setInterval(trackingTick, TRACKING_INTERVAL_MS).unref();
}

server.listen(PORT, HOST, () => {
  console.log(`Pulse is running at http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(error => {
    if (error) console.error("Shutdown failed", error);
    process.exit(error ? 1 : 0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
