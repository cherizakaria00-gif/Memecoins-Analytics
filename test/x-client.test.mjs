import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTweets, getXSignal } from "../src/x-client.mjs";
import { findTwitterUrl } from "../src/dexscreener-client.mjs";

const tweet = (id, text, likes = 0) => ({ id, author_id: `a${id}`, text, public_metrics: { like_count: likes, retweet_count: 0, reply_count: 0 } });

test("reads positive, negative and scam chatter", () => {
  assert.equal(analyzeTweets([tweet(1, "LFG 🚀 bullish gem"), tweet(2, "going to the moon 🔥")]).label, "positive");
  assert.equal(analyzeTweets([tweet(1, "dumping hard 💀"), tweet(2, "dead, sell"), tweet(3, "rekt 📉")]).label, "negative");
  const alert = analyzeTweets([tweet(1, "this is a rug"), tweet(2, "scam, dev sold"), tweet(3, "gm")]);
  assert.equal(alert.label, "alert");
  assert.equal(alert.scamMentions, 2);
  assert.equal(analyzeTweets([]).label, "neutral");
});

test("ranks top tweets by likes and builds status urls", () => {
  const result = analyzeTweets([tweet(1, "a", 5), tweet(2, "b", 50)], new Map([["a2", "alice"]]));
  assert.equal(result.top[0].id, "2");
  assert.equal(result.top[0].url, "https://x.com/alice/status/2");
  assert.equal(result.top[1].url, "https://x.com/i/status/1");
});

test("is disabled without a bearer token and never calls the API", async () => {
  const fetchImpl = async () => { throw new Error("should not be called"); };
  assert.deepEqual(await getXSignal({ symbol: "ABC" }, { fetchImpl, bearerToken: "" }), { enabled: false });
});

test("searches recent tweets by cashtag and caches the result", async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    assert.match(decodeURIComponent(String(url)), /\$WIF/);
    return { ok: true, status: 200, json: async () => ({ data: [tweet(1, "LFG 🚀", 3)], includes: { users: [{ id: "a1", username: "bob" }] } }) };
  };
  const first = await getXSignal({ symbol: "WIF" }, { fetchImpl, bearerToken: "t", now: 1_000 });
  assert.equal(first.enabled, true);
  assert.equal(first.top[0].author, "bob");
  await getXSignal({ symbol: "WIF" }, { fetchImpl, bearerToken: "t", now: 2_000 });
  assert.equal(calls, 1);
  await assert.rejects(getXSignal({ symbol: "ZZZ" }, { fetchImpl: async () => ({ ok: false, status: 429 }), bearerToken: "t" }), /rate limit/);
});

test("only accepts https X profile links", () => {
  assert.equal(findTwitterUrl({ socials: [{ type: "twitter", url: "https://x.com/coin" }] }), "https://x.com/coin");
  assert.equal(findTwitterUrl({ socials: [{ type: "twitter", url: "http://x.com/coin" }] }), null);
  assert.equal(findTwitterUrl({ socials: [{ type: "twitter", url: "https://evil.example/x.com" }] }, "https://twitter.com/ok"), "https://twitter.com/ok");
  assert.equal(findTwitterUrl(undefined), null);
});

test("reports a payment-required plan distinctly", async () => {
  await assert.rejects(getXSignal({ symbol: "PAY" }, { fetchImpl: async () => ({ ok: false, status: 402 }), bearerToken: "t" }), { code: "payment_required" });
});
