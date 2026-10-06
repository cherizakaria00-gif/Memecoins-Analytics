import test from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/db.mjs";
import { AuthError, SESSION_COOKIE, SESSION_TTL_MS, createAuth, createLimiter, hashPassword, isValidEmail, parseCookies, passwordProblem, sessionCookie, verifyPassword } from "../src/auth.mjs";

const PASSWORD = "correct-horse-9";

test("validates emails and passwords", () => {
  assert.equal(isValidEmail("a@b.co"), true);
  assert.equal(isValidEmail("nope"), false);
  assert.equal(isValidEmail("a b@c.com"), false);
  assert.match(passwordProblem("short1"), /10 caractères/);
  assert.match(passwordProblem("onlyletters-here"), /lettre et un chiffre/);
  assert.match(passwordProblem("1234567890123"), /lettre et un chiffre/);
  assert.equal(passwordProblem(PASSWORD), null);
});

test("hashes passwords with a random salt and verifies them", async () => {
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword("wrong-password-1", first), false);
  assert.equal(await verifyPassword(PASSWORD, "garbage"), false);
});

test("builds a hardened session cookie and parses cookie headers", () => {
  const cookie = sessionCookie("abc", { secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(sessionCookie("abc"), /Secure/);
  assert.deepEqual(parseCookies(`a=1; ${SESSION_COOKIE}=tok%2Fen; b=2`), { a: "1", [SESSION_COOKIE]: "tok/en", b: "2" });
});

test("signup, login, authenticate and logout", async () => {
  const store = openStore(":memory:");
  let clock = 1_000_000;
  const auth = createAuth({ store, now: () => clock });
  const { user, token } = await auth.signup({ email: " Me@Example.COM ", password: PASSWORD, acceptedTerms: true });
  assert.equal(user.email, "me@example.com");
  assert.equal(store.userBySession(token), null, "tokens are stored hashed, never in clear");
  assert.equal(auth.authenticate(`${SESSION_COOKIE}=${token}`).id, user.id);
  assert.equal(auth.authenticate(`${SESSION_COOKIE}=forged`), null);

  await assert.rejects(auth.signup({ email: "me@example.com", password: PASSWORD, acceptedTerms: true }), error => error instanceof AuthError && error.status === 409);
  await assert.rejects(auth.signup({ email: "x@y.com", password: PASSWORD, acceptedTerms: false }), /conditions/);

  const login = await auth.login({ email: "ME@example.com", password: PASSWORD });
  assert.equal(auth.authenticate(`${SESSION_COOKIE}=${login.token}`).id, user.id);
  await assert.rejects(auth.login({ email: "me@example.com", password: "wrong-password-1" }), error => error.status === 401 && /incorrect/.test(error.message));
  await assert.rejects(auth.login({ email: "ghost@example.com", password: PASSWORD }), error => error.status === 401 && /incorrect/.test(error.message));

  auth.logout(login.token);
  assert.equal(auth.authenticate(`${SESSION_COOKIE}=${login.token}`), null);
  clock += SESSION_TTL_MS + 1;
  assert.equal(auth.authenticate(`${SESSION_COOKIE}=${token}`), null);
  store.close();
});

test("the limiter blocks after too many attempts inside the window", () => {
  let clock = 0;
  const limiter = createLimiter({ limit: 3, windowMs: 1000, now: () => clock });
  assert.deepEqual([1, 2, 3, 4].map(() => limiter.hit("k")), [false, false, false, true]);
  assert.equal(limiter.hit("other"), false);
  clock = 2000;
  assert.equal(limiter.hit("k"), false);
});
