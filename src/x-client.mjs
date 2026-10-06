import { isValidSolanaAddress } from "./wallet-balance.mjs";

const SEARCH_URL = "https://api.twitter.com/2/tweets/search/recent";
const CACHE_TTL_MS = 5 * 60_000;
const POSITIVE = /\b(moon(ing)?|bullish|gem|lfg|send it|100x|1000x|ath|breakout|buy(ing)?|pumping|accumulat\w*|undervalued|early)\b|🚀|🔥|💎|📈/gi;
const NEGATIVE = /\b(dump(ing|ed)?|bearish|sell(ing)?|dead|exit|fake|crash(ed|ing)?|bleed\w*|rekt|down bad)\b|💀|📉/gi;
const SCAM = /\b(rug(ged|pull)?|scam|honeypot|stolen|fraud|dev sold|bundl(e|ed)|insider)\b/gi;
const cache = new Map();

const count = (text, pattern) => (text.match(pattern) ?? []).length;

/** Cheap lexicon-based read of recent tweets. Indicative only: it cannot detect sarcasm or paid shilling. */
export function analyzeTweets(tweets, users = new Map()) {
  let positive = 0;
  let negative = 0;
  let scamMentions = 0;
  let engagement = 0;
  const authors = new Set();
  for (const tweet of tweets) {
    const text = String(tweet?.text ?? "");
    positive += count(text, POSITIVE);
    negative += count(text, NEGATIVE);
    scamMentions += count(text, SCAM) > 0 ? 1 : 0;
    authors.add(tweet?.author_id);
    const metrics = tweet?.public_metrics ?? {};
    engagement += (metrics.like_count ?? 0) + 2 * (metrics.retweet_count ?? 0) + (metrics.reply_count ?? 0);
  }
  const sentiment = (positive - negative) / (positive + negative + 2);
  const label = scamMentions >= 2 && scamMentions / Math.max(tweets.length, 1) >= 0.15 ? "alert"
    : sentiment > 0.2 ? "positive" : sentiment < -0.2 ? "negative" : "neutral";
  const top = [...tweets]
    .sort((first, second) => (second.public_metrics?.like_count ?? 0) - (first.public_metrics?.like_count ?? 0))
    .slice(0, 4)
    .map(tweet => {
      const username = users.get(tweet.author_id) ?? null;
      return {
        id: String(tweet.id),
        text: String(tweet.text ?? "").slice(0, 280),
        author: username,
        likes: tweet.public_metrics?.like_count ?? 0,
        url: username ? `https://x.com/${username}/status/${tweet.id}` : `https://x.com/i/status/${tweet.id}`
      };
    });
  return { tweetCount: tweets.length, authors: authors.size, engagement, sentiment: Math.round(sentiment * 100) / 100, label, scamMentions, top };
}

function buildQuery(symbol, address) {
  const cashtag = /^[A-Za-z0-9]{2,15}$/.test(symbol ?? "") ? `$${symbol}` : null;
  const terms = [cashtag, isValidSolanaAddress(address) ? address : null].filter(Boolean);
  return terms.length ? `(${terms.join(" OR ")}) -is:retweet` : null;
}

/** Recent-search signal for a token. Returns { enabled: false } without an X API bearer token. */
export async function getXSignal({ symbol, address }, { fetchImpl = fetch, bearerToken = process.env.X_BEARER_TOKEN, now = Date.now() } = {}) {
  if (!bearerToken) return { enabled: false };
  const query = buildQuery(symbol, address);
  if (!query) return { enabled: true, tweetCount: 0, authors: 0, engagement: 0, sentiment: 0, label: "neutral", scamMentions: 0, top: [] };

  const cached = cache.get(query);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.signal;

  const params = new URLSearchParams({
    query, max_results: "50", "tweet.fields": "public_metrics,created_at,author_id", expansions: "author_id", "user.fields": "username"
  });
  const response = await fetchImpl(`${SEARCH_URL}?${params}`, {
    headers: { authorization: `Bearer ${bearerToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(8_000)
  });
  if (response.status === 401 || response.status === 403) throw new Error("X API credentials rejected or plan lacks search access");
  if (response.status === 402) throw Object.assign(new Error("X API requires a paid plan or credits for recent search (HTTP 402)"), { code: "payment_required" });
  if (response.status === 429) throw new Error("X API rate limit reached");
  if (!response.ok) throw new Error(`X API responded with HTTP ${response.status}`);

  const payload = await response.json();
  const users = new Map((payload?.includes?.users ?? []).map(user => [user.id, user.username]));
  const signal = { enabled: true, ...analyzeTweets(Array.isArray(payload?.data) ? payload.data : [], users) };
  cache.set(query, { at: now, signal });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return signal;
}
