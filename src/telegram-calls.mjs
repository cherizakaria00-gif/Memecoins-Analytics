import { isValidSolanaAddress } from "./wallet-balance.mjs";
import { searchSolanaTokens } from "./dexscreener-client.mjs";

/**
 * Reads the public web preview (t.me/s/<channel>) of Telegram channels that post trading calls and extracts the Solana tokens they announce.
 * Only public channels are readable; nothing is sent to Telegram and no account is needed.
 */
const CHANNEL = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const CHANNEL_TTL_MS = 90_000;
const MAX_CHANNELS = 8;
const MESSAGES_PER_CHANNEL = 25;
const channelCache = new Map();
const resolveCache = new Map();

export const normalizeChannel = value => String(value ?? "").trim().replace(/^(https?:\/\/)?(t\.me|telegram\.me)\/(s\/)?/i, "").replace(/^@/, "").split(/[/?#]/)[0];
export const isValidChannel = value => CHANNEL.test(value);

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const decode = text => text.replace(/&(amp|lt|gt|quot|nbsp|#39);/g, entity => ENTITIES[entity] ?? entity).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
const htmlToText = html => decode(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, ""));

/** Stop-loss / take-profit hints written by the caller ("SL 700K", "TP: 2.5M"): kept as text, never interpreted as an order. */
export function extractLevels(text) {
  const level = label => text.match(new RegExp(`\\b${label}\\d?\\s*[:=@-]?\\s*(\\$?\\d[\\d.,]*\\s?[kKmM]?)`, "i"))?.[1]?.trim() ?? null;
  return { sl: level("SL"), tp: level("TP") };
}

/** Candidate Solana addresses (token mint or pair) in a message: raw text and links, in order of appearance. */
export function extractAddresses(text, hrefs = []) {
  const seen = new Set();
  for (const source of [...hrefs, text]) for (const match of source.match(BASE58) ?? []) if (isValidSolanaAddress(match) && /\d/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match)) seen.add(match);
  return [...seen].slice(0, 3);
}

export function parseChannelHtml(html, channel) {
  const messages = [];
  for (const block of html.split(/class="tgme_widget_message_wrap/).slice(1)) {
    const post = block.match(/data-post="([^"]+)"/)?.[1];
    const textHtml = block.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (!post || !textHtml) continue;
    const hrefs = [...textHtml.matchAll(/href="([^"]+)"/g)].map(match => decode(match[1]));
    const text = htmlToText(textHtml).trim();
    const at = Date.parse(block.match(/<time[^>]*datetime="([^"]+)"/)?.[1] ?? "");
    messages.push({ channel, post, id: Number(post.split("/")[1]) || 0, at: Number.isFinite(at) ? at : null, text: text.slice(0, 600), addresses: extractAddresses(text, hrefs), ...extractLevels(text) });
  }
  return messages.slice(-MESSAGES_PER_CHANNEL);
}

async function fetchChannel(channel, { fetchImpl, now }) {
  const cached = channelCache.get(channel);
  if (cached && now - cached.at < CHANNEL_TTL_MS) return cached.messages;
  const response = await fetchImpl(`https://t.me/s/${channel}`, { headers: { "user-agent": "Mozilla/5.0 (compatible; PulseCalls/0.1)", accept: "text/html" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
  if (!response.ok) throw Object.assign(new Error(`Telegram HTTP ${response.status}`), { status: 502 });
  const html = await response.text();
  if (!html.includes("tgme_widget_message_wrap")) throw Object.assign(new Error("Canal introuvable ou privé : seuls les canaux publics sont lisibles."), { status: 404 });
  const messages = parseChannelHtml(html, channel);
  channelCache.set(channel, { at: now, messages });
  return messages;
}

/** Resolves a candidate address (token mint or DEX pair) to a token with live market data; null when it is not a Solana token. */
async function resolveAddress(address, { fetchImpl, now }) {
  const cached = resolveCache.get(address);
  if (cached && now - cached.at < 60_000) return cached.token;
  let token = null;
  try { token = (await searchSolanaTokens(address, { fetchImpl, now }))[0] ?? null; } catch { token = null; }
  resolveCache.set(address, { at: now, token });
  return token;
}

const summarize = token => ({ address: token.address, name: token.name, symbol: token.symbol, price: token.price, marketCap: token.marketCap, liquidity: token.liquidity, volume24h: token.volume24h, change1h: token.change ?? null, ageMinutes: token.ageMinutes ?? null, pump: Boolean(token.pump) });

/** Turns messages that contain addresses into calls pointing at a real Solana token (newest first). */
export async function callsFromMessages(messages, { fetchImpl = fetch, now = Date.now(), limit = 30 } = {}) {
  const withAddress = messages.filter(message => message.addresses.length).sort((first, second) => (second.at ?? 0) - (first.at ?? 0)).slice(0, limit);
  const calls = [];
  for (const message of withAddress) {
    let token = null;
    for (const address of message.addresses) { token = await resolveAddress(address, { fetchImpl, now }); if (token) break; }
    if (token) calls.push({ channel: message.channel, post: message.post, url: message.post.startsWith("private:") ? null : `https://t.me/${message.post}`, private: message.post.startsWith("private:"), at: message.at, text: message.text, sl: message.sl, tp: message.tp, token: summarize(token) });
  }
  return calls;
}

/** Latest calls of the given public channels (newest first) with current market data. */
export async function getTelegramCalls(channels, { fetchImpl = fetch, now = Date.now(), extraMessages = [] } = {}) {
  const wanted = [...new Set(channels.map(normalizeChannel).filter(isValidChannel))].slice(0, MAX_CHANNELS);
  const outcomes = await Promise.allSettled(wanted.map(channel => fetchChannel(channel, { fetchImpl, now })));
  const errors = {};
  const messages = [...extraMessages];
  outcomes.forEach((outcome, index) => { if (outcome.status === "fulfilled") messages.push(...outcome.value); else errors[wanted[index]] = outcome.reason?.message ?? "Erreur"; });
  return { calls: await callsFromMessages(messages, { fetchImpl, now }), errors, channels: wanted, at: now };
}

export const _test = { channelCache, resolveCache };
