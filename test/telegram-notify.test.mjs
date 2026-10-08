import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../src/db.mjs";
import { createTelegramNotifier } from "../src/telegram-notify.mjs";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_0123456789abcdef";

function setup(updates = []) {
  const store = openStore(":memory:");
  store.createUser({ id: "u1", email: "a@x.co", passwordHash: "x", now: 1 });
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split("/").pop();
    const params = JSON.parse(init.body);
    calls.push({ method, params });
    const result = method === "getMe" ? { username: "pulse_bot" } : method === "getUpdates" ? updates.splice(0) : {};
    return { json: async () => ({ ok: true, result }) };
  };
  return { store, calls, notifier: createTelegramNotifier({ store, token: TOKEN, fetchImpl }) };
}
const start = (id, code) => ({ update_id: id, message: { chat: { id: 555, type: "private" }, text: `/start ${code}` } });

test("a disabled notifier (no valid token) never sends", async () => {
  const notifier = createTelegramNotifier({ store: openStore(":memory:"), token: "nope" });
  assert.equal(notifier.enabled, false);
  assert.equal(await notifier.send("u1", "hi"), false);
  await assert.rejects(() => notifier.startLink("u1"), /bot n'est pas configuré/);
});

test("linking: the one-time code binds the chat to the user, then alerts are delivered", async () => {
  const updates = [];
  const { store, calls, notifier } = setup(updates);
  const { code, bot } = await notifier.startLink("u1");
  assert.equal(bot, "pulse_bot");
  assert.equal((await notifier.status("u1")).linked, false);
  updates.push(start(1, "WRONG123"), start(2, code));
  assert.equal((await notifier.status("u1")).linked, true);
  assert.equal(store.telegramLink("u1").chat_id, "555");
  assert.equal(await notifier.send("u1", "▲ $A1 passe en positif"), true);
  assert.deepEqual(calls.at(-1).params.chat_id, "555");
  assert.match(calls.at(-1).params.text, /passe en positif/);
  notifier.unlink("u1");
  assert.equal(await notifier.send("u1", "x"), false);
});

test("codes expire, are single use and group chats are ignored", async () => {
  let time = 1_000;
  const store = openStore(":memory:");
  store.createUser({ id: "u1", email: "a@x.co", passwordHash: "x", now: 1 });
  const updates = [];
  const fetchImpl = async (url, init) => ({ json: async () => ({ ok: true, result: url.endsWith("getUpdates") ? updates.splice(0) : { username: "b" } }) });
  const notifier = createTelegramNotifier({ store, token: TOKEN, fetchImpl, now: () => time });
  const { code } = await notifier.startLink("u1");
  updates.push({ update_id: 1, message: { chat: { id: 9, type: "group" }, text: `/start ${code}` } });
  assert.equal((await notifier.status("u1")).linked, false);
  time += 11 * 60_000;
  updates.push(start(2, code));
  assert.equal((await notifier.status("u1")).linked, false);
});

test("alerts are rate limited per user", async () => {
  const updates = [];
  const { notifier } = setup(updates);
  const { code } = await notifier.startLink("u1");
  updates.push(start(1, code));
  await notifier.status("u1");
  let delivered = 0;
  for (let index = 0; index < 50; index++) if (await notifier.send("u1", `n${index}`)) delivered++;
  assert.equal(delivered, 40);
});
