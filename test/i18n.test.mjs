import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.localStorage = { getItem: () => "en" };
globalThis.document = { documentElement: {}, addEventListener() {}, body: null };
const { translate } = await import("../dist/i18n.js");
const { default: dictionary } = await import("../dist/i18n-en.js");

test("fixed strings, dynamic strings and lists are translated", () => {
  assert.equal(translate("Mot de passe"), "Password");
  assert.equal(translate("  Se déconnecter "), "  Log out ");
  assert.equal(translate("il y a 5 min"), "5 min ago");
  assert.equal(translate("Qualifié · note A (82/100)"), "Qualified · grade A (82/100)");
  assert.equal(translate("Liquidité profonde · Acheteurs majoritaires sur 1 h · Achats frais sur 5 min"), "Deep liquidity · Majority of buyers over 1h · Fresh buys over 5 min");
  assert.equal(translate("3 positions ouvertes"), "3 open positions");
  assert.equal(translate("1 position ouverte"), "1 open position");
  assert.equal(translate("Achat exécuté."), "Buy executed.");
});

test("prices and percentages are written the English way", () => {
  assert.equal(translate("20 $"), "$20");
  assert.equal(translate("+248 $"), "+$248");
  assert.equal(translate("10 k$"), "$10K");
  assert.equal(translate("+12 %"), "+12%");
  assert.equal(translate("Total encaissé"), "Total collected");
});

test("short patterns do not swallow whole sentences and unknown text is left alone", () => {
  assert.equal(translate("Une phrase inconnue qui finit par 5 min"), "Une phrase inconnue qui finit par 5 min");
  assert.equal(translate("BONK"), "BONK");
  assert.equal(translate(""), "");
});

test("every dictionary entry is English-ready: placeholders line up and nothing is empty", () => {
  for (const [french, english] of Object.entries(dictionary)) {
    assert.ok(english.trim(), `empty translation for ${french}`);
    const captures = french.split("§").length - 1;
    for (const [, index] of english.matchAll(/§(\d)/g)) assert.ok(Number(index) <= captures, `§${index} has no capture in "${french}"`);
    const sequential = (english.match(/§(?!\d)/g) ?? []).length;
    assert.ok(sequential <= captures, `too many § in "${english}"`);
  }
});

test("the UI files use the shared locale instead of a hard-coded one", () => {
  for (const file of ["app.js", "admin.js", "gate.js", "equity-chart.js"]) assert.doesNotMatch(readFileSync(new URL(`../dist/${file}`, import.meta.url), "utf8"), /"fr-FR"/, file);
});

test("plural suffix patterns accept an empty suffix", () => {
  assert.equal(translate("0 ouverte"), "0 open");
  assert.equal(translate("2 ouvertes"), "2 open");
});
