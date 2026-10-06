import test from "node:test";
import assert from "node:assert/strict";
import { createPhantomBrowseLink, createPhantomQrSvg } from "../src/wallet-qr.mjs";

test("builds a Phantom mobile browse link for a secure public URL", () => {
  const link = createPhantomBrowseLink("https://pulse.example/app");
  assert.match(link, /^https:\/\/phantom\.app\/ul\/browse\//);
  assert.match(link, /pulse\.example/);
});

test("rejects local or insecure QR targets", () => {
  assert.throws(() => createPhantomBrowseLink("http://127.0.0.1:4173"), /HTTPS/);
  assert.throws(() => createPhantomBrowseLink("not-a-url"), /valid URL/);
});

test("generates a self-contained SVG QR code", async () => {
  const svg = await createPhantomQrSvg("https://pulse.example/");
  assert.match(svg, /^<svg/);
  assert.match(svg, /<path/);
});
