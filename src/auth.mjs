import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
export const SESSION_COOKIE = "pulse_session";
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export const normalizeEmail = email => String(email ?? "").trim().toLowerCase();
export const isValidEmail = email => email.length <= 254 && EMAIL.test(email);

/** At least 10 characters with a letter and a digit; the 128-character cap keeps hashing cheap. */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 10) return "Le mot de passe doit contenir au moins 10 caractères.";
  if (password.length > 128) return "Le mot de passe est trop long (128 caractères maximum).";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "Le mot de passe doit contenir au moins une lettre et un chiffre.";
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltText, keyText] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, "base64");
  const actual = await scryptAsync(String(password ?? ""), Buffer.from(saltText, "base64"), expected.length, SCRYPT_PARAMS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Verified against when the email is unknown, so unknown and wrong-password logins take the same time.
const DUMMY_HASH = await hashPassword("not-a-real-password-1");

export const hashToken = token => createHash("sha256").update(token).digest("hex");
export const newSessionToken = () => randomBytes(32).toString("base64url");

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? "; Secure" : ""}`;
}

export const clearedSessionCookie = ({ secure = false } = {}) => sessionCookie("", { secure, maxAgeMs: 0 });

export class AuthError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Accounts and sessions on top of the store. Errors carry a French message safe to show to the user. */
export function createAuth({ store, now = () => Date.now() }) {
  async function startSession(userId, userAgent) {
    const token = newSessionToken();
    const at = now();
    store.createSession({ tokenHash: hashToken(token), userId, now: at, expiresAt: at + SESSION_TTL_MS, userAgent: String(userAgent ?? "").slice(0, 200) });
    return token;
  }

  return {
    async signup({ email, password, acceptedTerms, userAgent }) {
      const address = normalizeEmail(email);
      if (!isValidEmail(address)) throw new AuthError("Adresse email invalide.");
      const problem = passwordProblem(password);
      if (problem) throw new AuthError(problem);
      if (acceptedTerms !== true) throw new AuthError("Tu dois accepter les conditions d'utilisation et l'avertissement sur les risques.");
      if (store.userByEmail(address)) throw new AuthError("Un compte existe déjà avec cet email.", 409);
      const id = randomUUID();
      store.createUser({ id, email: address, passwordHash: await hashPassword(password), now: now() });
      return { user: store.userById(id), token: await startSession(id, userAgent) };
    },

    async login({ email, password, userAgent }) {
      const user = store.userByEmail(normalizeEmail(email));
      const valid = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !valid) throw new AuthError("Email ou mot de passe incorrect.", 401);
      store.touchLogin(user.id, now());
      return { user, token: await startSession(user.id, userAgent) };
    },

    logout(token) { if (token) store.deleteSession(hashToken(token)); },

    /** The signed-in user for a Cookie header, or null (unknown, expired or malformed session). */
    authenticate(cookieHeader) {
      const token = parseCookies(cookieHeader)[SESSION_COOKIE];
      if (!token) return null;
      const user = store.userBySession(hashToken(token));
      if (!user) return null;
      if (user.session_expires_at < now()) { store.deleteSession(hashToken(token)); return null; }
      return user;
    }
  };
}

/** Sliding-window limiter keyed by a string (login attempts per IP + email, for example). */
export function createLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    /** Records an attempt; returns true when the key is over its limit. */
    hit(key) {
      const at = now();
      const recent = (hits.get(key) ?? []).filter(time => at - time < windowMs);
      recent.push(at);
      hits.set(key, recent);
      if (hits.size > 5000) for (const stale of [...hits.keys()].slice(0, 1000)) hits.delete(stale);
      return recent.length > limit;
    }
  };
}
