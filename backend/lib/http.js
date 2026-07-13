/**
 * Shared fetch layer: per-provider token-bucket rate limiting + retry/backoff.
 *
 * The free tiers are the entire economic argument for this architecture, so we
 * must not get banned from them. Limits are set conservatively BELOW published
 * ceilings. Because only the cron worker calls these providers (never a user's
 * browser), one bucket per provider is enough no matter how many users are on
 * the terminal — data cost is O(1) in users, not O(n).
 */
const BUCKETS = {
  coingecko:     { perMin: 20,  tokens: 20,  last: Date.now() }, // keyless: ~10-30/min, pooled by IP
  geckoterminal: { perMin: 25,  tokens: 25,  last: Date.now() }, // public: 30/min
  dexscreener:   { perMin: 100, tokens: 100, last: Date.now() },
  defillama:     { perMin: 60,  tokens: 60,  last: Date.now() },
  etherscan:     { perMin: 250, tokens: 250, last: Date.now() }, // free key: 5/sec
};

function take(provider) {
  const b = BUCKETS[provider];
  if (!b) return true;
  const now = Date.now();
  b.tokens = Math.min(b.perMin, b.tokens + ((now - b.last) / 60000) * b.perMin);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function get(provider, url, { headers = {}, retries = 3, timeoutMs = 12000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    while (!take(provider)) await sleep(1500); // wait for a token rather than burn the quota

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', ...headers }, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; } // provider says slow down; obey
      if (!res.ok) throw new Error(`${provider} ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      if (attempt === retries) throw e;
      await sleep(600 * 2 ** attempt);
    }
  }
}
