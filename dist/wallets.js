/** Solana wallets Pulse knows about: how to find their injected provider and where to install them. */
export const WALLET_CATALOG = [
  { id: "phantom", icon: "./wallets/phantom.svg", name: "Phantom", color: "#7958d7", install: "https://phantom.com/download", match: /phantom/i,
    detect: win => [win.phantom?.solana, win.solana, ...(Array.isArray(win.solana?.providers) ? win.solana.providers : [])].find(provider => provider?.isPhantom && provider?.connect) ?? null },
  { id: "solflare", icon: "./wallets/solflare.svg", name: "Solflare", color: "#fc8c1c", install: "https://solflare.com/download", match: /solflare/i,
    detect: win => [win.solflare, win.solana].find(provider => provider?.isSolflare && provider?.connect) ?? null },
  { id: "backpack", icon: "./wallets/backpack.png", name: "Backpack", color: "#e33e3f", install: "https://backpack.app/download", match: /backpack/i,
    detect: win => [win.backpack, win.xnft?.solana].find(provider => provider?.isBackpack && provider?.connect) ?? null },
  { id: "coinbase", icon: "./wallets/coinbase.svg", name: "Coinbase Wallet", color: "#0052ff", install: "https://www.coinbase.com/wallet/downloads", match: /coinbase/i,
    detect: win => (win.coinbaseSolana?.connect ? win.coinbaseSolana : null) },
  { id: "okx", icon: "./wallets/okx.svg", name: "OKX Wallet", color: "#2b2f33", install: "https://www.okx.com/web3", match: /okx/i,
    detect: win => (win.okxwallet?.solana?.connect ? win.okxwallet.solana : null) },
  { id: "trust", icon: "./wallets/trust.svg", name: "Trust Wallet", color: "#3375bb", install: "https://trustwallet.com/download", match: /trust/i,
    detect: win => (win.trustwallet?.solana?.connect ? win.trustwallet.solana : null) },
  { id: "exodus", icon: "./wallets/exodus.svg", name: "Exodus", color: "#8b5cf6", install: "https://www.exodus.com/download/", match: /exodus/i,
    detect: win => (win.exodus?.solana?.connect ? win.exodus.solana : null) },
  { id: "glow", icon: "./wallets/glow.png", name: "Glow", color: "#f0a63a", install: "https://glow.app/download", match: /glow/i,
    detect: win => (win.glow?.solana?.connect ? win.glow.solana : null) },
  { id: "brave", icon: "./wallets/brave.svg", name: "Brave Wallet", color: "#fb542b", install: "https://brave.com/wallet/", match: /brave/i,
    detect: win => [win.braveSolana, win.solana].find(provider => provider?.isBraveWallet && provider?.connect) ?? null }
];

const MAX_WALLETS = 10;

/** Wallet Standard wallets ship their logo as an inline image data URI; anything else is ignored. */
export const safeStandardIcon = icon => (typeof icon === "string" && /^data:image\/(svg\+xml|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(icon) && icon.length < 60_000 ? icon : null);

/** Local logo for a wallet name (e.g. the name a WalletConnect wallet reports). */
export const iconForName = name => WALLET_CATALOG.find(entry => entry.match.test(String(name ?? "")))?.icon ?? null;

/**
 * Finds every usable wallet in the page. Known wallets are matched through their injected object, then through
 * Wallet Standard; unknown Wallet Standard wallets and an unrecognised window.solana are listed as well.
 * `standardAdapter(wallet)` turns a Wallet Standard wallet into the injected-provider shape (connect/disconnect/on).
 */
export function detectWallets(win, standardWallets = [], standardAdapter = wallet => wallet) {
  const detected = [];
  const notInstalled = [];
  const usedStandard = new Set();

  for (const entry of WALLET_CATALOG) {
    const injected = entry.detect(win);
    const standard = [...standardWallets].find(wallet => entry.match.test(String(wallet?.name)));
    if (standard) usedStandard.add(standard);
    if (injected) detected.push({ id: entry.id, name: entry.name, color: entry.color, icon: entry.icon, provider: injected, standardWallet: standard ?? null, source: "injected" });
    else if (standard) detected.push({ id: entry.id, name: entry.name, color: entry.color, icon: entry.icon, provider: standardAdapter(standard), standardWallet: standard, source: "standard" });
    else notInstalled.push({ id: entry.id, name: entry.name, color: entry.color, icon: entry.icon, install: entry.install });
  }

  for (const wallet of standardWallets) {
    if (usedStandard.has(wallet)) continue;
    const name = String(wallet?.name ?? "Wallet Solana");
    detected.push({ id: `std:${name.toLowerCase()}`, name, color: "#4b5563", icon: safeStandardIcon(wallet?.icon), provider: standardAdapter(wallet), standardWallet: wallet, source: "standard" });
  }

  const known = detected.some(item => item.source === "injected" && item.provider === win.solana);
  if (win.solana?.connect && !known && !win.solana.isPhantom && !win.solana.isSolflare && !win.solana.isBraveWallet) {
    detected.push({ id: "window.solana", name: "Wallet Solana", color: "#4b5563", provider: win.solana, source: "injected" });
  }
  return { detected, notInstalled };
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const toAddress = publicKey => {
  const address = typeof publicKey === "string" ? publicKey : publicKey?.toString?.();
  return ADDRESS.test(address ?? "") ? address : null;
};

/** Pure wallet-list helpers (one entry per wallet id; reconnecting a wallet replaces its entry). */
export function upsertWallet(wallets, wallet) {
  const rest = wallets.filter(item => item.id !== wallet.id);
  return [...rest, wallet].slice(-MAX_WALLETS);
}
export const removeWallet = (wallets, id) => wallets.filter(item => item.id !== id);
export const totalSol = wallets => wallets.reduce((sum, wallet) => sum + (Number.isFinite(wallet.balance) ? wallet.balance : 0), 0);
export const shortAddress = address => (address ? `${address.slice(0, 4)}…${address.slice(-4)}` : "");
