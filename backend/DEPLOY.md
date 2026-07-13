# ChainQuant v6 — Railway Deploy

Supabase is **already migrated and verified** (2026-07-13). Do not run `db/schema.sql`; it is a
record of what was applied, not a to-do. What remains is Railway + three lines in the HTML.

---

## 1. Push this folder to GitHub

```bash
cd backend
git init
git add .
git commit -m "ChainQuant v6 backend"
gh repo create chainquant-backend --private --source=. --push
```

`.env` is gitignored. Confirm no secret is committed:

```bash
git grep -nE "DDTRX|eyJ|sk-" && echo "SECRET FOUND — STOP" || echo "clean"
```

## 2. Railway — two services, one repo

```bash
npm i -g @railway/cli
railway login
railway init -n chainquant

# API
railway add --service chainquant-api
railway up --service chainquant-api
railway domain --service chainquant-api      # prints your public API URL — save it

# Cron worker (no domain — it only calls outward)
railway add --service chainquant-cron
railway up --service chainquant-cron
```

In the Railway dashboard, set the cron service's start command to `node workers/cron.js`
(the API service uses the default `node server.js` from railway.json).

## 3. Env vars — set on BOTH services

```bash
railway variables --service chainquant-api \
  --set "SUPABASE_URL=https://segccrrecdhzfwgptqsi.supabase.co" \
  --set "SUPABASE_ANON_KEY=<anon key from Supabase → Settings → API>" \
  --set "SUPABASE_SERVICE_KEY=<service_role key — NEVER put this in the frontend>" \
  --set "ETHERSCAN_API_KEY=<your etherscan key>" \
  --set "ALLOWED_ORIGINS=https://chainquant.net,https://www.chainquant.net" \
  --set "PORT=8080"
```

Repeat with `--service chainquant-cron`.

Optional, any time later — each is a pure upgrade, nothing breaks without them:
- `ANTHROPIC_API_KEY` → Ask ChainQuant switches from the keyword router to the real LLM
- `COINGECKO_API_KEY` → same adapters, higher rate limits (base-URL swap, no code change)
- `TWITTERAPI_IO_KEY` → social surfaces stop reporting Unavailable

## 4. Verify

```bash
curl https://<your-api>.up.railway.app/health
```

Required:
- `"database": true` — if false, the service key is wrong
- `"auth": "enabled (JWT verified)"` — if NOT SET, every user-owned endpoint returns 503

Then **wait 3 minutes** for the cron worker's first tick and:

```bash
curl -s https://<your-api>.up.railway.app/api/markets | head -c 200
# status should be "delayed" (served from the snapshot cache). Before the first tick it
# honestly says the snapshot has not been written yet — that is not an error.
```

## 5. Supabase auth (2 clicks)

**Authentication → Providers → Email** → enable Magic Link.
**Authentication → URL Configuration** → add `https://chainquant.net/*` to Redirect URLs,
or the sign-in link will bounce.

## 6. Frontend

In `chainquant_pro_v6.html`, top of the file:

```js
window.CQ_API = 'https://<your-api>.up.railway.app';
window.CQ_SUPABASE_ANON_KEY = '<anon key>';
```

Deploy to Vercel. Done.

---

## Expected behaviour on day one — these are NOT bugs

- **Smart Money tab shows "0 of 30 days of observed history."** The gate is working. The cron
  worker starts observing pool trades immediately; the index will not rank a wallet until it has
  watched long enough to know whether that wallet was actually right. That gate is the moat.
- **Whale feed starts empty and fills over the first hour** as trades above $100K are observed.
  It does not backfill.
- **Score history needs two ticks (~6 min)** before the sparkline appears.
- **Social panels say Unavailable.** No social API is purchased. That is the honest state.

## Rotate the Etherscan key

It was shared in a chat transcript. Free-tier and read-only, so the risk is rate-limit abuse
rather than loss of funds — but rotate it at etherscan.io once you are live, and update the
Railway variable. Nothing else needs to change.
