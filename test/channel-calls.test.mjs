import assert from "node:assert/strict";
import test from "node:test";
import { openStore } from "../src/db.mjs";
import { TOKEN_PATTERN, classifyPost, createChannelCalls, extractAddresses, extractLevels, linksOf, parseLevel } from "../src/channel-calls.mjs";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_0123456789abcdef";
const MINT = "8nPoBHiBM6pybxMws9PA2JRb9BjkppBfqcZGmot4DMBC";
const PAIR = "FB2Dw7CBcc2D1hKyf21kXKexESQFvsBNTVDjaUoGMRws";
const OTHER_PAIR = "Hpjzjed5Zi6qodv4NgswZYycNe3bxtda3UFU2ZU5AuxY";
const OTHER_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const AT = 1_790_000_000;

const pairFor = (mint, pair, symbol) => ({ chainId: "solana", pairAddress: pair, baseToken: { address: mint, name: symbol, symbol }, quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" }, priceUsd: "0.001", priceNative: "0.00001", liquidity: { usd: 80_000 }, fdv: 1_000_000, marketCap: 1_000_000, volume: { h24: 500_000, h1: 20_000, h6: 100_000, m5: 1000 }, priceChange: { h1: 3, h24: 20 }, txns: { h24: { buys: 500, sells: 400 }, h1: { buys: 50, sells: 40 }, m5: { buys: 5, sells: 5 } }, pairCreatedAt: Date.now() - 3_600_000 });

function setup(updates) {
  const store = openStore(":memory:");
  const queue = [...updates];
  const sent = [];
  const fetchImpl = async (url, init) => {
    url = String(url);
    if (url.includes("api.telegram.org")) {
      const method = url.split("/").pop();
      const body = JSON.parse(init.body);
      sent.push({ method, body });
      const result = method === "getMe" ? { username: "MoroccoCCrypto_bot" } : queue.splice(0).filter(update => update.update_id >= (body.offset ?? 0));
      return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
    }
    if (url.includes("/latest/dex/search")) {
      const query = decodeURIComponent(url.split("q=")[1]);
      const pairs = [[MINT, PAIR, "ALPHA"], [OTHER_MINT, OTHER_PAIR, "BETA"]].filter(([mint, pair]) => query === mint || query === pair).map(([mint, pair, symbol]) => pairFor(mint, pair, symbol));
      return { ok: true, status: 200, json: async () => ({ pairs }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { store, sent, calls: createChannelCalls({ store, token: TOKEN, fetchImpl, now: () => AT * 1000 + 60_000 }) };
}
const post = (id, message_id, extra = {}) => ({ update_id: id, channel_post: { message_id, date: AT + id, chat: { id: -1001, type: "channel", title: "Morocco_Crypto", username: "morocco_crypto" }, ...extra } });

test("extraction: addresses from links and text, levels, hidden links", () => {
  assert.deepEqual(extractAddresses(`CYBER https://dexscreener.com/solana/${PAIR}`), [PAIR]);
  assert.deepEqual(extractAddresses("gm no call", [`https://dexscreener.com/solana/${PAIR}`, MINT]), [PAIR, MINT]);
  assert.deepEqual(extractAddresses("just words and 12345"), []);
  assert.deepEqual(extractLevels("SL 700K and TP: 2.5M"), { sl: "700K", tp: "2.5M" });
  const text = "voir ici et https://dexscreener.com/solana/abc";
  assert.deepEqual(linksOf(text, [{ type: "text_link", offset: 0, length: 4, url: "https://x.example/a" }, { type: "url", offset: text.indexOf("https"), length: 36 }]), ["https://x.example/a", "https://dexscreener.com/solana/abc"]);
  assert.ok(TOKEN_PATTERN.test(TOKEN));
});

test("classification: fresh call, re-entry, replies and result posts", () => {
  assert.equal(classifyPost({ text: `CYBERLEEK https://dexscreener.com/solana/${PAIR} 🚀` }), "call");
  assert.equal(classifyPost({ text: `اعادة دخول في CYBERLEEK https://dexscreener.com/solana/${PAIR}` }), "reentry");
  assert.equal(classifyPost({ text: "re-entry $BETA" }), "reentry");
  assert.equal(classifyPost({ text: `https://dexscreener.com/solana/${PAIR}\nX3 🚀🚀🚀` }), "update");
  assert.equal(classifyPost({ text: "X4" }), "update");
  assert.equal(classifyPost({ text: `new call ${PAIR}`, isReply: true }), "update");
  assert.equal(classifyPost({ text: "Alpha is going to x10 maybe, here is the full thesis with a lot of words to read before ever buying anything" }), "call");
});

test("polling stores new calls, skips results and replies, flags repeats, and advances the offset", async () => {
  const { store, sent, calls } = setup([
    post(10, 1, { text: `CYBERLEEK https://dexscreener.com/solana/${PAIR}`, entities: [{ type: "url", offset: 10, length: 70 }] }),
    post(11, 2, { text: "gm everyone, no call today" }),
    post(12, 3, { text: `https://dexscreener.com/solana/${PAIR}\nX3 🚀🚀🚀` }),
    post(13, 4, { caption: `${MINT}`, photo: [{}] }),
    post(14, 5, { text: `BETA ${OTHER_MINT}`, reply_to_message: { message_id: 1 } }),
    { update_id: 15, my_chat_member: { chat: { id: -1001, type: "channel", title: "Morocco_Crypto" }, new_chat_member: { status: "administrator" } } },
    post(16, 6, { text: `again ${MINT}` }),
    { update_id: 17, message: { chat: { id: 5, type: "private" }, text: `private ${OTHER_MINT}` } }
  ]);
  const result = await calls.poll();
  assert.equal(result.handled, 5); // 3 calls + 2 stored updates (results and replies are kept but never used as entries)
  const rows = store.channelRecent(0, 50);
  assert.deepEqual(rows.map(row => [row.message_id, row.kind, row.symbol]).sort((a, b) => a[0] - b[0]), [[1, "call", "ALPHA"], [4, "repeat", "ALPHA"], [6, "repeat", "ALPHA"]]);
  assert.equal(rows.find(row => row.message_id === 1).price, 0.001);
  assert.equal(store.kvGet("channel_offset"), "18");
  assert.equal(sent.find(item => item.method === "getUpdates").body.allowed_updates.includes("channel_post"), true);
  const status = calls.status();
  assert.equal(status.bot, "MoroccoCCrypto_bot");
  assert.equal(status.chats[0].role, "administrator");
  assert.deepEqual([status.chats[0].posts, status.chats[0].calls], [6, 3]);
  assert.equal((await calls.poll()).handled, 0);
});

test("without a valid token nothing is polled, and errors never throw", async () => {
  const off = createChannelCalls({ store: openStore(":memory:"), token: "nope" });
  assert.equal(off.enabled, false);
  assert.deepEqual(await off.poll(), { handled: 0 });
  const broken = createChannelCalls({ store: openStore(":memory:"), token: TOKEN, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, description: "Unauthorized" }) }) });
  await broken.poll();
  assert.match(broken.status().lastError, /Unauthorized/);
});

test("levels written in a post become market-cap numbers", () => {
  assert.deepEqual([parseLevel("100K"), parseLevel("2.5M"), parseLevel("$1,200,000"), parseLevel("700k"), parseLevel("0.5"), parseLevel("12"), parseLevel(null), parseLevel("abc")], [100_000, 2_500_000, 1_200_000, 700_000, null, null, null, null]);
  assert.equal(extractLevels("…\n\nSL 100K 🔴").sl, "100K");
});

test("a call stores the stop-loss and take-profit levels of its post", async () => {
  const { store, calls } = setup([post(10, 1, { text: `https://dexscreener.com/solana/${PAIR}\n\nSL 100K 🔴 TP 2M` })]);
  await calls.poll();
  const row = store.channelRecent(0, 5)[0];
  assert.deepEqual([row.sl_mcap, row.tp_mcap], [100_000, 2_000_000]);
});
