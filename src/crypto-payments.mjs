import { randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { planFor } from "./billing.mjs";

export const NETWORKS = {
  solana: { label: "Solana", explorerTx: "https://solscan.io/tx/", family: "solana" },
  ethereum: { label: "Ethereum (ERC-20)", explorerTx: "https://etherscan.io/tx/", family: "evm", chainId: 1 },
  polygon: { label: "Polygon", explorerTx: "https://polygonscan.com/tx/", family: "evm", chainId: 137 },
  bsc: { label: "BNB Chain (BEP-20)", explorerTx: "https://bscscan.com/tx/", family: "evm", chainId: 56 }
};

/** Token contracts / mints (checked on-chain: symbols and decimals). Native SOL has no contract. */
export const ASSETS = {
  SOL: { label: "SOL", solana: { native: true, decimals: 9 } },
  USDT: {
    label: "USDT",
    solana: { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", decimals: 6 },
    ethereum: { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    polygon: { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
    bsc: { contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 }
  },
  USDC: {
    label: "USDC",
    solana: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
    ethereum: { contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    polygon: { contract: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
    bsc: { contract: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 }
  }
};

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const TX_HASH = { solana: /^[1-9A-HJ-NP-Za-km-z]{64,90}$/, evm: /^0x[a-fA-F0-9]{64}$/ };
export const REQUEST_TTL_MS = { SOL: 30 * 60_000, stable: 60 * 60_000 };
export const MAX_REQUESTS_PER_DAY = 6;
export const ACCESS_DAYS = 30;
const DAY_MS = 86_400_000;

export class CryptoPaymentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Receiving addresses come from the environment only: PAY_ADDRESS_SOLANA, PAY_ADDRESS_EVM (shared by the three EVM chains) or one per chain. */
export function paymentAddresses(env = process.env) {
  const pick = (value, pattern) => (typeof value === "string" && pattern.test(value.trim()) ? value.trim() : null);
  const evm = pick(env.PAY_ADDRESS_EVM, EVM_ADDRESS);
  return {
    solana: pick(env.PAY_ADDRESS_SOLANA, SOLANA_ADDRESS),
    ethereum: pick(env.PAY_ADDRESS_ETHEREUM, EVM_ADDRESS) ?? evm,
    polygon: pick(env.PAY_ADDRESS_POLYGON, EVM_ADDRESS) ?? evm,
    bsc: pick(env.PAY_ADDRESS_BSC, EVM_ADDRESS) ?? evm
  };
}

/** Every (asset, network) pair the admin can actually receive. */
export function availableMethods(addresses) {
  const methods = [];
  for (const [asset, definition] of Object.entries(ASSETS)) {
    for (const [network, info] of Object.entries(NETWORKS)) {
      if (definition[network] && addresses[network]) methods.push({ asset, network, assetLabel: definition.label, networkLabel: info.label });
    }
  }
  return methods;
}

export const validateTxHash = (network, hash) => {
  const family = NETWORKS[network]?.family;
  const value = String(hash ?? "").trim();
  return family && TX_HASH[family].test(value) ? (family === "evm" ? value.toLowerCase() : value) : null;
};

const scale = (decimal, decimals) => {
  const [whole, fraction = ""] = String(decimal).split(".");
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0").slice(0, decimals) || "0")).toString();
};

/** Amount to pay in the chosen asset: the plan price for stablecoins, the price converted at the current SOL rate for SOL. */
export function quoteAmount({ asset, network, solUsd, interval = "month" }) {
  const info = ASSETS[asset]?.[network];
  if (!info) throw new CryptoPaymentError("Méthode de paiement indisponible.");
  const plan = planFor(interval);
  const usd = plan.priceCents / 100;
  if (asset === "SOL") {
    if (!(solUsd > 0)) throw new CryptoPaymentError("Cours du SOL indisponible, réessaie dans un instant.", 503);
    const sol = (Math.ceil((usd / solUsd) * 10_000) / 10_000).toFixed(4);
    return { amount: sol, raw: scale(sol, info.decimals), usdCents: plan.priceCents };
  }
  const amount = usd.toFixed(2);
  return { amount, raw: scale(amount, info.decimals), usdCents: plan.priceCents };
}

/** Text encoded in the QR code: Solana Pay for Solana, EIP-681 for the EVM chains. */
export function qrPayload({ asset, network, address, amount, raw, reference }) {
  const info = ASSETS[asset][network];
  if (NETWORKS[network].family === "solana") {
    const params = new URLSearchParams({ amount, label: "Pulse", message: "Abonnement Pulse Pro", memo: reference });
    if (info.mint) params.set("spl-token", info.mint);
    return `solana:${address}?${params}`;
  }
  const chain = NETWORKS[network].chainId === 1 ? "" : `@${NETWORKS[network].chainId}`;
  return `ethereum:${info.contract}${chain}/transfer?address=${address}&uint256=${raw}`;
}

export const qrSvg = payload => QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 240, color: { dark: "#101315", light: "#f4f6f0" } });

const newReference = () => `PULSE-${randomBytes(4).toString("hex").toUpperCase()}`;

/** Manual crypto subscriptions: the customer pays to the admin's address and submits the transaction; the admin approves. */
export function createCryptoPayments({ store, addresses, getSolUsd, now = () => Date.now() }) {
  const view = request => {
    const info = ASSETS[request.asset]?.[request.network];
    const network = NETWORKS[request.network];
    const raw = scale(request.amount, info?.decimals ?? 0);
    return {
      id: request.id, status: request.status, interval: request.amount_usd_cents >= planFor("year").priceCents ? "year" : "month", asset: request.asset, network: request.network, networkLabel: network?.label ?? request.network,
      address: request.address, amount: request.amount, amountUsd: request.amount_usd_cents / 100, reference: request.reference,
      contract: info?.mint ?? info?.contract ?? null, txHash: request.tx_hash ?? null, explorer: request.tx_hash ? `${network?.explorerTx}${request.tx_hash}` : null,
      createdAt: request.created_at, expiresAt: request.expires_at, submittedAt: request.submitted_at ?? null, decidedAt: request.decided_at ?? null, note: request.note ?? null,
      qrPayload: qrPayload({ asset: request.asset, network: request.network, address: request.address, amount: request.amount, raw, reference: request.reference })
    };
  };

  return {
    methods: () => availableMethods(addresses),
    view,
    qr: qrSvg,

    async createRequest(user, { asset, network, interval = "month" }) {
      if (!availableMethods(addresses).some(method => method.asset === asset && method.network === network)) throw new CryptoPaymentError("Cette méthode de paiement n'est pas disponible.");
      const subscription = store.subscription(user.id);
      if (subscription?.provider !== "crypto" && ["active", "trialing"].includes(subscription?.status)) throw new CryptoPaymentError("Tu as déjà un abonnement actif.", 409);
      const at = now();
      const existing = store.openCryptoRequest(user.id, asset, network, at);
      if (existing && existing.amount_usd_cents === planFor(interval).priceCents) return view(existing);
      if (store.cryptoRequestsSince(user.id, at - DAY_MS) >= MAX_REQUESTS_PER_DAY) throw new CryptoPaymentError("Trop de demandes de paiement aujourd'hui. Réessaie demain ou contacte le support.", 429);
      const quote = quoteAmount({ asset, network, solUsd: asset === "SOL" ? await getSolUsd() : 0, interval });
      const id = randomUUID();
      store.createCryptoRequest({ id, userId: user.id, asset, network, address: addresses[network], amount: quote.amount, amountUsdCents: quote.usdCents, reference: newReference(), now: at, expiresAt: at + (asset === "SOL" ? REQUEST_TTL_MS.SOL : REQUEST_TTL_MS.stable) });
      return view(store.cryptoRequest(id));
    },

    mine: user => store.userCryptoRequests(user.id, 5).map(view),

    request(user, id) {
      const request = store.cryptoRequest(id);
      if (!request || request.user_id !== user.id) throw new CryptoPaymentError("Demande introuvable.", 404);
      return request;
    },

    submit(user, id, txHash) {
      const request = this.request(user, id);
      if (!["open", "submitted"].includes(request.status)) throw new CryptoPaymentError("Cette demande est déjà traitée.", 409);
      const hash = validateTxHash(request.network, txHash);
      if (!hash) throw new CryptoPaymentError(`Hash de transaction invalide pour ${NETWORKS[request.network].label}.`);
      if (store.cryptoHashInUse(hash, request.id)) throw new CryptoPaymentError("Cette transaction a déjà été soumise.", 409);
      store.submitCryptoRequest(request.id, hash, now());
      return view(store.cryptoRequest(request.id));
    },

    adminList: () => store.allCryptoRequests().map(row => ({ ...view(row), email: row.email, userId: row.user_id, days: row.days ?? null })),

    /** Grants access: extends from the end of a still-valid crypto period, otherwise from now. Also books the payment as revenue. */
    approve(request, { days = request.amount_usd_cents >= planFor("year").priceCents ? planFor("year").days : ACCESS_DAYS, note = null, adminEmail }) {
      if (!["open", "submitted"].includes(request.status)) throw new CryptoPaymentError("Cette demande est déjà traitée.", 409);
      const subscription = store.subscription(request.user_id);
      if (subscription?.provider !== "crypto" && ["active", "trialing"].includes(subscription?.status)) throw new CryptoPaymentError("Ce client a déjà un abonnement Stripe actif.", 409);
      const grantDays = Math.min(Math.max(Math.round(Number(days) || ACCESS_DAYS), 1), 366);
      const at = now();
      const start = subscription?.provider === "crypto" && subscription.status === "active" && subscription.current_period_end > at ? subscription.current_period_end : at;
      store.saveSubscription({ userId: request.user_id, status: "active", currentPeriodEnd: start + grantDays * DAY_MS, cancelAtPeriodEnd: false, provider: "crypto", now: at });
      store.decideCryptoRequest({ id: request.id, status: "approved", note, days: grantDays, decidedBy: adminEmail, now: at });
      store.savePayment({ id: `crypto_${request.id}`, customerId: `crypto:${request.user_id}`, amountCents: request.amount_usd_cents, currency: "usd", paidAt: at });
      return view(store.cryptoRequest(request.id));
    },

    reject(request, { note = null, adminEmail }) {
      if (!["open", "submitted"].includes(request.status)) throw new CryptoPaymentError("Cette demande est déjà traitée.", 409);
      store.decideCryptoRequest({ id: request.id, status: "rejected", note, decidedBy: adminEmail, now: now() });
      return view(store.cryptoRequest(request.id));
    }
  };
}
