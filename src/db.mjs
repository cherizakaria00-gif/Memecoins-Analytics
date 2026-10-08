import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER,
    terms_accepted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    status TEXT NOT NULL DEFAULT 'none',
    current_period_end INTEGER,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subscriptions_customer ON subscriptions(stripe_customer_id);
  CREATE TABLE IF NOT EXISTS user_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    customer_id TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    paid_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS payments_customer ON payments(customer_id);
  CREATE TABLE IF NOT EXISTS crypto_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset TEXT NOT NULL,
    network TEXT NOT NULL,
    address TEXT NOT NULL,
    amount TEXT NOT NULL,
    amount_usd_cents INTEGER NOT NULL,
    reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    tx_hash TEXT,
    note TEXT,
    days INTEGER,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    submitted_at INTEGER,
    decided_at INTEGER,
    decided_by TEXT
  );
  CREATE TABLE IF NOT EXISTS platform_fees (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, side TEXT NOT NULL, mint TEXT NOT NULL,
    bps INTEGER NOT NULL, fee_lamports INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'prepared', signature TEXT UNIQUE,
    created_at INTEGER NOT NULL, settled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS fees_status ON platform_fees(status, settled_at);
  DROP TABLE IF EXISTS telegram_messages;
  DROP TABLE IF EXISTS telegram_bots;
  DROP TABLE IF EXISTS platform_settings;
  CREATE TABLE IF NOT EXISTS telegram_links (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, chat_id TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS ai_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, taken_at INTEGER NOT NULL, source TEXT NOT NULL, features TEXT NOT NULL,
    entry_price REAL NOT NULL, max_price REAL NOT NULL, min_price REAL NOT NULL, last_seen INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', resolved_at INTEGER, return_pct REAL
  );
  CREATE INDEX IF NOT EXISTS ai_samples_status ON ai_samples(status, taken_at);
  CREATE TABLE IF NOT EXISTS ai_model (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, trained_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS channel_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, chat_title TEXT, chat_username TEXT, message_id INTEGER NOT NULL, at INTEGER NOT NULL,
    address TEXT NOT NULL, symbol TEXT, name TEXT, kind TEXT NOT NULL, price REAL, market_cap REAL, liquidity REAL, text TEXT,
    UNIQUE (chat_id, message_id, address)
  );
  CREATE INDEX IF NOT EXISTS channel_calls_at ON channel_calls(at);
  CREATE INDEX IF NOT EXISTS channel_calls_address ON channel_calls(address, at);
  CREATE INDEX IF NOT EXISTS crypto_user ON crypto_requests(user_id);
  CREATE INDEX IF NOT EXISTS crypto_status ON crypto_requests(status);
  CREATE TABLE IF NOT EXISTS processed_events (
    id TEXT PRIMARY KEY,
    processed_at INTEGER NOT NULL
  );
`;

/** SQLite store for accounts, sessions, subscriptions and per-user synced state. Use ":memory:" in tests. */
export function openStore(file = "data/pulse.db") {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  for (const column of ["sl_mcap", "tp_mcap"]) if (!db.prepare("PRAGMA table_info(channel_calls)").all().some(item => item.name === column)) db.exec(`ALTER TABLE channel_calls ADD COLUMN ${column} REAL`);
  if (!db.prepare("PRAGMA table_info(subscriptions)").all().some(column => column.name === "provider")) db.exec("ALTER TABLE subscriptions ADD COLUMN provider TEXT");

  const statements = {
    insertUser: db.prepare("INSERT INTO users (id, email, password_hash, created_at, terms_accepted_at) VALUES (?, ?, ?, ?, ?)"),
    userByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    userById: db.prepare("SELECT * FROM users WHERE id = ?"),
    touchLogin: db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)"),
    sessionUser: db.prepare("SELECT users.*, sessions.expires_at AS session_expires_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
    deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
    subscription: db.prepare("SELECT * FROM subscriptions WHERE user_id = ?"),
    userIdByCustomer: db.prepare("SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?"),
    upsertSubscription: db.prepare(`INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, cancel_at_period_end, updated_at, provider)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = COALESCE(excluded.stripe_customer_id, stripe_customer_id),
        stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, stripe_subscription_id), status = excluded.status,
        current_period_end = COALESCE(excluded.current_period_end, current_period_end), cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at,
        provider = COALESCE(excluded.provider, provider)`),
    state: db.prepare("SELECT data, updated_at FROM user_state WHERE user_id = ?"),
    insertCrypto: db.prepare("INSERT INTO crypto_requests (id, user_id, asset, network, address, amount, amount_usd_cents, reference, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)"),
    cryptoById: db.prepare("SELECT crypto_requests.*, users.email FROM crypto_requests JOIN users ON users.id = crypto_requests.user_id WHERE crypto_requests.id = ?"),
    cryptoOpenFor: db.prepare("SELECT * FROM crypto_requests WHERE user_id = ? AND asset = ? AND network = ? AND status = 'open' AND expires_at > ? ORDER BY created_at DESC LIMIT 1"),
    cryptoByUser: db.prepare("SELECT * FROM crypto_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"),
    cryptoAll: db.prepare("SELECT crypto_requests.*, users.email FROM crypto_requests JOIN users ON users.id = crypto_requests.user_id ORDER BY CASE crypto_requests.status WHEN 'submitted' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, crypto_requests.created_at DESC LIMIT 300"),
    cryptoSubmit: db.prepare("UPDATE crypto_requests SET status = 'submitted', tx_hash = ?, submitted_at = ? WHERE id = ? AND status IN ('open', 'submitted')"),
    cryptoDecide: db.prepare("UPDATE crypto_requests SET status = ?, note = ?, days = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status IN ('open', 'submitted')"),
    cryptoPending: db.prepare("SELECT COUNT(*) AS count FROM crypto_requests WHERE status = 'submitted'"),
    cryptoCountSince: db.prepare("SELECT COUNT(*) AS count FROM crypto_requests WHERE user_id = ? AND created_at > ?"),
    cryptoHashUsed: db.prepare("SELECT id FROM crypto_requests WHERE tx_hash = ? AND id != ? AND status IN ('submitted', 'approved') LIMIT 1"),
    insertFee: db.prepare("INSERT INTO platform_fees (id, user_id, side, mint, bps, fee_lamports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    settleFee: db.prepare("UPDATE platform_fees SET status = ?, signature = ?, settled_at = ? WHERE id = ? AND user_id = ? AND status = 'prepared'"),
    feeTotals: db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(fee_lamports), 0) AS lamports FROM platform_fees WHERE status = 'confirmed' AND settled_at >= ?"),
    recentFees: db.prepare("SELECT platform_fees.*, users.email FROM platform_fees JOIN users ON users.id = platform_fees.user_id WHERE status = 'confirmed' ORDER BY settled_at DESC LIMIT ?"),
    tgLink: db.prepare("SELECT * FROM telegram_links WHERE user_id = ?"),
    tgSaveLink: db.prepare("INSERT INTO telegram_links (user_id, chat_id, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id"),
    tgDeleteLink: db.prepare("DELETE FROM telegram_links WHERE user_id = ?"),
    aiAdd: db.prepare("INSERT INTO ai_samples (mint, taken_at, source, features, entry_price, max_price, min_price, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    aiOpen: db.prepare("SELECT id, mint, taken_at, entry_price, max_price, min_price, last_seen FROM ai_samples WHERE status = 'open'"),
    aiTouch: db.prepare("UPDATE ai_samples SET max_price = ?, min_price = ?, last_seen = ? WHERE id = ?"),
    aiResolve: db.prepare("UPDATE ai_samples SET status = ?, resolved_at = ?, return_pct = ?, max_price = ?, min_price = ? WHERE id = ?"),
    aiLabeled: db.prepare("SELECT taken_at, features, status FROM ai_samples WHERE status IN ('win', 'loss') ORDER BY taken_at DESC LIMIT ?"),
    aiCounts: db.prepare("SELECT status, COUNT(*) AS count FROM ai_samples GROUP BY status"),
    aiPrune: db.prepare("DELETE FROM ai_samples WHERE status != 'open' AND id NOT IN (SELECT id FROM ai_samples WHERE status != 'open' ORDER BY taken_at DESC LIMIT ?)"),
    aiSaveModel: db.prepare("INSERT INTO ai_model (id, json, trained_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, trained_at = excluded.trained_at"),
    aiLoadModel: db.prepare("SELECT json, trained_at FROM ai_model WHERE id = 1"),
    kvGet: db.prepare("SELECT value FROM kv WHERE key = ?"),
    kvSet: db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    channelInsert: db.prepare("INSERT OR IGNORE INTO channel_calls (chat_id, chat_title, chat_username, message_id, at, address, symbol, name, kind, price, market_cap, liquidity, text, sl_mcap, tp_mcap) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    channelRecent: db.prepare("SELECT * FROM channel_calls WHERE at >= ? AND kind != 'update' ORDER BY at DESC, id DESC LIMIT ?"),
    channelSeen: db.prepare("SELECT 1 AS seen FROM channel_calls WHERE address = ? AND at >= ? AND kind != 'update' LIMIT 1"),
    upsertState: db.prepare("INSERT INTO user_state (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at"),
    insertEvent: db.prepare("INSERT OR IGNORE INTO processed_events (id, processed_at) VALUES (?, ?)"),
    insertPayment: db.prepare("INSERT OR IGNORE INTO payments (id, customer_id, amount_cents, currency, paid_at) VALUES (?, ?, ?, ?, ?)"),
    payments: db.prepare("SELECT * FROM payments ORDER BY paid_at DESC"),
    adminUsers: db.prepare(`SELECT users.id, users.email, users.created_at, users.last_login_at,
        subscriptions.status AS sub_status, subscriptions.current_period_end, subscriptions.cancel_at_period_end, subscriptions.stripe_customer_id, subscriptions.provider,
        user_state.data AS state_data, user_state.updated_at AS state_updated_at
      FROM users LEFT JOIN subscriptions ON subscriptions.user_id = users.id LEFT JOIN user_state ON user_state.user_id = users.id
      ORDER BY users.created_at DESC LIMIT 2000`)
  };

  return {
    close: () => db.close(),
    createUser: ({ id, email, passwordHash, now, termsAcceptedAt = now }) => { statements.insertUser.run(id, email, passwordHash, now, termsAcceptedAt); return id; },
    userByEmail: email => statements.userByEmail.get(email) ?? null,
    userById: id => statements.userById.get(id) ?? null,
    touchLogin: (id, now) => { statements.touchLogin.run(now, id); },
    createSession: ({ tokenHash, userId, now, expiresAt, userAgent = null }) => { statements.insertSession.run(tokenHash, userId, now, expiresAt, userAgent); },
    userBySession: tokenHash => statements.sessionUser.get(tokenHash) ?? null,
    deleteSession: tokenHash => { statements.deleteSession.run(tokenHash); },
    deleteUserSessions: userId => { statements.deleteUserSessions.run(userId); },
    deleteExpiredSessions: now => { statements.deleteExpiredSessions.run(now); },
    subscription: userId => statements.subscription.get(userId) ?? null,
    userIdByCustomer: customerId => statements.userIdByCustomer.get(customerId)?.user_id ?? null,
    telegramLink: userId => statements.tgLink.get(userId) ?? null,
    saveTelegramLink: ({ userId, chatId, now }) => { statements.tgSaveLink.run(userId, chatId, now); },
    deleteTelegramLink: userId => { statements.tgDeleteLink.run(userId); },
    aiAdd: ({ mint, takenAt, source, features, price }) => { statements.aiAdd.run(mint, takenAt, source, features, price, price, price, takenAt); },
    aiOpen: () => statements.aiOpen.all(),
    aiTouch: (id, max, min, at) => { statements.aiTouch.run(max, min, at, id); },
    aiResolve: (id, status, at, returnPct, max, min) => { statements.aiResolve.run(status, at, returnPct, max, min, id); },
    aiLabeled: limit => statements.aiLabeled.all(limit),
    aiCounts: () => { const counts = { open: 0, win: 0, loss: 0, lost: 0 }; for (const row of statements.aiCounts.all()) counts[row.status] = row.count; return counts; },
    aiPrune: keep => { statements.aiPrune.run(keep); },
    aiSaveModel: (json, trainedAt) => { statements.aiSaveModel.run(json, trainedAt); },
    aiLoadModel: () => statements.aiLoadModel.get() ?? null,
    kvGet: key => statements.kvGet.get(key)?.value ?? null,
    kvSet: (key, value) => { statements.kvSet.run(key, String(value)); },
    channelInsert: row => statements.channelInsert.run(row.chatId, row.chatTitle ?? null, row.chatUsername ?? null, row.messageId, row.at, row.address, row.symbol ?? null, row.name ?? null, row.kind, row.price ?? null, row.marketCap ?? null, row.liquidity ?? null, row.text ?? null, row.slMcap ?? null, row.tpMcap ?? null).changes > 0,
    channelRecent: (since, limit) => statements.channelRecent.all(since, limit),
    channelSeen: (address, since) => Boolean(statements.channelSeen.get(address, since)),
    saveSubscription: ({ userId, customerId = null, subscriptionId = null, status, currentPeriodEnd = null, cancelAtPeriodEnd = false, now, provider = null }) => {
      statements.upsertSubscription.run(userId, customerId, subscriptionId, status, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, now, provider);
    },
    createCryptoRequest: request => { statements.insertCrypto.run(request.id, request.userId, request.asset, request.network, request.address, request.amount, request.amountUsdCents, request.reference, request.now, request.expiresAt); return request.id; },
    cryptoRequest: id => statements.cryptoById.get(id) ?? null,
    openCryptoRequest: (userId, asset, network, now) => statements.cryptoOpenFor.get(userId, asset, network, now) ?? null,
    userCryptoRequests: (userId, limit = 5) => statements.cryptoByUser.all(userId, limit),
    allCryptoRequests: () => statements.cryptoAll.all(),
    submitCryptoRequest: (id, txHash, now) => statements.cryptoSubmit.run(txHash, now, id).changes > 0,
    decideCryptoRequest: ({ id, status, note = null, days = null, decidedBy, now }) => statements.cryptoDecide.run(status, note, days, now, decidedBy, id).changes > 0,
    pendingCryptoCount: () => statements.cryptoPending.get().count,
    cryptoRequestsSince: (userId, since) => statements.cryptoCountSince.get(userId, since).count,
    cryptoHashInUse: (txHash, exceptId) => Boolean(statements.cryptoHashUsed.get(txHash, exceptId)),
    recordPreparedFee: ({ id, userId, side, mint, bps, feeLamports, now }) => statements.insertFee.run(id, userId, side, mint, bps, Math.max(0, Math.round(feeLamports)), now),
    /** Marks a prepared fee as confirmed or failed once, for the user who prepared it. */
    settleFee: ({ id, userId, status, signature = null, now }) => statements.settleFee.run(status, signature, now, id, userId).changes > 0,
    feeTotals: (since = 0) => ({ ...statements.feeTotals.get(since) }),
    recentFees: (limit = 30) => statements.recentFees.all(limit),
    /** Disconnecting also erases every stored message of that user. */
    state: userId => statements.state.get(userId) ?? null,
    saveState: (userId, data, now) => { statements.upsertState.run(userId, data, now); },
    /** True the first time an event id is seen, false for replays. */
    /** True when the payment was new (invoice ids are unique, so webhooks and backfills never double count). */
    savePayment: ({ id, customerId = null, amountCents, currency = "usd", paidAt }) => statements.insertPayment.run(id, customerId, amountCents, currency, paidAt).changes > 0,
    payments: () => statements.payments.all(),
    adminUsers: () => statements.adminUsers.all(),
    markEventProcessed: (id, now) => statements.insertEvent.run(id, now).changes > 0
  };
}
