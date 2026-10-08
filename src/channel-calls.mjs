import { searchSolanaTokens } from "./dexscreener-client.mjs";
import { isValidSolanaAddress } from "./wallet-balance.mjs";

/**
 * Trading calls posted in a Telegram channel where the owner's bot is an administrator.
 * The bot receives each new channel post, the Solana token it announces (a mint or a DEX Screener pair link) is resolved with live market data and stored.
 * Posts that are only a result ("X3 🚀") or a reply to an older post never count as a new entry.
 */
const BASE58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
const SEEN_WINDOW_MS = 48 * 3_600_000;
const MAX_ADDRESSES = 3;
const REENTRY = /r[eé]-?entr|re-?entry|اعادة\s*دخول|إعادة\s*دخول/i;

export const TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;

/** Candidate Solana addresses (token mint or pair) in a post: links first, then raw text. */
export function extractAddresses(text, hrefs = []) {
  const seen = new Set();
  for (const source of [...hrefs, text]) for (const match of String(source).match(BASE58) ?? []) if (isValidSolanaAddress(match) && /\d/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match)) seen.add(match);
  return [...seen].slice(0, MAX_ADDRESSES);
}

/** Stop-loss / take-profit hints written by the caller ("SL 700K", "TP: 2.5M"): kept as text, never interpreted as an order. */
export function extractLevels(text) {
  const level = label => text.match(new RegExp(`\\b${label}\\d?\\s*[:=@-]?\\s*(\\$?\\d[\\d.,]*\\s?[kKmM]?)`, "i"))?.[1]?.trim() ?? null;
  return { sl: level("SL"), tp: level("TP") };
}

/** "100K" / "2.5M" / "$1,200,000" → dollars (a market-cap level). Plain small numbers are ambiguous (price or cap) and give null. */
export function parseLevel(text) {
  const match = String(text ?? "").replace(/,/g, "").match(/^\$?\s*(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!match) return null;
  const value = Number(match[1]) * (/k/i.test(match[2] ?? "") ? 1e3 : /m/i.test(match[2] ?? "") ? 1e6 : 1);
  return value >= 1000 ? value : null;
}

/** Links hidden behind words ("text_link") and plain urls of a Telegram message. */
export function linksOf(text, entities = []) {
  const hrefs = [];
  for (const entity of entities) {
    if (entity?.type === "text_link" && entity.url) hrefs.push(entity.url);
    else if (entity?.type === "url") hrefs.push(String(text).slice(entity.offset, entity.offset + entity.length));
  }
  return hrefs;
}

/** What a post is: a fresh "call", a "reentry" of an older coin, or an "update" (reply / result such as "X3") that must not trigger an entry. */
export function classifyPost({ text = "", isReply = false }) {
  const bare = String(text).replace(/https?:\/\/\S+/g, "").replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, "").trim();
  if (isReply) return "update";
  if (REENTRY.test(text)) return "reentry";
  if (bare.length <= 40 && /(^|\s)x\s?\d{1,3}(\.\d+)?(\s|$)/i.test(bare)) return "update";
  return "call";
}

export function createChannelCalls({ store, token, fetchImpl = fetch, now = () => Date.now() }) {
  const enabled = typeof token === "string" && TOKEN_PATTERN.test(token.trim());
  const secret = enabled ? token.trim() : null;
  const chats = new Map();
  const state = { username: null, lastPollAt: null, lastError: null };

  async function api(method, params) {
    const response = await fetchImpl(`https://api.telegram.org/bot${secret}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params ?? {}), signal: AbortSignal.timeout(10_000) });
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) throw new Error(payload?.description ?? `Telegram HTTP ${response.status}`);
    return payload.result;
  }

  const noteChat = (chat, extra = {}) => {
    const entry = chats.get(chat.id) ?? { id: chat.id, title: chat.title ?? chat.username ?? String(chat.id), username: chat.username ?? null, posts: 0, calls: 0, lastAt: null, status: null };
    chats.set(chat.id, Object.assign(entry, extra));
    return entry;
  };

  async function resolve(address) {
    try { return (await searchSolanaTokens(address, { fetchImpl, now: now() }))[0] ?? null; } catch { return null; }
  }

  async function handlePost(post) {
    const text = String(post.text ?? post.caption ?? "");
    const chat = noteChat(post.chat);
    chat.posts++; chat.lastAt = (post.date ?? 0) * 1000 || now();
    const addresses = extractAddresses(text, linksOf(text, post.entities ?? post.caption_entities));
    if (!addresses.length) return [];
    const kind = classifyPost({ text, isReply: Boolean(post.reply_to_message) });
    let token = null;
    for (const address of addresses) { token = await resolve(address); if (token) break; }
    if (!token) return [];
    const at = (post.date ?? 0) * 1000 || now();
    const seenBefore = store.channelSeen(token.address, at - SEEN_WINDOW_MS);
    const finalKind = kind === "update" ? "update" : kind === "reentry" ? "reentry" : seenBefore ? "repeat" : "call";
    const levels = extractLevels(text);
    const inserted = store.channelInsert({
      chatId: String(post.chat.id), chatTitle: chat.title, chatUsername: chat.username, messageId: post.message_id, at, address: token.address, symbol: token.symbol, name: token.name,
      kind: finalKind, price: token.price, marketCap: token.marketCap ?? null, liquidity: token.liquidity ?? null, text: text.slice(0, 400),
      slMcap: parseLevel(levels.sl), tpMcap: parseLevel(levels.tp)
    });
    if (inserted && finalKind !== "update") chat.calls++;
    return inserted ? [{ address: token.address, kind: finalKind }] : [];
  }

  /** Reads the channel posts the bot received since the stored offset. Never throws: the error is kept in the status. */
  async function poll() {
    if (!enabled) return { handled: 0 };
    try {
      state.username ??= (await api("getMe")).username ?? null;
      const offset = Number(store.kvGet("channel_offset") ?? 0);
      const updates = await api("getUpdates", { offset, timeout: 0, limit: 50, allowed_updates: ["channel_post", "my_chat_member"] });
      let next = offset, handled = 0;
      for (const update of updates) {
        next = Math.max(next, update.update_id + 1);
        if (update.my_chat_member?.chat?.type === "channel") noteChat(update.my_chat_member.chat, { status: update.my_chat_member.new_chat_member?.status ?? null });
        if (update.channel_post?.chat?.type === "channel") handled += (await handlePost(update.channel_post)).length;
      }
      if (next !== offset) store.kvSet("channel_offset", String(next));
      state.lastPollAt = now(); state.lastError = null;
      return { handled };
    } catch (error) {
      state.lastError = String(error.message).replace(/bot\d+:[\w-]+/g, "bot***").slice(0, 160);
      return { handled: 0 };
    }
  }

  const status = () => ({ enabled, bot: state.username, lastPollAt: state.lastPollAt, lastError: state.lastError, chats: [...chats.values()].map(({ id, title, username, posts, calls, lastAt, status: role }) => ({ id: String(id), title, username, posts, calls, lastAt, role })) });
  return { enabled, poll, status, handlePost, recent: (sinceMs, limit = 40) => store.channelRecent(sinceMs, limit) };
}
