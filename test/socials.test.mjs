import assert from "node:assert/strict";
import test from "node:test";
import { buildSocials } from "../src/socials.mjs";

test("merges DEX Screener, pump.fun and Jupiter links without duplicates", () => {
  const socials = buildSocials(
    { socials: [{ type: "twitter", url: "https://x.com/coin" }, { type: "telegram", url: "https://t.me/coin_chat" }], websites: [{ url: "https://coin.xyz" }] },
    { twitter: "https://twitter.com/other", website: "https://other.xyz", telegram: "", discord: "https://discord.gg/abc" }
  );
  assert.deepEqual(socials, { website: "https://coin.xyz/", twitter: "https://x.com/coin", telegram: "https://t.me/coin_chat", discord: "https://discord.gg/abc", count: 4 });
});

test("a token without any link has count 0", () => {
  assert.deepEqual(buildSocials(undefined, null, { socials: [], websites: [] }), { website: null, twitter: null, telegram: null, discord: null, count: 0 });
});

test("unsafe or misplaced links are rejected", () => {
  const socials = buildSocials({
    socials: [{ type: "twitter", url: "javascript:alert(1)" }, { type: "telegram", url: "https://evil.example/t.me" }],
    websites: [{ url: "http://insecure.example" }, { url: "https://pump.fun/coin/abc" }, { url: "https://x.com/not-a-website" }]
  }, { discord: "data:text/html,<script>", twitter: "https://notx.com/a" });
  assert.equal(socials.count, 0);
});

test("bare domains are upgraded to https", () => {
  assert.equal(buildSocials({ website: "coin.xyz/page" }).website, "https://coin.xyz/page");
});
