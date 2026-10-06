import test from "node:test";
import assert from "node:assert/strict";
import { _test, extractAddresses, extractLevels, getTelegramCalls, isValidChannel, normalizeChannel, parseChannelHtml } from "../src/telegram-calls.mjs";

const MINT = "8nPoBHiBM6pybxMws9PA2JRb9BjkppBfqcZGmot4DMBC";
const PAIR = "FB2Dw7CBcc2D1hKyf21kXKexESQFvsBNTVDjaUoGMRws";
const html = `<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="calls_channel/41">
<div class="tgme_widget_message_text js-message_text" dir="auto"><a href="https://dexscreener.com/solana/${PAIR}">https://dexscreener.com/solana/${PAIR}</a><br/><code>${MINT}</code><br/><br/>SL 700K &#128308; &amp; TP 2.5M</div>
<a class="tgme_widget_message_date" href="https://t.me/calls_channel/41"><time datetime="2026-10-06T14:36:00+00:00" class="time">2:36 PM</time></a></div></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="calls_channel/42"><div class="tgme_widget_message_text js-message_text" dir="auto">gm everyone, no call today</div>
<a class="tgme_widget_message_date" href="https://t.me/calls_channel/42"><time datetime="2026-10-06T15:00:00+00:00">3:00 PM</time></a></div></div>`;

test("channel handles are normalised and validated", () => {
  assert.equal(normalizeChannel("https://t.me/s/calls_channel?before=3"), "calls_channel");
  assert.equal(normalizeChannel("@calls_channel"), "calls_channel");
  assert.ok(isValidChannel("calls_channel"));
  for (const bad of ["abc", "1abcde", "has space", "../etc", "a".repeat(40), ""]) assert.ok(!isValidChannel(bad), bad);
});

test("calls are extracted from the public preview: addresses, links, levels and time", () => {
  const messages = parseChannelHtml(html, "calls_channel");
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].addresses, [PAIR, MINT]);
  assert.deepEqual([messages[0].sl, messages[0].tp], ["700K", "2.5M"]);
  assert.equal(messages[0].at, Date.parse("2026-10-06T14:36:00+00:00"));
  assert.match(messages[0].text, /SL 700K/);
  assert.deepEqual(messages[1].addresses, []);
  assert.deepEqual(extractLevels("no levels here"), { sl: null, tp: null });
  assert.deepEqual(extractAddresses("hello world just words"), []);
});

test("calls are resolved to live tokens, channels that cannot be read are reported", async () => {
  _test.channelCache.clear(); _test.resolveCache.clear();
  const fetchImpl = async url => {
    url = String(url);
    if (url.startsWith("https://t.me/s/calls_channel")) return { ok: true, status: 200, text: async () => html };
    if (url.startsWith("https://t.me/s/")) return { ok: true, status: 200, text: async () => "<html>private</html>" };
    if (url.includes("/latest/dex/search")) {
      const query = decodeURIComponent(url.split("q=")[1]);
      if (query !== PAIR) return { ok: true, json: async () => ({ pairs: [] }) };
      return { ok: true, json: async () => ({ pairs: [{ chainId: "solana", pairAddress: PAIR, baseToken: { address: MINT, name: "Team Human", symbol: "HUMAN" }, quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" }, priceUsd: "0.001248", priceNative: "0.00001", liquidity: { usd: 142000 }, fdv: 1_200_000, marketCap: 1_200_000, volume: { h24: 21_900_000, h1: 500000, h6: 2000000, m5: 1000 }, priceChange: { h1: -15.4, h24: 2402 }, txns: { h24: { buys: 92177, sells: 80132 }, h1: { buys: 100, sells: 100 }, m5: { buys: 5, sells: 5 } }, pairCreatedAt: Date.now() - 17 * 3_600_000 }] }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  const result = await getTelegramCalls(["calls_channel", "private_one", "not valid!"], { fetchImpl, now: Date.now() });
  assert.deepEqual(result.channels, ["calls_channel", "private_one"]);
  assert.match(result.errors.private_one, /privé/);
  assert.equal(result.calls.length, 1);
  assert.deepEqual([result.calls[0].token.symbol, result.calls[0].token.address, result.calls[0].sl, result.calls[0].url], ["HUMAN", MINT, "700K", "https://t.me/calls_channel/41"]);
  assert.ok(result.calls[0].token.liquidity > 100_000);
});
