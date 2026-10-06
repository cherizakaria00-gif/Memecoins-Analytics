import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { extractAddresses, extractLevels } from "./telegram-calls.mjs";

/**
 * Private groups: the user creates their OWN Telegram bot (@BotFather), adds it to the groups they follow and pastes the bot token in Pulse.
 * The token only controls that bot (never the user's Telegram account), is stored encrypted and is used to read the messages the bot receives.
 */
export const TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;
const RETENTION_MS = 3 * 86_400_000;
const MAX_MESSAGE = 600;

const keyFrom = secret => createHash("sha256").update(`pulse-telegram:${secret}`).digest();

export function encryptToken(token, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

export function decryptToken(blob, secret) {
  const raw = Buffer.from(blob, "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

async function call(token, method, params, fetchImpl) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params ?? {}), signal: AbortSignal.timeout(10_000) });
  const payload = await response.json().catch(() => null);
  if (!payload?.ok) throw Object.assign(new Error(payload?.description ?? `Telegram HTTP ${response.status}`), { status: response.status === 401 ? 400 : 502 });
  return payload.result;
}

/** Checks the token, switches the bot to polling mode and returns its username. */
export async function connectBot(token, { fetchImpl = fetch } = {}) {
  if (!TOKEN_PATTERN.test(token)) throw Object.assign(new Error("Token de bot invalide : copie-le tel que @BotFather l'affiche."), { status: 400 });
  let me;
  try { me = await call(token, "getMe", {}, fetchImpl); } catch { throw Object.assign(new Error("Token refusé par Telegram : vérifie-le dans @BotFather."), { status: 400 }); }
  await call(token, "deleteWebhook", { drop_pending_updates: false }, fetchImpl);
  return { username: me.username ?? null };
}

/** Fetches the updates the bot received since the stored offset and keeps the text of group / channel messages. */
export async function pullMessages({ store, userId, secret, fetchImpl = fetch, now = Date.now() }) {
  const row = store.telegramBot(userId);
  if (!row) return { connected: false };
  let token;
  try { token = decryptToken(row.token_enc, secret); } catch { throw Object.assign(new Error("Token illisible : reconnecte ton bot."), { status: 400 }); }
  const updates = await call(token, "getUpdates", { offset: row.update_offset, timeout: 0, limit: 100, allowed_updates: ["message", "channel_post"] }, fetchImpl);
  let offset = row.update_offset;
  for (const update of updates) {
    offset = Math.max(offset, update.update_id + 1);
    const message = update.message ?? update.channel_post;
    const text = message?.text ?? message?.caption;
    if (!text || !message.chat || message.chat.type === "private") continue; // only groups / channels, never private chats with the bot
    store.addTelegramMessage({ userId, chatId: message.chat.id, messageId: message.message_id, title: String(message.chat.title ?? message.chat.username ?? "Groupe").slice(0, 60), at: (message.date ?? Math.floor(now / 1000)) * 1000, text: text.slice(0, MAX_MESSAGE) });
  }
  if (offset !== row.update_offset) store.setTelegramOffset(userId, offset);
  store.pruneTelegramMessages(now - RETENTION_MS);
  return { connected: true, username: row.bot_username };
}

/** Stored messages that announce a token (address found), newest first. */
export function privateMessages(store, userId, { now = Date.now(), maxAgeMs = 86_400_000 } = {}) {
  return store.telegramMessages(userId, now - maxAgeMs).map(row => ({
    channel: row.chat_title, post: `private:${row.chat_id}/${row.message_id}`, at: row.at, text: row.text, addresses: extractAddresses(row.text), ...extractLevels(row.text)
  })).filter(message => message.addresses.length);
}
