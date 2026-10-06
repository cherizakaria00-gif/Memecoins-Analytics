import UniversalProvider from "@walletconnect/universal-provider";
import QRCode from "qrcode";
import nacl from "tweetnacl";
import bs58 from "bs58";

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** SVG string of a QR code (dark modules on the app's light panel color). */
export function qrSvgAsync(text) {
  return QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 240, color: { dark: "#101315", light: "#f4f6f0" } });
}

const accountOf = session => String(session?.namespaces?.solana?.accounts?.[0] ?? "").split(":").pop() || null;
const describe = session => ({
  address: accountOf(session),
  peerName: session?.peer?.metadata?.name ?? "Wallet mobile",
  peerIcon: session?.peer?.metadata?.icons?.[0] ?? null,
  topic: session?.topic ?? null
});

/**
 * WalletConnect (Reown) session for Solana, read-only: the user scans a QR code with any WalletConnect wallet,
 * approves the connection, then signs a short message that proves ownership of the address (no funds move).
 */
export async function createWalletConnect({ projectId, appUrl, onUri, onDisconnect }) {
  const provider = await UniversalProvider.init({
    projectId,
    metadata: { name: "Pulse", description: "Scanner de memecoins (lecture seule)", url: appUrl, icons: [] }
  });
  provider.on("display_uri", uri => onUri?.(uri));
  provider.on("session_delete", () => onDisconnect?.());
  provider.on("disconnect", () => onDisconnect?.());

  return {
    existing: () => (provider.session ? describe(provider.session) : null),
    async connect() {
      const session = await provider.connect({ namespaces: { solana: { methods: ["solana_signMessage", "solana_signAndSendTransaction", "solana_signTransaction"], chains: [SOLANA_MAINNET], events: [] } } });
      return describe(session);
    },
    /** Asks the wallet to sign a login message and verifies the ed25519 signature locally. */
    async authorize(address) {
      const nonce = crypto.getRandomValues(new Uint8Array(8)).reduce((text, byte) => text + byte.toString(16).padStart(2, "0"), "");
      const message = new TextEncoder().encode(`Pulse : confirme que tu possèdes ce wallet.\nAdresse : ${address}\nCode : ${nonce}\nCette signature ne déplace aucun fonds.`);
      const result = await provider.request({ method: "solana_signMessage", params: { message: bs58.encode(message), pubkey: address } }, SOLANA_MAINNET);
      const signature = typeof result?.signature === "string" ? bs58.decode(result.signature) : null;
      return Boolean(signature) && nacl.sign.detached.verify(message, signature, bs58.decode(address));
    },
    /** Asks the wallet to sign and send a base64 transaction; returns the signature (base58). */
    async signAndSend(transactionBase64) {
      const result = await provider.request({ method: "solana_signAndSendTransaction", params: { transaction: transactionBase64 } }, SOLANA_MAINNET);
      if (typeof result?.signature !== "string") throw new Error("Le wallet n'a pas renvoyé de signature.");
      return result.signature;
    },
    async disconnect() {
      try { await provider.disconnect(); } catch { /* already closed */ }
    }
  };
}
