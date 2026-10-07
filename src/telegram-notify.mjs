import { randomBytes } from "node:crypto";

/**
 * Alerts to the user's own Telegram: Pulse has ONE bot (token in the environment). The user links their chat by sending the
 * bot a one-time code; afterwards the app can push their notifications to that chat. Nothing is ever read from groups or channels.
 */
export const TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/;
const CODE_TTL_MS = 10 * 60_000;
const MAX_PER_HOUR = 40;
const MAX_TEXT = 500;

export function createTelegramNotifier({ store, token, fetchImpl = fetch, now = () => Date.now() }) {
  const enabled = typeof token === "string" && TOKEN_PATTERN.test(token.trim());
  const secret = enabled ? token.trim() : null;
  const codes = new Map(); // code -> { userId, expires }
  const sent = new Map(); // userId -> timestamps
  let offset = 0;
  let username = null;

  async function api(method, params) {
    const response = await fetchImpl(`https://api.telegram.org/bot${secret}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params ?? {}), signal: AbortSignal.timeout(10_000) });
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) throw Object.assign(new Error(payload?.description ?? `Telegram HTTP ${response.status}`), { status: 502 });
    return payload.result;
  }

  async function botUsername() {
    if (!enabled) return null;
    if (!username) { try { username = (await api("getMe")).username ?? null; } catch { /* retried on the next call */ } }
    return username;
  }

  /** Reads the messages sent to the bot and binds each valid "/start CODE" to its user. */
  async function pull() {
    if (!enabled) return;
    const updates = await api("getUpdates", { offset, timeout: 0, limit: 100, allowed_updates: ["message"] });
    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (message?.chat?.type !== "private" || typeof message.text !== "string") continue;
      const code = message.text.trim().match(/^\/start\s+([A-Z0-9]{6,12})$/i)?.[1]?.toUpperCase();
      const entry = code && codes.get(code);
      if (!entry || entry.expires < now()) {
        if (code) await api("sendMessage", { chat_id: message.chat.id, text: "Code expiré ou invalide. Génère un nouveau code dans Pulse." }).catch(() => {});
        continue;
      }
      codes.delete(code);
      store.saveTelegramLink({ userId: entry.userId, chatId: String(message.chat.id), now: now() });
      await api("sendMessage", { chat_id: message.chat.id, text: "✅ Telegram lié à Pulse. Tu recevras ici tes alertes (position en positif, ordres, signaux). Pour arrêter, désactive-le dans Pulse." }).catch(() => {});
    }
  }

  return {
    enabled,
    async status(userId) {
      if (!enabled) return { enabled: false, linked: false };
      if (!store.telegramLink(userId)) await pull().catch(() => {});
      return { enabled: true, linked: Boolean(store.telegramLink(userId)), bot: await botUsername() };
    },
    async startLink(userId) {
      if (!enabled) throw Object.assign(new Error("Alertes Telegram indisponibles : le bot n'est pas configuré sur ce serveur."), { status: 503 });
      for (const [code, entry] of codes) if (entry.userId === userId || entry.expires < now()) codes.delete(code);
      const code = randomBytes(5).toString("hex").toUpperCase();
      codes.set(code, { userId, expires: now() + CODE_TTL_MS });
      return { code, bot: await botUsername(), expiresInMin: CODE_TTL_MS / 60_000 };
    },
    unlink: userId => store.deleteTelegramLink(userId),
    /** Sends a plain-text alert to the user's linked chat. Returns false when not linked or rate limited. */
    async send(userId, text) {
      if (!enabled) return false;
      const link = store.telegramLink(userId);
      if (!link) return false;
      const at = now();
      const recent = (sent.get(userId) ?? []).filter(time => at - time < 3_600_000);
      if (recent.length >= MAX_PER_HOUR) return false;
      recent.push(at); sent.set(userId, recent);
      try { await api("sendMessage", { chat_id: link.chat_id, text: String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, MAX_TEXT), disable_web_page_preview: true }); return true; }
      catch (error) {
        if (/blocked|chat not found|deactivated/i.test(error.message)) store.deleteTelegramLink(userId);
        return false;
      }
    }
  };
}
