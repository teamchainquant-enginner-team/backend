# ChainQuant Backend (Railway)

## Why this exists

The terminal used to call CoinGecko / DexScreener / DefiLlama **from the browser, per user.**
Keyless CoinGecko is ~10–30 calls/min pooled *by IP*; GeckoTerminal's public API is 30/min.
That works for one person and collapses at fifty.

This backend polls the free APIs **once, on a schedule**, writes normalized snapshots to
Supabase, and serves every user from that cache.

**Data cost becomes O(1) in users instead of O(n).** One process making ~40 calls/min serves
10 users or 10,000 identically — which is what lets ChainQuant run entirely on free API tiers
until paid plans are actually justified. It also means no API key ever reaches a browser.

## Deploy

1. **Supabase** — run `db/schema.sql` in the SQL editor (project `segccrrecdhzfwgptqsi`). Idempotent.
2. **Railway** — new project from this repo. Set env vars from `.env.example`.
3. **Two services from the same repo:**
   - API: `npm start`
   - Cron: `npm run cron`
4. **Frontend** — add before the app's `<script>`:
   ```html
   <script>window.CQ_API = 'https://your-api.up.railway.app';</script>
   ```
   Without it the terminal still runs on direct free-tier calls; anything requiring the backend
   reports itself `Unavailable` rather than faking a result.

## Free-tier posture

| Provider | Key | Powers |
|---|---|---|
| CoinGecko (keyless) | none | markets, trending, global, categories |
| GeckoTerminal | none | pool reserves, OHLCV, trending pools, **per-pool trades incl. buyer address** |
| DexScreener | none | pair data |
| DefiLlama | none | protocol/category TVL → **narrative capital flow** |
| Etherscan V2 | free key | **deployer intelligence** (one key covers ETH/Base/Arbitrum/BNB) |
| TwitterAPI.io | **not purchased** | social — renders `Unavailable`, never a fake number |
| Anthropic | optional | Ask ChainQuant; without it the frontend uses its deterministic router |

Every adapter has a free/paid switch. Buying CoinGecko Pro changes a base URL and a rate
constant — no call site changes.

## Non-negotiables enforced in code

- `scoringService.js` contains **zero `Math.random()`**. Scores are deterministic and versioned,
  or score history and "why did this change?" are both meaningless.
- Six risk inputs (holder concentration, LP concentration, deployer behaviour, contract security,
  wash-trading, social authenticity) are **listed as unmeasured and cap confidence** rather than
  being quietly estimated.
- Wallet Behaviour Forecast returns `probability: null`. A probability without a backtest is a
  fabricated accuracy claim.
- `POST /api/alerts` **rejects** anything without `confirmed: true`. The user must see the parsed
  rule before it arms.
- Deployer findings are **observations, never verdicts**. No "scam", no "rug".
- No Nansen. No Dune. No seed phrases. No private keys.
