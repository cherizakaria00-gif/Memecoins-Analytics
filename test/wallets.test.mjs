import test from "node:test";
import assert from "node:assert/strict";
import { detectWallets, removeWallet, shortAddress, toAddress, totalSol, upsertWallet } from "../dist/wallets.js";

const provider = extra => ({ connect: async () => ({}), ...extra });
const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

test("detects several injected wallets at once", () => {
  const win = { phantom: { solana: provider({ isPhantom: true }) }, solflare: provider({ isSolflare: true }), backpack: provider({ isBackpack: true }), coinbaseSolana: provider() };
  const { detected, notInstalled } = detectWallets(win);
  assert.deepEqual(detected.map(wallet => wallet.id), ["phantom", "solflare", "backpack", "coinbase"]);
  assert.ok(notInstalled.some(wallet => wallet.id === "okx" && wallet.install.startsWith("https://")));
  assert.equal(detected.some(wallet => wallet.id === "brave"), false);
});

test("finds Phantom behind window.solana providers when Brave Wallet owns the main object", () => {
  const phantom = provider({ isPhantom: true });
  const win = { solana: { isBraveWallet: true, connect: async () => ({}), providers: [phantom] } };
  const { detected } = detectWallets(win);
  assert.deepEqual(detected.map(wallet => wallet.id).sort(), ["brave", "phantom"]);
  assert.equal(detected.find(wallet => wallet.id === "phantom").provider, phantom);
});

test("uses Wallet Standard for known and unknown wallets", () => {
  const standard = [{ name: "Phantom" }, { name: "Nightly" }];
  const { detected } = detectWallets({}, standard, wallet => ({ adapterFor: wallet.name }));
  assert.deepEqual(detected.map(wallet => [wallet.id, wallet.source]), [["phantom", "standard"], ["std:nightly", "standard"]]);
  assert.equal(detected[1].provider.adapterFor, "Nightly");
});

test("lists an unrecognised window.solana as a generic wallet", () => {
  const { detected } = detectWallets({ solana: provider() });
  assert.deepEqual(detected.map(wallet => wallet.id), ["window.solana"]);
  assert.deepEqual(detectWallets({}).detected, []);
});

test("manages the connected wallet list and totals", () => {
  let wallets = upsertWallet([], { id: "phantom", address: ADDRESS, balance: 1.5 });
  wallets = upsertWallet(wallets, { id: "solflare", address: "A".repeat(44), balance: 0.5 });
  wallets = upsertWallet(wallets, { id: "phantom", address: ADDRESS, balance: 2 });
  assert.equal(wallets.length, 2);
  assert.equal(totalSol(wallets), 2.5);
  assert.equal(totalSol(upsertWallet([], { id: "x", balance: null })), 0);
  assert.deepEqual(removeWallet(wallets, "phantom").map(wallet => wallet.id), ["solflare"]);
  assert.equal(toAddress(ADDRESS), ADDRESS);
  assert.equal(toAddress("nope"), null);
  assert.equal(toAddress({ toString: () => ADDRESS }), ADDRESS);
  assert.equal(shortAddress(ADDRESS), "9WzD…AWWM");
});

import { iconForName, safeStandardIcon } from "../dist/wallets.js";

test("catalog wallets carry a local icon, standard icons are validated", () => {
  const { detected, notInstalled } = detectWallets({ phantom: { solana: provider({ isPhantom: true }) } });
  assert.equal(detected[0].icon, "./wallets/phantom.svg");
  assert.ok(notInstalled.every(wallet => wallet.icon?.startsWith("./wallets/")));
  assert.equal(iconForName("Phantom Wallet"), "./wallets/phantom.svg");
  assert.equal(iconForName("Unknown"), null);
  assert.equal(safeStandardIcon("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=");
  assert.equal(safeStandardIcon("https://evil.example/x.png"), null);
  assert.equal(safeStandardIcon("data:text/html;base64,AAAA"), null);
  const unknown = detectWallets({}, [{ name: "Nightly", icon: "data:image/png;base64,iVBORw0KGgo=" }]);
  assert.equal(unknown.detected[0].icon, "data:image/png;base64,iVBORw0KGgo=");
});
