import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";
import { TOKEN_PATTERN, connectBot, decryptToken, encryptToken, privateMessages, pullMessages } from "../src/telegram-bot.mjs";

const SECRET = "x".repeat(40);
const TOKEN = "123456789:AAH_abcdefghijklmnopqrstuvwxyz012345";
const MINT = "8nPoBHiBM6pybxMws9PA2JRb9BjkppBfqcZGmot4DMBC";
const NOW = 1_800_000_000_000;

function setup() {
  const store = openStore(":memory:");
  store.createUser({ id: "u1", email: "a@x.co", passwordHash: "x", now: NOW });
  store.createUser({ id: "u2", email: "b@x.co", passwordHash: "x", now: NOW });
  return store;
}

test("bot tokens are stored encrypted and only the right secret opens them", () => {
  const blob = encryptToken(TOKEN, SECRET);
  assert.ok(!blob.includes(TOKEN));
  assert.equal(decryptToken(blob, SECRET), TOKEN);
  assert.notEqual(encryptToken(TOKEN, SECRET), blob, "random IV");
  assert.throws(() => decryptToken(blob, "y".repeat(40)));
  assert.ok(TOKEN_PATTERN.test(TOKEN));
  assert.ok(!TOKEN_PATTERN.test("not a token"));
});

test("connecting validates the token with Telegram and switches the bot to polling", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url).split("/").pop());
    if (String(url).endsWith("/getMe")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "my_pulse_bot" } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
  };
  assert.deepEqual(await connectBot(TOKEN, { fetchImpl }), { username: "my_pulse_bot" });
  assert.deepEqual(calls, ["getMe", "deleteWebhook"]);
  await assert.rejects(connectBot("nope", { fetchImpl }), /invalide/);
  const refusing = async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) });
  await assert.rejects(connectBot(TOKEN, { fetchImpl: refusing }), error => error.status === 400 && /refusé/.test(error.message));
});

test("pulling keeps group and channel texts only, advances the offset and never mixes users", async () => {
  const store = setup();
  store.saveTelegramBot({ userId: "u1", tokenEnc: encryptToken(TOKEN, SECRET), username: "b", now: NOW });
  const updates = [
    { update_id: 10, message: { message_id: 1, date: NOW / 1000, chat: { id: -100, type: "supergroup", title: "VIP Calls" }, text: `Team Human ${MINT} SL 700K` } },
    { update_id: 11, message: { message_id: 2, date: NOW / 1000, chat: { id: 5, type: "private" }, text: `private chat ${MINT}` } },
    { update_id: 12, channel_post: { message_id: 3, date: NOW / 1000, chat: { id: -200, type: "channel", title: "Alpha" }, caption: "gm no token here" } },
    { update_id: 13, message: { message_id: 4, date: NOW / 1000, chat: { id: -100, type: "supergroup", title: "VIP Calls" } } }
  ];
  let requested;
  const fetchImpl = async (url, options) => { requested = JSON.parse(options.body); return { ok: true, status: 200, json: async () => ({ ok: true, result: updates }) }; };
  const status = await pullMessages({ store, userId: "u1", secret: SECRET, fetchImpl, now: NOW });
  assert.deepEqual([status.connected, requested.offset, requested.allowed_updates], [true, 0, ["message", "channel_post"]]);
  assert.equal(store.telegramBot("u1").update_offset, 14);
  const messages = privateMessages(store, "u1", { now: NOW });
  assert.equal(messages.length, 1, "private chats and token-less messages are not calls");
  assert.deepEqual([messages[0].channel, messages[0].addresses, messages[0].sl], ["VIP Calls", [MINT], "700K"]);
  assert.deepEqual(privateMessages(store, "u2", { now: NOW }), []);
  assert.deepEqual(await pullMessages({ store, userId: "u2", secret: SECRET, fetchImpl }), { connected: false });
  await assert.rejects(pullMessages({ store, userId: "u1", secret: "z".repeat(40), fetchImpl }), /illisible/);
});

test("disconnecting deletes the token and every stored message; old messages are pruned", async () => {
  const store = setup();
  store.saveTelegramBot({ userId: "u1", tokenEnc: "x", username: "b", now: NOW });
  store.addTelegramMessage({ userId: "u1", chatId: 1, messageId: 1, title: "G", at: NOW, text: `t ${MINT}` });
  store.addTelegramMessage({ userId: "u1", chatId: 1, messageId: 2, title: "G", at: NOW - 10 * 86_400_000, text: "old" });
  assert.equal(store.addTelegramMessage({ userId: "u1", chatId: 1, messageId: 1, title: "G", at: NOW, text: "dup" }), false);
  assert.equal(store.pruneTelegramMessages(NOW - 3 * 86_400_000), 1);
  store.deleteTelegramBot("u1");
  assert.equal(store.telegramBot("u1"), null);
  assert.deepEqual(store.telegramMessages("u1", 0), []);
});
